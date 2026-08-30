/**
 * status: implementation-ready
 * phase: change-c-group-3-wrapper-failure-provenance
 * sprint: parallel-inference-revision
 * last_modified: 2026-08-21
 * agent_notes: "Wrapper recognises child failures only via the canonical isProviderFailure guard; raw objects, plain errors, and hostile getters are defaults-classified (unknown category) and never read to derive provider or category. Total-failure and cancellation values created by the wrapper carry the startup-declared provider label."
 * insights: "Deleting the raw-object fallback closes R1: a forged { name: 'ProviderFailure', ... } cannot steer classification outside the canonical guard. The tool boundary flattens any non-ProviderFailure throw to category=unknown, so wrapping an AggregateError of N child reasons in a canonical ProviderFailure preserves both per-child reasons and classified provenance at the tool mapper."
 */

import { PERSPECTIVES } from './provider-config.js';
import type { RecognitionProvider, RecognitionRequest, ProviderCallOptions, RecognitionResult } from '../types/provider.js';
import { createProviderFailure, isProviderFailure } from './provider-failure.js';

export type ParallelProviderLabel = 'gemini' | 'openai-compatible';

const PLACEHOLDER_CONCURRENCY = 2;

export class ParallelRecognitionProvider implements RecognitionProvider {
  private readonly innerProvider: RecognitionProvider;
  private readonly promptCount: number;
  private readonly providerLabel: ParallelProviderLabel;

  constructor(
    innerProvider: RecognitionProvider,
    promptCount: number,
    providerLabel: ParallelProviderLabel
  ) {
    this.innerProvider = innerProvider;
    this.promptCount = promptCount;
    this.providerLabel = providerLabel;
  }

  async recognize(request: RecognitionRequest, options?: ProviderCallOptions): Promise<RecognitionResult> {
    if (this.promptCount <= 1) {
      return this.innerProvider.recognize(request, options);
    }

    if (options?.signal && options.signal.aborted) {
      throw createProviderFailure({
        provider: this.providerLabel,
        category: 'cancelled',
        safeMessage: 'Request aborted before execution',
        cause: options.signal.reason
      });
    }

    const activePerspectives = PERSPECTIVES.slice(0, this.promptCount);
    const successes: string[] = [];
    const errors: unknown[] = [];

    for (let i = 0; i < activePerspectives.length; i += PLACEHOLDER_CONCURRENCY) {
      if (options?.signal && options.signal.aborted) {
        throw createProviderFailure({
          provider: this.providerLabel,
          category: 'cancelled',
          safeMessage: 'Request aborted during parallel execution',
          cause: options.signal.reason
        });
      }

      const batch = activePerspectives.slice(i, i + PLACEHOLDER_CONCURRENCY);

      const batchPromises = batch.map(async (p) => {
        const variantRequest = { ...request, prompt: `${request.prompt}${p.suffix}` };
        const result = await this.innerProvider.recognize(variantRequest, options);
        return { label: p.label, text: result.text };
      });

      const settled = await Promise.allSettled(batchPromises);

      if (options?.signal && options.signal.aborted) {
        throw createProviderFailure({
          provider: this.providerLabel,
          category: 'cancelled',
          safeMessage: 'Request aborted during parallel execution',
          cause: options.signal.reason
        });
      }

      for (const res of settled) {
        if (res.status === 'fulfilled') {
          successes.push(`### Perspective: ${res.value.label}\n${res.value.text}`);
        } else {
          errors.push(res.reason);
        }
      }
    }

    if (successes.length === 0) {
      const aggregate = new AggregateError(errors, 'All parallel prompts failed');

      const verified = errors.find(isProviderFailure);
      throw createProviderFailure({
        provider: this.providerLabel,
        category: verified?.category ?? 'unknown',
        safeMessage: 'All parallel prompts failed',
        cause: aggregate
      });
    }

    return { text: successes.join('\n\n---\n\n') };
  }
}
