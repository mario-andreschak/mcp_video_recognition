/**
 * status: active
 * phase: change-b-group-1-configuration
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Startup loader now exposes a validated Gemini recovery contract without implementing routing."
 * insights: "GEMINI_MODELS is the sole unlocked alias; omitted routes retain one canonical model, while enabled backup reuses the Change A OpenAI-compatible loader. Runtime non-string identifiers fail closed before string operations."
 */

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
export const PERSPECTIVES = [
  { label: 'Baseline', suffix: '' },
  { label: 'Visual Details', suffix: ' Focus on fine-grained visual details, lighting, and object positioning.' },
  { label: 'Text & OCR', suffix: ' Focus on extracting and transcribing any visible text or signage.' },
  { label: 'Temporal Sequence', suffix: ' Focus on the chronological order of events and movement.' },
  { label: 'Technical Composition', suffix: ' Focus on technical composition: camera angles and focus.' },
  { label: 'Contextual Analysis', suffix: ' Focus on contextual analysis: environment, setting, and tone.' },
  { label: 'Entity Counting', suffix: ' Focus on counting and categorizing all distinct objects observed.' },
  { label: 'Key Takeaways', suffix: ' Focus on summarizing the highest-signal key takeaways concisely.' }
] as const;

export function parseParallelPrompts(env: NodeJS.ProcessEnv | ProviderEnvironment): number {
  const raw = env.PARALLEL_PROMPTS;
  if (!raw) return 1;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PARALLEL_PROMPTS must be an integer between 1 and 8 (received: "${raw}")`);
  }
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 8) {
    throw new Error(`PARALLEL_PROMPTS must be an integer between 1 and 8 (received: "${raw}")`);
  }
  return parsed;
}

export type GeminiBackupConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly providerConfig: OpenAICompatibleProviderConfig };

export interface GeminiRecoveryConfig {
  readonly modelRoute: readonly string[];
  readonly maxAttempts: number;
  readonly deadlineSeconds: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly cooldownSeconds: number;
  readonly backup: GeminiBackupConfig;
}

export interface GeminiProviderConfig {
  provider: 'gemini';
  apiKey: string;
  model: string;
  modelAllowlist?: readonly string[];
  recovery: GeminiRecoveryConfig;
}

export interface OpenAICompatibleProviderConfig {
  provider: 'openai-compatible';
  apiKey: string;
  baseUrl: URL;
  model: string;
  providerLabel: string;
  modelAllowlist?: readonly string[];
  requestTimeoutSeconds: number;
  maxResponseBytes: number;
  maxInlineMediaBytes: number;
  allowedMediaRoots: readonly string[];
  allowInsecureLocal: boolean;
}

export type RecognitionProviderConfig =
  | GeminiProviderConfig
  | OpenAICompatibleProviderConfig;

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

const isAsciiEdgeWhitespace = (codePoint: number): boolean =>
  (codePoint >= 0x09 && codePoint <= 0x0d) || codePoint === 0x20;

const asciiTrim = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiEdgeWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isAsciiEdgeWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
};

const hasForbiddenIdentifierCharacter = (value: string): boolean =>
  /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);

export const isValidProviderIdentifier = (
  value: unknown,
  maximumScalars: number
): value is string => typeof value === 'string'
  && value.length > 0
  && [...value].length <= maximumScalars
  && !hasForbiddenIdentifierCharacter(value);

const hasForbiddenRawUrlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || /\p{White_Space}/u.test(character)) return true;
  }
  return false;
};

const configError = (variable: string, requirement: string): Error =>
  new Error(`${variable} ${requirement}.`);

const hasVariable = (env: ProviderEnvironment, variable: string): boolean =>
  Object.prototype.hasOwnProperty.call(env, variable);

const requiredValue = (env: ProviderEnvironment, variable: string): string => {
  const value = asciiTrim(env[variable] ?? '');
  if (value.length === 0) throw configError(variable, 'is required');
  return value;
};

const optionalValue = (env: ProviderEnvironment, variable: string): string | undefined => {
  if (!hasVariable(env, variable)) return undefined;
  const value = asciiTrim(env[variable] ?? '');
  return value.length === 0 ? undefined : value;
};

const rejectAliases = (env: ProviderEnvironment, aliases: readonly string[]): void => {
  for (const alias of aliases) {
    if (hasVariable(env, alias)) throw configError(alias, 'is not supported');
  }
};

const parseIdentifier = (value: string, variable: string, maximumScalars: number): string => {
  if (!isValidProviderIdentifier(value, maximumScalars)) {
    throw configError(variable, 'contains an invalid identifier');
  }
  return value;
};

const parseModelRoute = (env: ProviderEnvironment): readonly string[] => {
  const listVariable = 'GEMINI_MODELS';
  const singleVariable = 'GEMINI_MODEL';
  if (!hasVariable(env, listVariable)) {
    return [parseIdentifier(
      optionalValue(env, singleVariable) ?? DEFAULT_GEMINI_MODEL,
      singleVariable,
      200
    )];
  }
  if (hasVariable(env, singleVariable)) {
    throw configError(listVariable, `cannot be used with ${singleVariable}`);
  }

  const route: string[] = [];
  const seen = new Set<string>();
  for (const segment of (env[listVariable] ?? '').split(',')) {
    const model = asciiTrim(segment);
    if (model.length === 0 || seen.has(model)) continue;
    parseIdentifier(model, listVariable, 200);
    seen.add(model);
    route.push(model);
  }
  if (route.length === 0) throw configError(listVariable, 'must contain at least one model');
  return route;
};

const parseAllowlist = (
  env: ProviderEnvironment,
  variable: string
): readonly string[] | undefined => {
  if (!hasVariable(env, variable)) return undefined;

  const entries: string[] = [];
  const seen = new Set<string>();
  for (const segment of (env[variable] ?? '').split(',')) {
    const entry = asciiTrim(segment);
    if (entry.length === 0 || seen.has(entry)) continue;
    parseIdentifier(entry, variable, 200);
    seen.add(entry);
    entries.push(entry);
  }

  if (entries.length === 0) throw configError(variable, 'must contain at least one model');
  return entries;
};

const parseInteger = (
  env: ProviderEnvironment,
  variable: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number => {
  const configured = optionalValue(env, variable);
  if (configured === undefined) return defaultValue;
  if (!/^[0-9]+$/u.test(configured)) throw configError(variable, 'must be a decimal integer');

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configError(variable, `must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const parseRecoveryInteger = (
  env: ProviderEnvironment,
  variable: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number => {
  if (!hasVariable(env, variable)) return defaultValue;
  const configured = asciiTrim(env[variable] ?? '');
  if (!/^[0-9]+$/u.test(configured)) {
    throw configError(variable, `must be a decimal integer between ${minimum} and ${maximum}`);
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configError(variable, `must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const parseBackupEnabled = (env: ProviderEnvironment): boolean => {
  const variable = 'GEMINI_BACKUP_ENABLED';
  if (!hasVariable(env, variable)) return false;
  const configured = asciiTrim(env[variable] ?? '');
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  throw configError(variable, 'must be true or false');
};

const parseInsecureLocal = (env: ProviderEnvironment): boolean => {
  const variable = 'ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE';
  const configured = optionalValue(env, variable);
  if (configured === undefined || configured === 'false') return false;
  if (configured === 'true') return true;
  throw configError(variable, 'must be true or false');
};

const parseBaseUrl = (rawValue: string, allowInsecureLocal: boolean): URL => {
  const variable = 'OPENAI_COMPATIBLE_BASE_URL';
  if (hasForbiddenRawUrlCharacter(rawValue)) {
    throw configError(variable, 'must be a safe URL');
  }

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw configError(variable, 'must be a valid URL');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw configError(variable, 'must not contain user-info, query, or fragment');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw configError(variable, 'must use HTTPS');
  }

  const logicalHostname = url.hostname === '[::1]' ? '::1' : url.hostname;
  const isExactLoopback = ['localhost', '127.0.0.1', '::1'].includes(logicalHostname);
  const authority = rawValue.slice(rawValue.indexOf('//') + 2).split('/')[0] ?? '';
  const rawHostname = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':')[0] ?? '';
  const hasExactLoopbackSpelling =
    (logicalHostname === '127.0.0.1' && rawHostname === '127.0.0.1')
    || (logicalHostname === '::1' && rawHostname === '[::1]')
    || logicalHostname === 'localhost';
  if (
    url.protocol === 'http:'
    && (!allowInsecureLocal || !isExactLoopback || !hasExactLoopbackSpelling)
  ) {
    throw configError(variable, 'must use HTTPS unless exact loopback HTTP is enabled');
  }

  const normalizedPathname = url.pathname.replace(/\/+$/u, '');
  if (normalizedPathname.endsWith('/chat/completions')) {
    throw configError(variable, 'must exclude /chat/completions');
  }
  url.pathname = `${normalizedPathname}/chat/completions`;
  return url;
};

const parseAllowedRoots = async (env: ProviderEnvironment): Promise<readonly string[]> => {
  const variable = 'ALLOWED_MEDIA_ROOTS';
  const configured = requiredValue(env, variable);
  const roots = configured
    .split(path.delimiter)
    .map(asciiTrim)
    .filter(root => root.length > 0);
  if (roots.length === 0) throw configError(variable, 'must contain at least one directory');

  const canonicalRoots: string[] = [];
  for (const root of roots) {
    try {
      const canonicalRoot = await realpath(root);
      if (!(await stat(canonicalRoot)).isDirectory()) {
        throw configError(variable, 'must contain only existing directories');
      }
      canonicalRoots.push(canonicalRoot);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${variable} `)) throw error;
      throw configError(variable, 'must contain only existing directories');
    }
  }
  return canonicalRoots;
};

