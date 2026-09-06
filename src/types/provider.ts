/**
 * status: active
 * phase: checkpoint-3-provider-contract
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-02
 * agent_notes: "Canonical provider-neutral boundary; vendor details belong in adapters."
 * insights: "RecognitionResult is success-only; failures are thrown through ProviderFailure."
 */

export type MediaKind = 'image' | 'audio' | 'video';

export interface RecognitionRequest {
  filepath: string;
  prompt: string;
  mediaKind: MediaKind;
  model?: string;
}

export interface ProviderCallOptions {
  signal?: AbortSignal;
}

export interface RecognitionResult {
  text: string;
}

export type ProviderFailureCategory =
  | 'configuration'
  | 'authentication'
  | 'permission'
  | 'billing'
  | 'invalid-request'
  | 'unsupported-media'
  | 'safety'
  | 'rate-limit'
  | 'timeout'
  | 'temporary-service'
  | 'network'
  | 'cancelled'
  | 'malformed-response'
  | 'unknown';

export interface ProviderFailure extends Error {
  provider: 'gemini' | 'openai-compatible';
  category: ProviderFailureCategory;
  safeMessage: string;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export interface RecognitionProvider {
  close?(): Promise<void>;
  recognize(
    request: RecognitionRequest,
    options?: ProviderCallOptions
  ): Promise<RecognitionResult>;
}
