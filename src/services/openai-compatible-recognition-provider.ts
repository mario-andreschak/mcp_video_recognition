/**
 * status: active
 * phase: phase-4b-request-boundaries
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-05
 * agent_notes: "Implements the OpenAI-compatible recognition provider, handling media conversion, bounded reading, and request validation."
 * insights: "Abort ownership is managed by a race between a caller signal and a local timer. Bounded reading stops exactly at the byte cap to prevent memory exhaustion. Identifiers and paths are validated before any network or file I/O."
 *
 * Known ceiling: Concurrent filesystem mutations during reads are not mitigated; upgrade by moving media reads behind a stable-file snapshot abstraction if that threat enters scope.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  MediaKind,
  ProviderCallOptions,
  ProviderFailureCategory,
  RecognitionProvider,
  RecognitionRequest,
  RecognitionResult
} from '../types/provider.js';
import type { OpenAICompatibleProviderConfig } from './provider-config.js';
import { createProviderFailure } from './provider-failure.js';

const ALLOWLIST_SAFE_MESSAGE = 'Requested model is not allowed.';

const MODEL_INVALID_SAFE_MESSAGE = 'Requested model is invalid.';
const CONTAINMENT_SAFE_MESSAGE = 'OpenAI-compatible file is not in an allowed media root.';
const BYTE_CAP_SAFE_MESSAGE = 'Provider response exceeded the configured size limit.';
const MODEL_MAX_SCALARS = 200;

const hasForbiddenIdentifierCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029) {
      return true;
    }
  }
  return false;
};

const countUnicodeScalars = (value: string): number => [...value].length;

const assertValidModelIdentifier = (model: string): void => {
  if (countUnicodeScalars(model) > MODEL_MAX_SCALARS
    || hasForbiddenIdentifierCharacter(model)) {
    throw createProviderFailure({
      provider: 'openai-compatible',
      category: 'invalid-request',
      safeMessage: MODEL_INVALID_SAFE_MESSAGE
    });
  }
};

const isCanonicalChild = (root: string, candidate: string): boolean => {
  const rootForm = process.platform === 'win32' ? root.toLowerCase() : root;
  const candidateForm = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  return candidateForm.startsWith(rootForm + path.sep);
};

export const canonicalizeContainedFile = async (
  filepath: string,
  roots: readonly string[]
): Promise<string> => {
  let canonical: string;
  try {
    canonical = await realpath(filepath);
  } catch (cause) {
    throw createProviderFailure({
      provider: 'openai-compatible',
      category: 'invalid-request',
      safeMessage: CONTAINMENT_SAFE_MESSAGE,
      cause
    });
  }
  let stats;
  try {
    stats = await stat(canonical);
  } catch (cause) {
    throw createProviderFailure({
      provider: 'openai-compatible',
      category: 'invalid-request',
      safeMessage: CONTAINMENT_SAFE_MESSAGE,
      cause
    });
  }
  if (!stats.isFile()) {
    throw createProviderFailure({
      provider: 'openai-compatible',
      category: 'invalid-request',
      safeMessage: CONTAINMENT_SAFE_MESSAGE
    });
  }
  for (const root of roots) {
    if (isCanonicalChild(root, canonical)) return canonical;
  }
  throw createProviderFailure({
    provider: 'openai-compatible',
    category: 'invalid-request',
    safeMessage: CONTAINMENT_SAFE_MESSAGE
  });
};

const safeMessages: Readonly<Record<ProviderFailureCategory, string>> = {
  configuration: 'OpenAI-compatible provider configuration is invalid.',
  authentication: 'OpenAI-compatible provider authentication failed.',
  permission: 'OpenAI-compatible provider permission was denied.',
  billing: 'OpenAI-compatible provider billing authorization failed.',
  'invalid-request': 'OpenAI-compatible provider rejected the request.',
  'unsupported-media': 'OpenAI-compatible provider does not support this media.',
  safety: 'OpenAI-compatible provider refused the request for safety reasons.',
  'rate-limit': 'OpenAI-compatible provider rate limit was reached.',
  timeout: 'OpenAI-compatible request timed out.',
  'temporary-service': 'OpenAI-compatible provider is temporarily unavailable.',
  network: 'OpenAI-compatible network request failed.',
  cancelled: 'OpenAI-compatible request was cancelled.',
  'malformed-response': 'OpenAI-compatible provider returned a malformed response.',
  unknown: 'OpenAI-compatible request failed.'
};

interface MediaType {
  mime: string;
  format?: 'wav' | 'mp3';
}

const mediaTypes: Readonly<Record<MediaKind, Readonly<Record<string, MediaType>>>> = {
  image: {
    '.jpg': { mime: 'image/jpeg' },
    '.jpeg': { mime: 'image/jpeg' },
    '.png': { mime: 'image/png' },
    '.webp': { mime: 'image/webp' }
  },
  audio: {
    '.wav': { mime: 'audio/wav', format: 'wav' },
    '.mp3': { mime: 'audio/mp3', format: 'mp3' }
  },
  video: {
    '.mp4': { mime: 'video/mp4' },
    '.mpeg': { mime: 'video/mpeg' },
    '.mov': { mime: 'video/mov' },
    '.webm': { mime: 'video/webm' }
  }
};

const resolveMediaType = (mediaKind: MediaKind, filepath: string): MediaType => {
  const extension = path.extname(filepath).toLowerCase();
  const map = mediaTypes[mediaKind];
  const found = map[extension];
  if (found === undefined) {
    throw createProviderFailure({
      provider: 'openai-compatible',
      category: 'unsupported-media',
      safeMessage: safeMessages['unsupported-media']
    });
  }
  return found;
};

const buildMediaPart = (mediaKind: MediaKind, mediaType: MediaType, base64: string) => {
  if (mediaKind === 'image') {
    return {
      type: 'image_url',
      image_url: { url: `data:${mediaType.mime};base64,${base64}` }
    };
  }
  if (mediaKind === 'audio') {
    if (mediaType.format === undefined) {
      throw createProviderFailure({
        provider: 'openai-compatible',
        category: 'configuration',
        safeMessage: safeMessages.configuration
      });
    }
    return {
      type: 'input_audio',
      input_audio: { data: base64, format: mediaType.format }
    };
  }
  return {
    type: 'video_url',
    video_url: { url: `data:${mediaType.mime};base64,${base64}` }
  };
};

const errorTypeCategories: ReadonlyMap<string, ProviderFailureCategory> = new Map([
  ['authentication', 'authentication'],
  ['permission_denied', 'permission'],
  ['payment_required', 'billing'],
  ['rate_limit_exceeded', 'rate-limit'],
  ['provider_overloaded', 'temporary-service'],
  ['provider_unavailable', 'temporary-service'],
  ['server', 'temporary-service'],
  ['timeout', 'timeout'],
  ['content_policy_violation', 'safety'],
  ['refusal', 'safety'],
  ['invalid_image', 'unsupported-media'],
  ['image_too_large', 'unsupported-media'],
  ['image_too_small', 'unsupported-media'],
  ['unsupported_image_format', 'unsupported-media'],
  ['image_not_found', 'unsupported-media'],
  ['image_download_failed', 'unsupported-media'],
  ['context_length_exceeded', 'invalid-request'],
  ['max_tokens_exceeded', 'invalid-request'],
  ['token_limit_exceeded', 'invalid-request'],
  ['string_too_long', 'invalid-request'],
  ['invalid_request', 'invalid-request'],
  ['invalid_prompt', 'invalid-request'],
  ['not_found', 'invalid-request'],
  ['precondition_failed', 'invalid-request'],
  ['payload_too_large', 'invalid-request'],
  ['unprocessable', 'invalid-request']
]);

const categoryForErrorType = (errorType: string): ProviderFailureCategory | undefined =>
  errorTypeCategories.get(errorType);

const categoryForStatus = (status: number): ProviderFailureCategory => {
  if (status === 401) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 403) return 'permission';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 415) return 'unsupported-media';
  if (status === 429) return 'rate-limit';
  if (
    status === 400 || status === 404 || status === 412 || status === 413 || status === 422
  ) {
    return 'invalid-request';
  }
  if (status === 500 || status === 502 || status === 503) return 'temporary-service';
  if (status >= 400 && status < 500) return 'invalid-request';
  if (status >= 500 && status < 600) return 'temporary-service';
  return 'unknown';
};

const readErrorType = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const metadata = (error as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const errorType = (metadata as { error_type?: unknown }).error_type;
  return typeof errorType === 'string' ? errorType : undefined;
};

const hasErrorObject = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null;
};

const hasChoiceErrorMarker = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  if ((value as { finish_reason?: unknown }).finish_reason === 'error') return true;
  return hasErrorObject(value);
};

const parseRetryAfter = (headers: Headers): number | undefined => {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9]+(\.[0-9]+)?$/u.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  return milliseconds;
};

interface ActiveReaderHolder {
  current: ReadableStreamDefaultReader<Uint8Array> | null;
}

const readBoundedResponse = async (
  response: Response,
  maxBytes: number,
  activeReaderHolder: ActiveReaderHolder
): Promise<string> => {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  activeReaderHolder.current = reader;
  const decoder = new TextDecoder();
  let text = '';
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        const chunkSize = value.byteLength;
        if (totalBytes + chunkSize > maxBytes) {
          // First byte over cap: cancel, do not read again, release lock, throw
          try {
            await reader.cancel();
          } catch {
            // reader may already be closed
          }
          activeReaderHolder.current = null;
          try {
            reader.releaseLock();
          } catch {
            // reader may already be released
          }
          throw createProviderFailure({
            provider: 'openai-compatible',
            category: 'malformed-response',
            safeMessage: BYTE_CAP_SAFE_MESSAGE
          });
        }
        totalBytes += chunkSize;
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
    activeReaderHolder.current = null;
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released
    }
    return text;
  } catch (error) {
    activeReaderHolder.current = null;
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released
    }
    throw error;
  }
};

interface MappedFailureOptions {
  category: ProviderFailureCategory;
  status?: number;
  code?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

const mappedFailure = (options: MappedFailureOptions) =>
  createProviderFailure({
    provider: 'openai-compatible',
    category: options.category,
    safeMessage: safeMessages[options.category],
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.code !== undefined ? { code: options.code } : {}),
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {})
  });

const is2xx = (status: number): boolean => status >= 200 && status < 300;

const is3xx = (status: number): boolean => status >= 300 && status < 400;

const isSignalAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && signal.aborted === true;

const parseProviderResponse = async (response: Response, text: string): Promise<string> => {
  // 3xx is rejected by the caller before bounded reading; this function only parses body text.
  const retryAfterMs = parseRetryAfter(response.headers);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (is2xx(response.status)) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    throw mappedFailure({
      category: categoryForStatus(response.status),
      status: response.status,
      retryAfterMs
    });
  }

  // Choice-level structured error takes precedence over HTTP-status mapping
  if (typeof parsed === 'object' && parsed !== null) {
    const choices = (parsed as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0];
      if (typeof choice === 'object' && choice !== null) {
        const choiceErrorType = readErrorType(choice);
        if (choiceErrorType !== undefined) {
          const category = categoryForErrorType(choiceErrorType)
            ?? categoryForStatus(response.status);
          throw mappedFailure({ category, status: response.status, retryAfterMs });
        }
      }
    }
  }

  // Top-level structured error takes precedence over HTTP-status mapping
  const topLevelErrorType = readErrorType(parsed);
  if (topLevelErrorType !== undefined) {
    const category = categoryForErrorType(topLevelErrorType) ?? categoryForStatus(response.status);
    throw mappedFailure({ category, status: response.status, retryAfterMs });
  }

  if (is2xx(response.status)) {
    if (typeof parsed !== 'object' || parsed === null) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const choice = choices[0];
    if (typeof choice !== 'object' || choice === null) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    if (hasChoiceErrorMarker(choice)) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const message = (choice as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content !== 'string') {
      throw mappedFailure({ category: 'malformed-response' });
    }
    if (content.trim().length === 0) {
      throw mappedFailure({ category: 'malformed-response' });
    }
    return content;
  }

  // Non-2xx without recognized structured error: HTTP-status mapping
  throw mappedFailure({
    category: categoryForStatus(response.status),
    status: response.status,
    retryAfterMs
  });
};

type ReadMediaFile = (filepath: string) => Promise<Buffer>;

const readFileSafely = async (
  filepath: string,
  maxBytes: number,
  readMediaFile: ReadMediaFile = readFile
): Promise<string> => {
  let stats;
  try {
    stats = await stat(filepath);
  } catch (cause) {
    throw mappedFailure({ category: 'unsupported-media', cause });
  }
  if (stats.size > maxBytes) {
    throw mappedFailure({ category: 'unsupported-media' });
  }
  try {
    const buffer = await readMediaFile(filepath);
    return buffer.toString('base64');
  } catch (cause) {
    throw mappedFailure({ category: 'unsupported-media', cause });
  }
};

export class OpenAICompatibleRecognitionProvider implements RecognitionProvider {
  private inFlightReads = new Map<string, Promise<string>>();

  constructor(
    private readonly config: OpenAICompatibleProviderConfig,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private readonly readMediaFile: ReadMediaFile = readFile
  ) {}

  private async readCanonicalFile(canonicalFilepath: string): Promise<string> {
    const existing = this.inFlightReads.get(canonicalFilepath);
    if (existing) {
      return existing;
    }
    const promise = readFileSafely(
      canonicalFilepath,
      this.config.maxInlineMediaBytes,
      this.readMediaFile
    );
    this.inFlightReads.set(canonicalFilepath, promise);
    try {
      return await promise;
    } finally {
      this.inFlightReads.delete(canonicalFilepath);
    }
  }

  async recognize(
    request: RecognitionRequest,
    options?: ProviderCallOptions
  ): Promise<RecognitionResult> {
    // 1. Pre-aborted caller fails before any model, path, read, timer, or fetch work.
    if (isSignalAborted(options?.signal)) {
      throw mappedFailure({ category: 'cancelled', code: 'CALLER_CANCELLED' });
    }

    // 2. Resolve effective model.
    const model = request.model ?? this.config.model;

    // 3. Validate call-time model identifier (max 200 scalars, no C0/DEL/LS/PS).
    assertValidModelIdentifier(model);

    // 4. Enforce allowlist before any file or network work.
    if (this.config.modelAllowlist !== undefined
      && !this.config.modelAllowlist.includes(model)) {
      throw createProviderFailure({
        provider: 'openai-compatible',
        category: 'invalid-request',
        safeMessage: ALLOWLIST_SAFE_MESSAGE
      });
    }

    // 5. Canonical containment: realpath + stat.isFile + separator-aware root check.
    const canonicalFilepath = await canonicalizeContainedFile(
      request.filepath,
      this.config.allowedMediaRoots
    );

    // 6. Extension and MIME resolution (against the canonical path).
    const mediaType = resolveMediaType(request.mediaKind, canonicalFilepath);

    // 7. File metadata size guard, then read+base64 the canonical path.
    const base64 = await this.readCanonicalFile(canonicalFilepath);
    const mediaPart = buildMediaPart(request.mediaKind, mediaType, base64);

    // 8. Build the exact text-first body.
    const body = JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: request.prompt }, mediaPart]
        }
      ]
    });

    // 9. Immediately before fetch, compose the caller signal with a private timer.
    const composedController = new AbortController();
    // First-to-fire owns the abort: both the caller listener and the timer callback
    // race on `abortOwner === undefined` to claim ownership. `undefined` is the
    // "unowned" sentinel. Classification never reads error name or message.
    let abortOwner: 'caller' | 'timer' | undefined = undefined;
    const activeReaderHolder: ActiveReaderHolder = { current: null };
    const callerListener: { fn: (() => void) | null } = { fn: null };
    const timerState: { handle: ReturnType<typeof setTimeout> | null } = { handle: null };

    const cancelActiveReader = (): void => {
      if (activeReaderHolder.current !== null) {
        try {
          void activeReaderHolder.current.cancel().catch(() => {
            // reader may already be closed or errored
          });
        } catch {
          // reader may already be closed
        }
      }
    };

    if (options?.signal !== undefined) {
      callerListener.fn = (): void => {
        if (abortOwner === undefined) {
          abortOwner = 'caller';
          cancelActiveReader();
          composedController.abort();
        }
      };
      options.signal.addEventListener('abort', callerListener.fn, { once: true });
    }

    try {
      // Check after listener registration so an abort during local preparation is
      // observed even though AbortSignal does not replay an already-fired event.
      if (isSignalAborted(options?.signal)) {
        callerListener.fn?.();
      }
      if (abortOwner === 'caller') {
        throw mappedFailure({ category: 'cancelled', code: 'CALLER_CANCELLED' });
      }

      timerState.handle = setTimeout(() => {
        if (abortOwner === undefined) {
          abortOwner = 'timer';
          cancelActiveReader();
          composedController.abort();
        }
      }, this.config.requestTimeoutSeconds * 1000);

      // 10. Single fetch with manual redirect, no attribution, composed signal.
      let response: Response;
      try {
        response = await this.fetchFn(this.config.baseUrl.toString(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          body,
          redirect: 'manual',
          signal: composedController.signal
        });
      } catch (cause) {
        if (abortOwner === 'caller') {
          throw mappedFailure({ category: 'cancelled', code: 'CALLER_CANCELLED', cause });
        }
        if (abortOwner === 'timer') {
          throw mappedFailure({ category: 'timeout', code: 'ADAPTER_TIMEOUT', cause });
        }
        throw mappedFailure({ category: 'network', cause });
      }

      // 11. Reject every 3xx before bounded reading.
      if (is3xx(response.status)) {
        throw mappedFailure({ category: 'unknown', status: response.status });
      }

      // 12. Bounded incremental read via the active stream reader (no whole-body helpers).
      const text = await readBoundedResponse(
        response,
        this.config.maxResponseBytes,
        activeReaderHolder
      );

      // 12b. After a cancel, the body reader resolves its pending read() with done=true
      // (per Web Streams spec) and the bounded reader returns successfully with partial
      // text. Propagate the owned abort identity here so caller/timer ownership is
      // honored even when the body read did not throw.
      if (abortOwner === 'caller') {
        throw mappedFailure({ category: 'cancelled', code: 'CALLER_CANCELLED' });
      }
      if (abortOwner === 'timer') {
        throw mappedFailure({ category: 'timeout', code: 'ADAPTER_TIMEOUT' });
      }

      // 13. Parse and map.
      const result = await parseProviderResponse(response, text);
      return { text: result };
    } catch (error) {
      if (error instanceof Error && 'provider' in error) {
        throw error;
      }
      if (abortOwner === 'caller') {
        throw mappedFailure({ category: 'cancelled', code: 'CALLER_CANCELLED', cause: error });
      }
      if (abortOwner === 'timer') {
        throw mappedFailure({ category: 'timeout', code: 'ADAPTER_TIMEOUT', cause: error });
      }
      throw mappedFailure({ category: 'network', cause: error });
    } finally {
      // 14. Always clear timer, remove caller listener, and release any active reader.
      if (timerState.handle !== null) {
        clearTimeout(timerState.handle);
      }
      if (callerListener.fn !== null && options?.signal !== undefined) {
        options.signal.removeEventListener('abort', callerListener.fn);
      }
      if (activeReaderHolder.current !== null) {
        try {
          await activeReaderHolder.current.cancel();
        } catch {
          // reader may already be closed
        }
        try {
          activeReaderHolder.current.releaseLock();
        } catch {
          // reader may already be released
        }
      }
    }
  }
}