const loadOpenAICompatibleConfig = async (
  env: ProviderEnvironment
): Promise<OpenAICompatibleProviderConfig> => {
  rejectAliases(env, [
    'MEDIA_ROOTS',
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODELS',
    'OPENROUTER_RESPONSE_CACHE'
  ]);

  const allowInsecureLocal = parseInsecureLocal(env);
  const modelAllowlist = parseAllowlist(env, 'OPENAI_COMPATIBLE_MODEL_ALLOWLIST');

  return {
    provider: 'openai-compatible',
    apiKey: requiredValue(env, 'OPENAI_COMPATIBLE_API_KEY'),
    baseUrl: parseBaseUrl(requiredValue(env, 'OPENAI_COMPATIBLE_BASE_URL'), allowInsecureLocal),
    model: parseIdentifier(
      requiredValue(env, 'OPENAI_COMPATIBLE_MODEL'),
      'OPENAI_COMPATIBLE_MODEL',
      200
    ),
    providerLabel: parseIdentifier(
      optionalValue(env, 'OPENAI_COMPATIBLE_PROVIDER_LABEL') ?? 'OpenAI-compatible provider',
      'OPENAI_COMPATIBLE_PROVIDER_LABEL',
      64
    ),
    ...(modelAllowlist === undefined ? {} : { modelAllowlist }),
    requestTimeoutSeconds: parseInteger(
      env,
      'OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS',
      60,
      1,
      120
    ),
    maxResponseBytes: parseInteger(
      env,
      'OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES',
      1048576,
      1024,
      4194304
    ),
    maxInlineMediaBytes: parseInteger(
      env,
      'MAX_INLINE_MEDIA_BYTES',
      20971520,
      1048576,
      104857600
    ),
    allowedMediaRoots: await parseAllowedRoots(env),
    allowInsecureLocal
  };
};

