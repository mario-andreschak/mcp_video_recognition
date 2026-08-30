/**
 * status: active
 * phase: change-b-group-6-observability
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Shared closed-input recovery diagnostics, operator sanitization, and private terminal provenance."
 * insights: "All emitted text is escaped and bounded as UTF-8. Recovery terminal text is associated with ProviderFailure only through a module-private WeakMap."
 */

import type {
  MediaKind,
  ProviderFailure,
  ProviderFailureCategory
} from '../types/provider.js';
import { isValidProviderIdentifier } from './provider-config.js';
import { createProviderFailure } from './provider-failure.js';

export const RECOVERY_DIAGNOSTIC_MAX_BYTES = 4096;
export const RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER = '[...]';
const MODEL_FIELD_MAX_BYTES = 320;
const PROVIDER_FIELD_MAX_BYTES = 256;
const INVALID_DIAGNOSTIC = 'Recognition recovery failed: diagnostic unavailable.';
const INVALID_OPERATOR_MESSAGE = 'Provider diagnostic unavailable.';
const REDACTION = '<redacted>';

export interface StartedProviderAttempt {
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly category: ProviderFailureCategory;
}

export type GeminiTerminalReason =
  | 'route-exhausted'
  | 'deadline-terminated'
  | 'envelope-unusable'
  | 'backup-exhausted';

export type RecoveryDiagnosticEvent =
  | {
      readonly kind: 'attempt-started';
      readonly provider: string;
      readonly model: string;
      readonly mediaKind: MediaKind;
      readonly attempt: number;
    }
  | {
      readonly kind: 'attempt-classified';
      readonly provider: string;
      readonly model: string;
      readonly mediaKind: MediaKind;
      readonly attempt: number;
      readonly category: ProviderFailureCategory;
      readonly operatorMessage: string;
    }
  | {
      readonly kind: 'cooldown-skipped';
      readonly provider: string;
      readonly model: string;
      readonly mediaKind: MediaKind;
    }
  | {
      readonly kind: 'fallback-succeeded';
      readonly provider: string;
      readonly model: string;
      readonly mediaKind: MediaKind;
      readonly attempt: number;
    }
  | {
      readonly kind: 'route-exhausted';
      readonly mediaKind: MediaKind;
      readonly reason: GeminiTerminalReason;
      readonly attemptsUsed: number;
    };

export type RecoveryDiagnosticSink = (event: RecoveryDiagnosticEvent) => void;

const terminalMessages = new WeakMap<ProviderFailure, string>();

export const isMediaKind = (value: unknown): value is MediaKind =>
  value === 'image' || value === 'audio' || value === 'video';

const isBidiControl = (codePoint: number): boolean =>
  codePoint === 0x061c
  || codePoint === 0x200e
  || codePoint === 0x200f
  || (codePoint >= 0x202a && codePoint <= 0x202e)
  || (codePoint >= 0x2066 && codePoint <= 0x2069);

export const escapedDiagnosticUnits = (value: string): readonly string[] => [...value].map(character => {
  const codePoint = character.codePointAt(0) ?? 0;
  const isC0C1 = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  if (isC0C1 || isBidiControl(codePoint)) {
    return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  if (character === '\\') return '\\\\';
  if (character === '"') return '\\"';
  return character;
});

const truncateUnits = (units: readonly string[], maximumBytes: number): string => {
  const joined = units.join('');
  if (Buffer.byteLength(joined, 'utf8') <= maximumBytes) return joined;
  const budget = maximumBytes - Buffer.byteLength(RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER, 'utf8');
  let bytes = 0;
  let output = '';
  for (const unit of units) {
    const unitBytes = Buffer.byteLength(unit, 'utf8');
    if (bytes + unitBytes > budget) break;
    output += unit;
    bytes += unitBytes;
  }
  return output + RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER;
};

export const escapeAndTruncateDiagnostic = (
  value: string,
  maximumBytes = RECOVERY_DIAGNOSTIC_MAX_BYTES
): string => truncateUnits(escapedDiagnosticUnits(value), maximumBytes);

const redactKnownValue = (value: string, knownValue: string): string =>
  knownValue.length === 0 ? value : value.split(knownValue).join(REDACTION);

export interface OperatorSanitizationContext {
  readonly knownValues?: readonly string[];
}

export const sanitizeOperatorMessage = (
  safeMessage: string,
  context: OperatorSanitizationContext = {}
): string => {
  let value = safeMessage;
  for (const knownValue of context.knownValues ?? []) value = redactKnownValue(value, knownValue);

  const replacements: readonly [RegExp, string][] = [
    [/\b(?:api[_-]?key|credential|password|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, REDACTION],
    [/\bauthorization\s*:\s*[^\r\n]+/giu, REDACTION],
    [/\bbearer\s+[A-Za-z0-9._~+/-]+=*/giu, REDACTION],
    [/data:[^\s,;]+(?:;base64)?,[A-Za-z0-9+/=_-]+/giu, REDACTION],
    [/\bprompt\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n;]+)/giu, REDACTION],
    [/(?:file:\/\/\/[^\s"']+|[A-Za-z]:[\\/][^\s"']+|(?:^|\s)\/(?:[^\s/]+\/)*[^\s"']+)/gmu, REDACTION],
    [/\bfile[_ -]?contents?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n;]+)/giu, REDACTION],
    [/\b(?:encoded[_ -]?media|base64)\s*[:=]\s*[A-Za-z0-9+/=_-]+/giu, REDACTION],
    [/\b(?:upstream[_ -]?)?(?:response[_ -]?)?body\s*[:=]\s*(?:\{[^\r\n]*\}|\[[^\r\n]*\]|[^\r\n;]+)/giu, REDACTION]
  ];
  for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);

  // Non-Bidi format characters are rejected rather than silently emitted.
  if (/\p{Cf}/u.test(value)) return INVALID_OPERATOR_MESSAGE;
  return escapeAndTruncateDiagnostic(value);
};

