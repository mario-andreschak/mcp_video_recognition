/**
 * status: active
 * phase: change-b-groups-4-5-recovery
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Owns the only raw Gemini SDK error-envelope inspection boundary, including exact retry timing."
 * insights: "SDK 0.9.0 transport identities are erased. Retry timing is accepted only from direct error.details[0].retryDelay using fixed-three-decimal seconds and never changes eligibility."
 */

import type { ProviderFailure } from '../types/provider.js';
import { createProviderFailure, isProviderFailure } from './provider-failure.js';

export type GeminiEnvelopeState = 'usable' | 'unusable' | 'not-applicable';

export interface NormalizedGeminiFailure {
  readonly failure: ProviderFailure;
  readonly envelopeState: GeminiEnvelopeState;
}

export type GeminiRecoveryDecision =
  | { readonly kind: 'fallback-eligible' }
  | { readonly kind: 'fail-fast'; readonly terminalReason?: 'envelope-unusable' };

export const GEMINI_ERROR_MESSAGE_MAX_BYTES = 65_536;

const eligibleHttpStatuses: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const eligibleProviderCodes: ReadonlySet<string> = new Set([
  'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'
]);

// Phase 0 locked @google/genai 0.9.0 resolution: these identities are erased by
// the SDK wrapper. A future SDK rerun may replace this empty structured set.
export const GEMINI_STRUCTURED_TRANSPORT_CAPABILITIES: ReadonlySet<string> = new Set();

const malformed = (cause: unknown): NormalizedGeminiFailure => ({
  envelopeState: 'unusable',
  failure: createProviderFailure({
    provider: 'gemini',
    category: 'malformed-response',
    safeMessage: 'Gemini returned an unusable error response.',
    cause
  })
});

const unknown = (cause: unknown): NormalizedGeminiFailure => ({
  envelopeState: 'not-applicable',
  failure: createProviderFailure({
    provider: 'gemini',
    category: 'unknown',
    safeMessage: 'Gemini request failed.',
    cause
  })
});

const direct = (value: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;

const parseRetryDelayMs = (errorRecord: Record<string, unknown>): number | undefined => {
  const details = direct(errorRecord, 'details');
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const first = details[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return undefined;
  const retryDelay = direct(first as Record<string, unknown>, 'retryDelay');
  if (typeof retryDelay !== 'string') return undefined;
  const match = /^([0-9]+)\.([0-9]{3})s$/u.exec(retryDelay);
  if (match === null) return undefined;
  const seconds = Number(match[1]);
  const milliseconds = Number(match[2]);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(milliseconds)) return undefined;
  if (seconds > Math.floor((Number.MAX_SAFE_INTEGER - milliseconds) / 1000)) return undefined;
  const result = seconds * 1000 + milliseconds;
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
};

const categoryForStatus = (status: number): ProviderFailure['category'] => {
  if (status === 400 || status === 404 || status === 405 || status === 409 || status === 410 || status === 413 || status === 415 || status === 422) return 'invalid-request';
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate-limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500 && status <= 599) return 'temporary-service';
  return 'unknown';
};

const safeMessageForCategory = (category: ProviderFailure['category']): string => {
  if (category === 'authentication') return 'Gemini authentication failed.';
  if (category === 'permission') return 'Gemini permission was denied.';
  if (category === 'billing') return 'Gemini billing authorization failed.';
  if (category === 'invalid-request') return 'Gemini rejected the request.';
  if (category === 'rate-limit') return 'Gemini rate limit was reached.';
  if (category === 'timeout') return 'Gemini request timed out.';
  if (category === 'temporary-service') return 'Gemini is temporarily unavailable.';
  return 'Gemini request failed.';
};

export const normalizeGeminiGenerationFailure = (cause: unknown): NormalizedGeminiFailure => {
  if (isProviderFailure(cause)) {
    try {
      if (cause.provider === 'gemini' && (cause.code === 'CALLER_CANCELLED' || cause.code === 'ADAPTER_TIMEOUT')) {
        return { failure: cause, envelopeState: 'not-applicable' };
      }
    } catch {
      return malformed(cause);
    }
  }
  if (!(cause instanceof Error)) return unknown(cause);

  let name: unknown;
  let message: unknown;
  try {
    name = cause.name;
    message = cause.message;
  } catch {
    return malformed(cause);
  }
  if (typeof name !== 'string' || typeof message !== 'string') return malformed(cause);
  if (name !== 'ClientError' && name !== 'ServerError') return unknown(cause);
  if (Buffer.byteLength(message, 'utf8') > GEMINI_ERROR_MESSAGE_MAX_BYTES) return malformed(cause);

  const match = /^got status: ([0-9]+) ([^\r\n.]+)\. ([\s\S]+)$/u.exec(message);
  if (match === null) return malformed(cause);
  const status = Number(match[1]);
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) return malformed(cause);
  if ((name === 'ClientError') !== (status >= 400 && status <= 499)) return malformed(cause);
  if ((name === 'ServerError') !== (status >= 500 && status <= 599)) return malformed(cause);

  let body: unknown;
  try {
    body = JSON.parse(match[3]);
  } catch {
    return malformed(cause);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return malformed(cause);
  const bodyError = direct(body as Record<string, unknown>, 'error');
  if (typeof bodyError !== 'object' || bodyError === null || Array.isArray(bodyError)) return malformed(cause);
  const errorRecord = bodyError as Record<string, unknown>;
  const bodyCode = direct(errorRecord, 'code');
  const providerCode = direct(errorRecord, 'status');
  if (!Number.isFinite(bodyCode) || !Number.isInteger(bodyCode) || bodyCode !== status) return malformed(cause);
  if (providerCode !== undefined && typeof providerCode !== 'string') return malformed(cause);

  const category = categoryForStatus(status);
  const retryAfterMs = parseRetryDelayMs(errorRecord);
  return {
    envelopeState: 'usable',
    failure: createProviderFailure({
      provider: 'gemini',
      category,
      safeMessage: safeMessageForCategory(category),
      status,
      ...(typeof providerCode === 'string' ? { code: providerCode } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      cause
    })
  };
};

export const classifyNormalizedGeminiFailure = (
  value: NormalizedGeminiFailure
): GeminiRecoveryDecision => {
  try {
    if (value.envelopeState === 'unusable') {
      return { kind: 'fail-fast', terminalReason: 'envelope-unusable' };
    }
    const { failure } = value;
    if (!isProviderFailure(failure) || failure.provider !== 'gemini') return { kind: 'fail-fast' };
    if (failure.code === 'CALLER_CANCELLED') return { kind: 'fail-fast' };
    if (failure.status === 403) return { kind: 'fail-fast' };
    if (failure.code === 'ADAPTER_TIMEOUT') return { kind: 'fallback-eligible' };
    if (typeof failure.status === 'number' && eligibleHttpStatuses.has(failure.status)) {
      return { kind: 'fallback-eligible' };
    }
    if (typeof failure.status === 'number' && failure.status >= 400 && failure.status <= 499) {
      return { kind: 'fail-fast' };
    }
    if (typeof failure.code === 'string' && eligibleProviderCodes.has(failure.code)) {
      return { kind: 'fallback-eligible' };
    }
    return { kind: 'fail-fast' };
  } catch {
    return { kind: 'fail-fast' };
  }
};
