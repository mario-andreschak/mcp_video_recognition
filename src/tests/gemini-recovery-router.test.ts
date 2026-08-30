/**
 * status: active
 * phase: change-b-groups-4-5-recovery
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Fake-clock/fake-sleeper/fake-invoker matrix with fresh cooldown state per test."
 * insights: "Deterministic delays run only toward a distinct eligible Gemini candidate; cooldown skips consume no attempt and pins update only later calls."
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GEMINI_TERMINAL_MAX_BYTES,
  GEMINI_TERMINAL_TRUNCATION_MARKER,
  formatGeminiTerminalMessage,
  runPreparedGeminiRoute,
  type GeminiRouteInput,
  type StartedGeminiAttempt
} from '../services/gemini-recovery-router.js';
import { createProviderFailure } from '../services/provider-failure.js';
import type { NormalizedGeminiFailure } from '../services/gemini-error-classifier.js';
import type { ProviderFailureCategory, RecognitionResult } from '../types/provider.js';
import { createProviderModelCooldownStore } from '../services/provider-cooldown-store.js';
import type { RecoveryDiagnosticEvent } from '../services/recovery-diagnostics.js';

class FakeClock {
  nowMs = 0;
  readonly now = (): number => this.nowMs;
  advance(ms: number): void { this.nowMs += ms; }
}

const transient = (
  category: ProviderFailureCategory = 'temporary-service',
  code = 'UNAVAILABLE',
  retryAfterMs?: number
): NormalizedGeminiFailure => ({
  envelopeState: 'not-applicable',
  failure: createProviderFailure({
    provider: 'gemini', category, safeMessage: 'fixed', code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  })
});
const failFast = (category: ProviderFailureCategory, code?: string): NormalizedGeminiFailure => ({
  envelopeState: 'not-applicable',
  failure: createProviderFailure({ provider: 'gemini', category, safeMessage: 'fixed', ...(code === undefined ? {} : { code }) })
});
const unusable = (): NormalizedGeminiFailure => ({
  envelopeState: 'unusable',
  failure: createProviderFailure({ provider: 'gemini', category: 'malformed-response', safeMessage: 'fixed' })
});
const input = (overrides: Partial<GeminiRouteInput> = {}): GeminiRouteInput => ({
  mediaKind: 'image',
  candidates: ['primary', 'secondary', 'third'], pinned: false,
  maxAttempts: 4, deadlineSeconds: 30, deadlineStartedAt: 0,
  baseBackoffMs: 250, maxBackoffMs: 2000, cooldownSeconds: 60, ...overrides
});

const runtime = (
  overrides: Partial<Parameters<typeof runPreparedGeminiRoute>[1]> = {}
): Parameters<typeof runPreparedGeminiRoute>[1] => ({
  now: () => 0,
  sleep: async () => undefined,
  cooldowns: createProviderModelCooldownStore(),
  invokePreparedModel: async () => ({ text: 'ok' }),
  ...overrides
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('primary success returns unchanged text and starts no later candidate', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const outcome = await runPreparedGeminiRoute(input(), runtime({
    now: clock.now,
    invokePreparedModel: async model => { calls.push(model); return { text: ' exact\ntext ' }; }
  }));
  assert.deepEqual(outcome, { kind: 'success', result: { text: ' exact\ntext ' } });
  assert.deepEqual(calls, ['primary']);
});

test('ordered fallback invokes each unique candidate at most once and one request per attempt', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  let upstreamRequests = 0;
  const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary', 'primary', 'secondary', 'third'] }), runtime({
    now: clock.now,
    invokePreparedModel: async model => {
      calls.push(model); upstreamRequests += 1;
      if (model === 'primary') throw transient();
      return { text: 'secondary success' };
    }
  }));
  assert.deepEqual(calls, ['primary', 'secondary']);
  assert.equal(upstreamRequests, calls.length);
  assert.deepEqual(outcome, { kind: 'success', result: { text: 'secondary success' } });
});

test('all transient candidates exhaust in exact order with one attempt record each', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const outcome = await runPreparedGeminiRoute(input(), runtime({
    now: clock.now,
    invokePreparedModel: async model => { calls.push(model); throw transient(); }
  }));
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind !== 'terminal') assert.fail('expected terminal');
  assert.equal(outcome.reason, 'route-exhausted');
  assert.equal(outcome.attemptsUsed, 3);
  assert.deepEqual(outcome.attempts.map(row => [row.model, row.attempt]), [['primary', 1], ['secondary', 2], ['third', 3]]);
  assert.deepEqual(calls, ['primary', 'secondary', 'third']);
});

test('every fail-fast category returns the original failure and starts no later model', async () => {
  const categories = ['authentication', 'permission', 'billing', 'invalid-request', 'unsupported-media', 'safety', 'malformed-response', 'unknown'] as const;
  for (const category of categories) {
    const clock = new FakeClock();
    const value = failFast(category);
    let calls = 0;
    const outcome = await runPreparedGeminiRoute(input(), runtime({
      now: clock.now,
      invokePreparedModel: async () => { calls += 1; throw value; }
    }));
    assert.equal(outcome.kind, 'fail-fast');
    if (outcome.kind !== 'fail-fast') assert.fail('expected fail-fast');
    assert.equal(outcome.failure, value.failure);
    assert.equal(calls, 1);
  }
  const cancelled = failFast('cancelled', 'CALLER_CANCELLED');
  const cancelledOutcome = await runPreparedGeminiRoute(input(), runtime({ invokePreparedModel: async () => { throw cancelled; } }));
  assert.equal(cancelledOutcome.kind, 'fail-fast');
});

test('attempt cap increments only immediately before invocation and never on completion', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const outcome = await runPreparedGeminiRoute(input({ maxAttempts: 2 }), runtime({
    now: clock.now,
    invokePreparedModel: async () => { calls += 1; throw transient(); }
  }));
  assert.equal(calls, 2);
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind === 'terminal') {
    assert.equal(outcome.attemptsUsed, calls);
    assert.deepEqual(outcome.attempts.map(row => row.attempt), [1, 2]);
  }
});

test('strict deadline gate blocks equal/after and permits immediately-before starts', async () => {
  for (const nowMs of [30_000, 30_001]) {
    let calls = 0;
    const outcome = await runPreparedGeminiRoute(input(), runtime({ now: () => nowMs, invokePreparedModel: async () => { calls += 1; return { text: 'no' }; } }));
    assert.equal(calls, 0);
    assert.deepEqual(outcome, { kind: 'terminal', reason: 'deadline-terminated', attemptsUsed: 0, attempts: [] });
  }
  let calls = 0;
  const outcome = await runPreparedGeminiRoute(input(), runtime({ now: () => 29_999, invokePreparedModel: async () => { calls += 1; return { text: 'yes' }; } }));
  assert.equal(calls, 1);
  assert.equal(outcome.kind, 'success');
});

test('pending invocation crosses deadline without router cancellation and late success is accepted', async () => {
  const clock = new FakeClock();
  clock.advance(29_999);
  const pending = deferred<RecognitionResult>();
  let calls = 0;
  const routed = runPreparedGeminiRoute(input(), runtime({
    now: clock.now,
    invokePreparedModel: async () => { calls += 1; return pending.promise; }
  }));
  await Promise.resolve();
  assert.equal(calls, 1);
  clock.advance(60_001); // injected invoker owns this bounded in-flight interval
  pending.resolve({ text: 'late exact success' });
  assert.deepEqual(await routed, { kind: 'success', result: { text: 'late exact success' } });
});

test('post-deadline transient, fail-fast, and owned adapter timeout failures terminate by deadline', async () => {
  for (const failure of [transient(), failFast('authentication'), transient('timeout', 'ADAPTER_TIMEOUT')]) {
    const clock = new FakeClock();
    const pending = deferred<RecognitionResult>();
    let calls = 0;
    const routed = runPreparedGeminiRoute(input(), runtime({ now: clock.now, invokePreparedModel: async () => { calls += 1; return pending.promise; } }));
    await Promise.resolve();
    clock.advance(30_000);
    pending.reject(failure);
    const outcome = await routed;
    assert.equal(outcome.kind, 'terminal');
    if (outcome.kind === 'terminal') assert.equal(outcome.reason, 'deadline-terminated');
    assert.equal(calls, 1);
  }
});

test('unusable envelope after expiry outranks deadline termination', async () => {
  const clock = new FakeClock();
  const pending = deferred<RecognitionResult>();
  const routed = runPreparedGeminiRoute(input(), runtime({ now: clock.now, invokePreparedModel: async () => pending.promise }));
  await Promise.resolve();
  clock.advance(30_000);
  pending.reject(unusable());
  const outcome = await routed;
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind === 'terminal') assert.equal(outcome.reason, 'envelope-unusable');
});

test('cooldown skips consume no attempts, create no gaps, and never poll', async () => {
  const cooldowns = createProviderModelCooldownStore();
  cooldowns.recordTransientFailure('gemini', 'primary', 0, 1000);
  const calls: string[] = [];
  const outcome = await runPreparedGeminiRoute(input(), runtime({
    now: () => 0,
    cooldowns,
    invokePreparedModel: async model => { calls.push(model); throw transient(); }
  }));
  assert.deepEqual(calls, ['secondary', 'third']);
  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind === 'terminal') assert.deepEqual(outcome.attempts.map(row => row.attempt), [1, 2]);

  let allFalseCalls = 0;
  const allCooling = createProviderModelCooldownStore();
  for (const model of input().candidates) allCooling.recordTransientFailure('gemini', model, 0, 1000);
  const allFalse = await runPreparedGeminiRoute(input(), runtime({ now: () => 0, cooldowns: allCooling, invokePreparedModel: async () => { allFalseCalls += 1; return { text: 'no' }; } }));
  assert.equal(allFalseCalls, 0);
  assert.deepEqual(allFalse, { kind: 'terminal', reason: 'route-exhausted', attemptsUsed: 0, attempts: [] });
});

test('diagnostic events follow execution order with contiguous started attempts and no skip number', async () => {
  const cooldowns = createProviderModelCooldownStore();
  cooldowns.recordTransientFailure('gemini', 'primary', 0, 1000);
  const events: RecoveryDiagnosticEvent[] = [];
  const outcome = await runPreparedGeminiRoute(input(), runtime({
    cooldowns,
    diagnosticSink: event => events.push(event),
    invokePreparedModel: async model => {
      if (model === 'secondary') throw {
        envelopeState: 'not-applicable',
        failure: createProviderFailure({
          provider: 'gemini', category: 'temporary-service', code: 'UNAVAILABLE',
          safeMessage: 'api_key=HOSTILE_SAFE_MESSAGE_SENTINEL prompt=PRIVATE_PROMPT'
        })
      } satisfies NormalizedGeminiFailure;
      return { text: 'exact success' };
    }
  }));
  assert.deepEqual(outcome, { kind: 'success', result: { text: 'exact success' } });
  assert.deepEqual(events.map(event => event.kind), [
    'cooldown-skipped', 'attempt-started', 'attempt-classified',
    'attempt-started', 'fallback-succeeded'
  ]);
  assert.equal('attempt' in events[0], false);
  assert.deepEqual(
    events.filter(event => event.kind === 'attempt-started').map(event => event.attempt),
    [1, 2]
  );
  const classified = events.find(event => event.kind === 'attempt-classified');
  assert.equal(classified?.kind, 'attempt-classified');
  if (classified?.kind === 'attempt-classified') {
    assert.equal(classified.operatorMessage.includes('HOSTILE_SAFE_MESSAGE_SENTINEL'), false);
    assert.equal(classified.operatorMessage.includes('PRIVATE_PROMPT'), false);
    assert.equal(classified.operatorMessage.includes('<redacted>'), true);
  }
});

test('terminal routes emit exactly one exhaustion event and throwing sinks do not alter routing', async () => {
  const events: RecoveryDiagnosticEvent[] = [];
  const exhausted = await runPreparedGeminiRoute(input({ candidates: ['only'] }), runtime({
    diagnosticSink: event => events.push(event),
    invokePreparedModel: async () => { throw transient(); }
  }));
  assert.equal(exhausted.kind, 'terminal');
  assert.equal(events.filter(event => event.kind === 'route-exhausted').length, 1);

  let calls = 0;
  const success = await runPreparedGeminiRoute(input({ candidates: ['only'] }), runtime({
    diagnosticSink: () => { throw new Error('observer failure'); },
    invokePreparedModel: async () => { calls += 1; return { text: 'unchanged' }; }
  }));
  assert.deepEqual(success, { kind: 'success', result: { text: 'unchanged' } });
  assert.equal(calls, 1);
});

test('pins bypass eligibility, use one model, preserve route, and never fallback', async () => {
  for (const pin of ['primary', 'secondary', 'off-route', 'cooling']) {
    const route = ['primary', 'secondary'];
    const calls: string[] = [];
    const cooldowns = createProviderModelCooldownStore();
    cooldowns.recordTransientFailure('gemini', pin, 0, 1000);
    const outcome = await runPreparedGeminiRoute(input({ candidates: [pin], pinned: true }), runtime({
      now: () => 0,
      cooldowns,
      invokePreparedModel: async model => { calls.push(model); throw transient(); }
    }));
    assert.deepEqual(calls, [pin]);
    assert.equal(cooldowns.isCooling('gemini', pin, 1), true);
    assert.equal(outcome.kind, 'terminal');
    assert.deepEqual(route, ['primary', 'secondary']);
  }
});

test('terminal formatter rejects hostile identifiers and bounds valid closed tuples', () => {
  const rejected = formatGeminiTerminalMessage('envelope-unusable', [{
    provider: 'gemini', model: `a\u0000\u0085\u061C\u200E\u202E\u2066b`, attempt: 1,
    category: 'malformed-response'
  }]);
  assert.equal(rejected, 'Recognition recovery failed: diagnostic unavailable.');

  const attempts: StartedGeminiAttempt[] = Array.from({ length: 8 }, (_, index) => ({
    provider: 'gemini',
    model: `${'😀'.repeat(190)}"\\-model-${index}`,
    attempt: index + 1,
    category: (['rate-limit', 'timeout', 'temporary-service', 'malformed-response'] as const)[index % 4] ?? 'temporary-service'
  }));
  const output = formatGeminiTerminalMessage('route-exhausted', attempts);
  assert.equal(output, formatGeminiTerminalMessage('route-exhausted', attempts));
  assert.equal(Buffer.byteLength(output, 'utf8') <= GEMINI_TERMINAL_MAX_BYTES, true);
  assert.match(output, /reason=route-exhausted/u);
  assert.match(output, /\\"|\\\\|\[\.\.\.\]/u);
  assert.equal(output.includes(GEMINI_TERMINAL_TRUNCATION_MARKER), true);
  assert.equal(output.includes('backup-exhausted'), false);
  assert.equal(output.includes('safeMessage'), false);
  assert.equal(output.includes('cause='), false);
  for (let attempt = 1; attempt <= 8; attempt += 1) assert.equal(output.includes(`attempt=${attempt},category=`), true);
});

test('all three Group 3 terminal reasons format exactly once', () => {
  const attempt: StartedGeminiAttempt = { provider: 'gemini', model: 'model', attempt: 1, category: 'temporary-service' };
  for (const reason of ['route-exhausted', 'deadline-terminated', 'envelope-unusable'] as const) {
    const output = formatGeminiTerminalMessage(reason, [attempt]);
    assert.equal(output.match(/reason=/gu)?.length, 1);
    assert.equal(output.includes(`reason=${reason}`), true);
  }
});

test('deterministic exponential backoff progresses and caps without randomness', async () => {
  for (const [maxBackoffMs, expected] of [[2000, [250, 500]], [300, [250, 300]]] as const) {
    const clock = new FakeClock();
    const sleeps: number[] = [];
    const outcome = await runPreparedGeminiRoute(input({ maxBackoffMs }), runtime({
      now: clock.now,
      sleep: async ms => { sleeps.push(ms); clock.advance(ms); },
      invokePreparedModel: async () => { throw transient(); }
    }));
    assert.equal(outcome.kind, 'terminal');
    assert.deepEqual(sleeps, expected);
  }
});

test('valid retry timing replaces normal delay, is capped, and zero is honored', async () => {
  for (const [retryAfterMs, expected] of [[1250, 1250], [5000, 2000], [0, 0]] as const) {
    const clock = new FakeClock();
    const sleeps: number[] = [];
    let calls = 0;
    const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary', 'secondary'] }), runtime({
      now: clock.now,
      sleep: async ms => { sleeps.push(ms); clock.advance(ms); },
      invokePreparedModel: async () => {
        calls += 1;
        if (calls === 1) throw transient('rate-limit', 'RESOURCE_EXHAUSTED', retryAfterMs);
        return { text: 'ok' };
      }
    }));
    assert.equal(outcome.kind, 'success');
    assert.deepEqual(sleeps, [expected]);
  }
});

test('invalid retry timing uses normal delay and timing never authorizes fallback', async () => {
  for (const retryAfterMs of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const clock = new FakeClock();
    const sleeps: number[] = [];
    let calls = 0;
    const invalid = transient();
    (invalid.failure as { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
    const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary', 'secondary'] }), runtime({
      now: clock.now,
      sleep: async ms => { sleeps.push(ms); clock.advance(ms); },
      invokePreparedModel: async () => {
        calls += 1;
        if (calls === 1) throw invalid;
        return { text: 'ok' };
      }
    }));
    assert.equal(outcome.kind, 'success');
    assert.deepEqual(sleeps, [250]);
  }
  const categoryOnly = failFast('rate-limit');
  let sleeps = 0;
  const failed = await runPreparedGeminiRoute(input(), runtime({
    sleep: async () => { sleeps += 1; },
    invokePreparedModel: async () => { throw categoryOnly; }
  }));
  assert.equal(failed.kind, 'fail-fast');
  assert.equal(sleeps, 0);
});

test('delay must fit strictly and post-sleep gates block adversarial deadline advancement', async () => {
  const noFitSleeps: number[] = [];
  const noFit = await runPreparedGeminiRoute(input({
    candidates: ['primary', 'secondary'], deadlineSeconds: 1, baseBackoffMs: 1000,
    maxBackoffMs: 1000
  }), runtime({
    sleep: async ms => { noFitSleeps.push(ms); },
    invokePreparedModel: async () => { throw transient(); }
  }));
  assert.deepEqual(noFitSleeps, []);
  assert.equal(noFit.kind, 'terminal');
  if (noFit.kind === 'terminal') assert.equal(noFit.reason, 'deadline-terminated');

  const clock = new FakeClock();
  let calls = 0;
  const advanced = await runPreparedGeminiRoute(input({ candidates: ['primary', 'secondary'] }), runtime({
    now: clock.now,
    sleep: async () => { clock.advance(30_000); },
    invokePreparedModel: async () => { calls += 1; throw transient(); }
  }));
  assert.equal(calls, 1);
  assert.equal(advanced.kind, 'terminal');
  if (advanced.kind === 'terminal') assert.equal(advanced.reason, 'deadline-terminated');
});

test('no delay starts after final candidate, pin, fail-fast, or toward only cooling candidates', async () => {
  const cases = [
    input({ candidates: ['only'] }),
    input({ candidates: ['pin'], pinned: true })
  ];
  for (const routeInput of cases) {
    let sleeps = 0;
    await runPreparedGeminiRoute(routeInput, runtime({
      sleep: async () => { sleeps += 1; },
      invokePreparedModel: async () => { throw transient(); }
    }));
    assert.equal(sleeps, 0);
  }

  const cooldowns = createProviderModelCooldownStore();
  cooldowns.recordTransientFailure('gemini', 'secondary', 0, 1000);
  let sleeps = 0;
  await runPreparedGeminiRoute(input({ candidates: ['primary', 'secondary'] }), runtime({
    cooldowns,
    sleep: async () => { sleeps += 1; },
    invokePreparedModel: async () => { throw transient(); }
  }));
  assert.equal(sleeps, 0);
});

test('eligible Gemini exhaustion invokes one final backup and returns exact success', async () => {
  const calls: string[] = [];
  const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary', 'secondary'] }), runtime({
    invokePreparedModel: async model => { calls.push(`gemini:${model}`); throw transient(); },
    backup: {
      provider: 'Backup provider',
      model: 'backup-model',
      invoke: async () => { calls.push('backup:backup-model'); return { text: ' exact backup ' }; }
    }
  }));
  assert.deepEqual(outcome, { kind: 'success', result: { text: ' exact backup ' } });
  assert.deepEqual(calls, ['gemini:primary', 'gemini:secondary', 'backup:backup-model']);
});

test('mixed transient/cooling and all-cooling routes can invoke backup without polling', async () => {
  for (const cooled of [['secondary'], ['primary', 'secondary']] as const) {
    const cooldowns = createProviderModelCooldownStore();
    for (const model of cooled) cooldowns.recordTransientFailure('gemini', model, 0, 1000);
    const geminiCalls: string[] = [];
    let backupCalls = 0;
    const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary', 'secondary'] }), runtime({
      cooldowns,
      invokePreparedModel: async model => { geminiCalls.push(model); throw transient(); },
      backup: {
        provider: 'Backup', model: 'model',
        invoke: async () => { backupCalls += 1; return { text: 'backup' }; }
      }
    }));
    assert.equal(outcome.kind, 'success');
    assert.equal(backupCalls, 1);
    assert.deepEqual(geminiCalls, cooled.length === 2 ? [] : ['primary']);
  }
});

test('backup shares exact attempt and strict deadline gates', async () => {
  let backupCalls = 0;
  const permitted = await runPreparedGeminiRoute(input({
    candidates: ['primary'], maxAttempts: 2
  }), runtime({
    invokePreparedModel: async () => { throw transient(); },
    backup: {
      provider: 'Backup', model: 'model',
      invoke: async () => { backupCalls += 1; throw createProviderFailure({
        provider: 'openai-compatible', category: 'unknown', safeMessage: 'fixed'
      }); }
    }
  }));
  assert.equal(backupCalls, 1);
  assert.equal(permitted.kind, 'terminal');
  if (permitted.kind === 'terminal') {
    assert.equal(permitted.attemptsUsed, 2);
    assert.deepEqual(permitted.attempts.map(row => row.attempt), [1, 2]);
  }

  for (const [maxAttempts, nowMs, cooling, reason] of [
    [1, 0, false, 'route-exhausted'],
    [2, 30_000, true, 'deadline-terminated'],
    [2, 30_001, true, 'deadline-terminated']
  ] as const) {
    let calls = 0;
    const cooldowns = createProviderModelCooldownStore();
    if (cooling) cooldowns.recordTransientFailure('gemini', 'primary', 0, 60_000);
    const outcome = await runPreparedGeminiRoute(input({
      candidates: ['primary'], maxAttempts, deadlineStartedAt: 0
    }), runtime({
      now: () => nowMs,
      cooldowns,
      invokePreparedModel: async () => { throw transient(); },
      backup: {
        provider: 'Backup', model: 'model',
        invoke: async () => { calls += 1; return { text: 'no' }; }
      }
    }));
    assert.equal(calls, 0);
    assert.equal(outcome.kind, 'terminal');
    if (outcome.kind === 'terminal') assert.equal(outcome.reason, reason);
  }
});

test('pin and Gemini fail-fast outcomes block backup', async () => {
  for (const [pinned, failure] of [
    [true, transient()],
    [false, failFast('authentication')]
  ] as const) {
    let backupCalls = 0;
    const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary'], pinned }), runtime({
      invokePreparedModel: async () => { throw failure; },
      backup: {
        provider: 'Backup', model: 'model',
        invoke: async () => { backupCalls += 1; return { text: 'no' }; }
      }
    }));
    assert.equal(backupCalls, 0);
    assert.equal(outcome.kind, pinned ? 'terminal' : 'fail-fast');
  }
});

test('every backup category is preserved verbatim and backup is always final', async () => {
  const categories: ProviderFailureCategory[] = [
    'authentication', 'permission', 'billing', 'invalid-request', 'unsupported-media',
    'safety', 'rate-limit', 'timeout', 'temporary-service', 'network', 'cancelled',
    'malformed-response', 'unknown'
  ];
  for (const category of categories) {
    let backupCalls = 0;
    let sleeps = 0;
    const outcome = await runPreparedGeminiRoute(input({ candidates: ['primary'] }), runtime({
      sleep: async () => { sleeps += 1; },
      invokePreparedModel: async () => { throw transient(); },
      backup: {
        provider: 'Backup provider', model: 'backup-model',
        invoke: async () => {
          backupCalls += 1;
          throw createProviderFailure({
            provider: 'openai-compatible', category, safeMessage: 'secret', retryAfterMs: 1
          });
        }
      }
    }));
    assert.equal(backupCalls, 1);
    assert.equal(sleeps, 0);
    assert.equal(outcome.kind, 'terminal');
    if (outcome.kind === 'terminal') {
      assert.equal(outcome.reason, 'backup-exhausted');
      assert.equal(outcome.attempts.at(-1)?.category, category);
    }
  }
});

test('only approved transient backup categories cool later requests and expiry permits retry', async () => {
  for (const category of ['rate-limit', 'timeout', 'temporary-service', 'network'] as const) {
    const clock = new FakeClock();
    const cooldowns = createProviderModelCooldownStore();
    let backupCalls = 0;
    const run = () => runPreparedGeminiRoute(input({
      candidates: ['primary'], cooldownSeconds: 1
    }), runtime({
      now: clock.now,
      cooldowns,
      invokePreparedModel: async () => { throw transient(); },
      backup: {
        provider: 'Backup', model: 'model',
        invoke: async () => {
          backupCalls += 1;
          throw createProviderFailure({
            provider: 'openai-compatible', category, safeMessage: 'fixed'
          });
        }
      }
    }));
    await run();
    await run();
    assert.equal(backupCalls, 1);
    clock.advance(1000);
    await run();
    assert.equal(backupCalls, 2);
  }
});

test('backup exhaustion formatting includes ordered provider/model/category tuples within cap', () => {
  const attempts: StartedGeminiAttempt[] = [
    { provider: 'gemini', model: 'primary', attempt: 1, category: 'rate-limit' },
    { provider: 'Backup provider', model: 'backup-model', attempt: 2, category: 'unsupported-media' }
  ];
  const output = formatGeminiTerminalMessage('backup-exhausted', attempts);
  assert.match(output, /reason=backup-exhausted/u);
  assert.match(output, /provider=\\?"gemini\\?".*attempt=1.*provider=\\?"Backup provider\\?".*attempt=2/u);
  assert.match(output, /category=unsupported-media/u);
  assert.equal(Buffer.byteLength(output, 'utf8') <= GEMINI_TERMINAL_MAX_BYTES, true);
  assert.equal(output.includes('safeMessage'), false);
});