const validAttempt = (attempt: StartedProviderAttempt): boolean =>
  isValidProviderIdentifier(attempt.provider, 64)
  && isValidProviderIdentifier(attempt.model, 200)
  && Number.isSafeInteger(attempt.attempt)
  && attempt.attempt > 0;

const boundedEscapedField = (value: string, maximumBytes: number): string =>
  escapeAndTruncateDiagnostic(value, maximumBytes);

export const formatRecoveryTerminalMessage = (
  mediaKind: unknown,
  reason: GeminiTerminalReason,
  attempts: readonly StartedProviderAttempt[]
): string => {
  if (!isMediaKind(mediaKind) || !attempts.every(validAttempt)) return INVALID_DIAGNOSTIC;
  const records = attempts.map(attempt =>
    `{provider="${boundedEscapedField(attempt.provider, PROVIDER_FIELD_MAX_BYTES)}",model="${boundedEscapedField(attempt.model, MODEL_FIELD_MAX_BYTES)}",attempt=${attempt.attempt},category=${attempt.category}}`
  );
  return escapeAndTruncateDiagnostic(
    `Gemini recovery terminated: media=${mediaKind}; reason=${reason}; attempts=[${records.join(',')}]`
  );
};

export interface RecoveryTerminalFailureDetails {
  readonly provider: ProviderFailure['provider'];
  readonly category: ProviderFailureCategory;
  readonly mediaKind: unknown;
  readonly reason: GeminiTerminalReason;
  readonly attempts: readonly StartedProviderAttempt[];
}

export const createRecoveryTerminalFailure = (
  details: RecoveryTerminalFailureDetails
): ProviderFailure => {
  const failure = createProviderFailure({
    provider: details.provider,
    category: details.category,
    safeMessage: 'Recognition recovery failed.'
  });
  terminalMessages.set(
    failure,
    formatRecoveryTerminalMessage(details.mediaKind, details.reason, details.attempts)
  );
  return failure;
};

export const getRecoveryTerminalMessage = (failure: ProviderFailure): string | undefined =>
  terminalMessages.get(failure);

const validEvent = (event: RecoveryDiagnosticEvent): boolean => {
  if (!isMediaKind(event.mediaKind)) return false;
  if (event.kind === 'route-exhausted') return Number.isSafeInteger(event.attemptsUsed) && event.attemptsUsed >= 0;
  if (!isValidProviderIdentifier(event.provider, 64) || !isValidProviderIdentifier(event.model, 200)) return false;
  if (event.kind === 'cooldown-skipped') return true;
  return Number.isSafeInteger(event.attempt) && event.attempt > 0;
};

export const formatRecoveryDiagnosticEvent = (event: RecoveryDiagnosticEvent): string => {
  if (!validEvent(event)) return INVALID_DIAGNOSTIC;
  if (event.kind === 'route-exhausted') {
    return escapeAndTruncateDiagnostic(
      `recovery event=${event.kind} media=${event.mediaKind} reason=${event.reason} attempts=${event.attemptsUsed}`
    );
  }
  const common = `recovery event=${event.kind} provider="${event.provider}" model="${event.model}" media=${event.mediaKind}`;
  if (event.kind === 'cooldown-skipped') return escapeAndTruncateDiagnostic(common);
  if (event.kind === 'attempt-classified') {
    return escapeAndTruncateDiagnostic(
      `${common} attempt=${event.attempt} category=${event.category} detail="${event.operatorMessage}"`
    );
  }
  return escapeAndTruncateDiagnostic(`${common} attempt=${event.attempt}`);
};

export const emitRecoveryDiagnostic = (
  sink: RecoveryDiagnosticSink | undefined,
  event: RecoveryDiagnosticEvent
): void => {
  if (sink === undefined || !validEvent(event)) return;
  try {
    sink(event);
  } catch {
    // Observability is non-authoritative and must not alter routing.
  }
};