const loadGeminiConfig = async (env: ProviderEnvironment): Promise<GeminiProviderConfig> => {
  const modelRoute = parseModelRoute(env);
  const modelAllowlist = parseAllowlist(env, 'GEMINI_MODEL_ALLOWLIST');
  const maxAttempts = parseRecoveryInteger(env, 'GEMINI_MAX_ATTEMPTS', 4, 1, 8);
  const deadlineSeconds = parseRecoveryInteger(
    env, 'GEMINI_RECOVERY_DEADLINE_SECONDS', 30, 1, 120
  );
  const baseBackoffMs = parseRecoveryInteger(env, 'GEMINI_BASE_BACKOFF_MS', 250, 0, 5000);
  const maxBackoffMs = parseRecoveryInteger(env, 'GEMINI_MAX_BACKOFF_MS', 2000, 0, 10000);
  const cooldownSeconds = parseRecoveryInteger(env, 'GEMINI_COOLDOWN_SECONDS', 60, 0, 600);
  if (maxBackoffMs < baseBackoffMs) {
    throw configError('GEMINI_MAX_BACKOFF_MS', 'must be greater than or equal to GEMINI_BASE_BACKOFF_MS');
  }
  const backup: GeminiBackupConfig = parseBackupEnabled(env)
    ? { enabled: true, providerConfig: await loadOpenAICompatibleConfig(env) }
    : { enabled: false };

  return {
    provider: 'gemini',
    apiKey: requiredValue(env, 'GOOGLE_API_KEY'),
    model: modelRoute[0],
    ...(modelAllowlist === undefined ? {} : { modelAllowlist }),
    recovery: {
      modelRoute,
      maxAttempts,
      deadlineSeconds,
      baseBackoffMs,
      maxBackoffMs,
      cooldownSeconds,
      backup
    }
  };
};

export const loadRecognitionProviderConfig = async (
  env: ProviderEnvironment
): Promise<RecognitionProviderConfig> => {
  const selection = optionalValue(env, 'RECOGNITION_PROVIDER') ?? 'gemini';
  if (selection === 'gemini') return loadGeminiConfig(env);
  if (selection === 'openai-compatible') return loadOpenAICompatibleConfig(env);
  throw configError('RECOGNITION_PROVIDER', 'must be gemini or openai-compatible');
};
