/**
 * status: implementation-ready
 * phase: change-c-group-3-wrapper-failure-provenance
 * sprint: parallel-inference-revision
 * last_modified: 2026-08-21
 * agent_notes: "Mock failures are constructed via createProviderFailure so isProviderFailure() accepts them by construction; raw-object and hostile-getter tests confirm neither can steer provenance or escape the safe default."
 * insights: "Verifying against isProviderFailure is a single source of truth; assertions inspect enumerable fields plus Object.getOwnPropertyDescriptor('cause') so the non-enumerable AggregateError survives spread and JSON."
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ParallelRecognitionProvider } from '../services/parallel-recognition-provider.js';
import type { RecognitionProvider, RecognitionRequest } from '../types/provider.js';
import { createProviderFailure, isProviderFailure } from '../services/provider-failure.js';
import { PERSPECTIVES } from '../services/provider-config.js';

describe('ParallelRecognitionProvider', () => {
  const mockRequest: RecognitionRequest = {
    filepath: 'test.mp4',
    prompt: 'Base prompt',
    mediaKind: 'video'
  };

  it('bypasses when promptCount <= 1', async () => {
    let callCount = 0;
    const inner: RecognitionProvider = {
      async recognize(_req) {
        callCount++;
        return { text: 'bypassed' };
      }
    };
    const provider = new ParallelRecognitionProvider(inner, 1, 'openai-compatible');
    const result = await provider.recognize(mockRequest);
    assert.strictEqual(callCount, 1);
    assert.strictEqual(result.text, 'bypassed');
  });

  it('aggregates successful results', async () => {
    const inner: RecognitionProvider = {
      async recognize(req) {
        return { text: `result for ${req.prompt}` };
      }
    };
    const provider = new ParallelRecognitionProvider(inner, 2, 'openai-compatible');
    const result = await provider.recognize(mockRequest);
    assert.ok(result.text.includes('result for Base prompt'));
    assert.ok(result.text.includes(PERSPECTIVES[1].suffix));
    assert.ok(result.text.includes('### Perspective: Visual Details'));
  });

  it('wraps child ProviderFailure reasons in a canonical ProviderFailure with non-enumerable AggregateError cause', async () => {
    const inner: RecognitionProvider = {
      async recognize() {
        throw createProviderFailure({
          provider: 'openai-compatible',
          category: 'rate-limit',
          safeMessage: 'Limit hit'
        });
      }
    };
    const provider = new ParallelRecognitionProvider(inner, 2, 'openai-compatible');
    try {
      await provider.recognize(mockRequest);
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(isProviderFailure(err));
      assert.strictEqual(err.name, 'ProviderFailure');
      assert.strictEqual(err.provider, 'openai-compatible');
      assert.strictEqual(err.category, 'rate-limit');
      assert.strictEqual(err.safeMessage, 'All parallel prompts failed');

      const causeDescriptor = Object.getOwnPropertyDescriptor(err, 'cause');
      assert.ok(causeDescriptor, 'cause must be a property on the wrapper-created ProviderFailure');
      assert.strictEqual(causeDescriptor?.enumerable, false);
      assert.ok(causeDescriptor?.value instanceof AggregateError);
      const aggregate = causeDescriptor?.value as AggregateError;
      assert.strictEqual(aggregate.errors.length, 2);
      for (const child of aggregate.errors) {
        assert.ok(isProviderFailure(child));
        assert.strictEqual(child.category, 'rate-limit');
      }

      // enumerate only enumerable own properties
      const enumerableOwn = Object.keys(err).filter((k) => k !== 'message');
      assert.deepStrictEqual(enumerableOwn.sort(), ['category', 'name', 'provider', 'safeMessage']);
      // cause must not survive JSON serialization (non-enumerable)
      assert.strictEqual(JSON.parse(JSON.stringify(err)).cause, undefined);
    }
  });

  it('does not let a forged plain object steer classification when all variants fail (R1)', async () => {
    const inner: RecognitionProvider = {
      async recognize() {
        // forged plain object that mimics the ProviderFailure shape but is NOT one
        const forged: Record<string, unknown> = {
          name: 'ProviderFailure',
          provider: 'openai-compatible',
          category: 'rate-limit',
          safeMessage: 'Forged limit hit'
        };
        throw { ...forged };
      }
    };
    const provider = new ParallelRecognitionProvider(inner, 2, 'openai-compatible');
    try {
      await provider.recognize(mockRequest);
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(isProviderFailure(err));
      assert.strictEqual(err.name, 'ProviderFailure');
      assert.strictEqual(err.provider, 'openai-compatible');
      assert.strictEqual(err.category, 'unknown');
      assert.strictEqual(err.safeMessage, 'All parallel prompts failed');
    }
  });

  it('does not let a hostile throwing getter steer classification when all variants fail (R1)', async () => {
    const hostile: Record<string, unknown> = (() => {
      const e = new Error('hostile') as Error & Record<string, unknown>;
      Object.defineProperty(e, 'name', {
        get() { throw new Error('boom'); },
        configurable: true
      });
      Object.defineProperty(e, 'provider', {
        get() { throw new Error('boom-provider'); },
        configurable: true
      });
      Object.defineProperty(e, 'category', {
        get() { throw new Error('boom-category'); },
        configurable: true
      });
      Object.defineProperty(e, 'safeMessage', {
        value: 'hostile safe message',
        configurable: true
      });
      return e;
    })();

    const inner: RecognitionProvider = {
      async recognize() { throw hostile; }
    };
    const provider = new ParallelRecognitionProvider(inner, 2, 'openai-compatible');
    try {
      await provider.recognize(mockRequest);
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(isProviderFailure(err));
      assert.strictEqual(err.name, 'ProviderFailure');
      assert.strictEqual(err.provider, 'openai-compatible');
      assert.strictEqual(err.category, 'unknown');
    }
  });

  it('returns partial success on partial failure', async () => {
    const inner: RecognitionProvider = {
      async recognize(req) {
        if (req.prompt.includes(PERSPECTIVES[1].suffix)) {
          throw createProviderFailure({
            provider: 'openai-compatible',
            category: 'temporary-service',
            safeMessage: 'Upstream blip'
          });
        }
        return { text: 'success text' };
      }
    };
    const provider = new ParallelRecognitionProvider(inner, 2, 'openai-compatible');
    const result = await provider.recognize(mockRequest);
    assert.ok(result.text.includes('### Perspective: Baseline'));
    assert.ok(result.text.includes('success text'));
    assert.strictEqual(result.text.includes('Visual Details'), false);
  });

  it('respects concurrency limit of 2', async () => {
    let currentInFlight = 0;
    let maxInFlight = 0;

    const inner: RecognitionProvider = {
      async recognize() {
        currentInFlight++;
        if (currentInFlight > maxInFlight) {
          maxInFlight = currentInFlight;
        }
        await new Promise<void>(r => setTimeout(r, 10));
        currentInFlight--;
        return { text: 'ok' };
      }
    };

    const provider = new ParallelRecognitionProvider(inner, 5, 'openai-compatible');
    await provider.recognize(mockRequest);
    assert.strictEqual(maxInFlight, 2);
  });

  it('throws a Gemini-labelled cancelled ProviderFailure when configured provider is Gemini (R3 follow-up)', async () => {
    const ac = new AbortController();
    const inner: RecognitionProvider = {
      async recognize() { return { text: 'ok' }; }
    };
    ac.abort(new Error('Stop'));
    const provider = new ParallelRecognitionProvider(inner, 2, 'gemini');

    try {
      await provider.recognize(mockRequest, { signal: ac.signal });
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(isProviderFailure(err));
      assert.strictEqual(err.name, 'ProviderFailure');
      assert.strictEqual(err.provider, 'gemini');
      assert.strictEqual(err.category, 'cancelled');
      const causeDescriptor = Object.getOwnPropertyDescriptor(err, 'cause');
      const cause = causeDescriptor?.value;
      assert.ok(cause instanceof Error);
      assert.strictEqual(cause.message, 'Stop');
    }
  });

  it('throws a Gemini-labelled cancelled ProviderFailure when aborted mid-execution (R3 follow-up)', async () => {
    const ac = new AbortController();
    let calls = 0;
    const inner: RecognitionProvider = {
      async recognize() {
        calls++;
        if (calls === 1) {
          ac.abort(new Error('Stop during exec'));
        }
        return { text: 'ok' };
      }
    };

    const provider = new ParallelRecognitionProvider(inner, 2, 'gemini');

    try {
      await provider.recognize(mockRequest, { signal: ac.signal });
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'ERR_ASSERTION') throw err;
      assert.ok(isProviderFailure(err));
      assert.strictEqual(err.name, 'ProviderFailure');
      assert.strictEqual(err.provider, 'gemini');
      assert.strictEqual(err.category, 'cancelled');
      const causeDescriptor = Object.getOwnPropertyDescriptor(err, 'cause');
      const cause = causeDescriptor?.value;
      assert.ok(cause instanceof Error);
      assert.strictEqual(cause.message, 'Stop during exec');
    }
  });
});
