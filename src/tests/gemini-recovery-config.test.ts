/**
 * status: active
 * phase: change-b-group-1-configuration
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Credential-free startup contract matrix for Gemini routes, bounded recovery values, and explicit backup configuration."
 * insights: "Explicit invalid values fail closed; disabled backup never parses unused OpenAI-compatible settings. Cooldown behavior is intentionally deferred to Groups 3-4."
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GEMINI_MODEL,
  loadRecognitionProviderConfig,
  type GeminiProviderConfig,
  type ProviderEnvironment
} from '../services/provider-config.js';

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gemini-recovery-config-'));
const canonicalTemporaryDirectory = await realpath(temporaryDirectory);

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

const geminiEnvironment = (overrides: ProviderEnvironment = {}): ProviderEnvironment => ({
  GOOGLE_API_KEY: 'google-secret',
  ...overrides
});

const completeBackupEnvironment = (overrides: ProviderEnvironment = {}): ProviderEnvironment =>
  geminiEnvironment({
    GEMINI_BACKUP_ENABLED: 'true',
    OPENAI_COMPATIBLE_API_KEY: 'backup-secret',
    OPENAI_COMPATIBLE_BASE_URL: 'https://backup.example/v1',
    OPENAI_COMPATIBLE_MODEL: 'backup/model',
    ALLOWED_MEDIA_ROOTS: temporaryDirectory,
    ...overrides
  });

const loadGemini = async (env: ProviderEnvironment): Promise<GeminiProviderConfig> => {
  const config = await loadRecognitionProviderConfig(env);
  assert.equal(config.provider, 'gemini');
  if (config.provider !== 'gemini') assert.fail('wrong provider branch');
  return config;
};

const rejectionMessage = async (env: ProviderEnvironment): Promise<string> => {
  try {
    await loadRecognitionProviderConfig(env);
    assert.fail('expected configuration rejection');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return (error as Error).message;
  }
};

test('omitted route maps exactly once to the canonical model and recovery defaults', async () => {
  for (const [env, expectedModel] of [
    [geminiEnvironment(), DEFAULT_GEMINI_MODEL],
    [geminiEnvironment({ GEMINI_MODEL: 'canonical-model' }), 'canonical-model']
  ] as const) {
    const config = await loadGemini(env);
    assert.equal(config.model, expectedModel);
    assert.deepEqual(config.recovery, {
      modelRoute: [expectedModel],
      maxAttempts: 4,
      deadlineSeconds: 30,
      baseBackoffMs: 250,
      maxBackoffMs: 2000,
      cooldownSeconds: 60,
      backup: { enabled: false }
    });
    assert.equal(config.model, config.recovery.modelRoute[0]);
  }
});

test('explicit routes trim, preserve order, dedupe exactly, and append no implicit model', async () => {
  const config = await loadGemini(geminiEnvironment({
    GEMINI_MODELS: ' First,Second,,First,first, Third ,Second '
  }));
  assert.deepEqual(config.recovery.modelRoute, ['First', 'Second', 'first', 'Third']);
  assert.equal(config.model, 'First');
  assert.equal(config.recovery.modelRoute.includes(DEFAULT_GEMINI_MODEL), false);

  const one = await loadGemini(geminiEnvironment({ GEMINI_MODELS: 'only,only' }));
  assert.deepEqual(one.recovery.modelRoute, ['only']);
  assert.equal(one.model, one.recovery.modelRoute[0]);
});

test('present-empty routes and simultaneous list plus canonical single setting fail safely', async () => {
  for (const value of ['', ' , , ', '\t,\r,']) {
    const message = await rejectionMessage(geminiEnvironment({ GEMINI_MODELS: value }));
    assert.match(message, /GEMINI_MODELS/u);
    assert.equal(message.includes(value), value.length === 0);
    assert.equal(message.length < 256, true);
  }
  for (const single of ['', 'canonical']) {
    const message = await rejectionMessage(geminiEnvironment({
      GEMINI_MODELS: 'route',
      GEMINI_MODEL: single
    }));
    assert.match(message, /GEMINI_MODELS/u);
    assert.match(message, /GEMINI_MODEL/u);
  }
});

test('model and provider-label identifiers enforce scalar limits and reject Cc/Cf characters', async () => {
  const exact200 = '😀'.repeat(200);
  const config = await loadGemini(geminiEnvironment({ GEMINI_MODELS: `${exact200},valid` }));
  assert.equal([...config.recovery.modelRoute[0]].length, 200);

  for (const hostile of [
    '😀'.repeat(201), `bad\u0000model`, `bad\u0085model`, `bad\u200Emodel`,
    `bad\u202Emodel`, `bad\u2066model`, `bad\u2028model`, `bad\u2029model`
  ]) {
    const message = await rejectionMessage(geminiEnvironment({ GEMINI_MODELS: hostile }));
    assert.match(message, /GEMINI_MODELS/u);
    assert.equal(message.includes(hostile), false);
    assert.equal(message.length < 256, true);
  }

  const label = await loadGemini(completeBackupEnvironment({
    OPENAI_COMPATIBLE_PROVIDER_LABEL: '😀'.repeat(64)
  }));
  assert.equal(label.recovery.backup.enabled, true);
  for (const hostile of ['😀'.repeat(65), `bad\u061Clabel`, `bad\u007flabel`]) {
    const message = await rejectionMessage(completeBackupEnvironment({
      OPENAI_COMPATIBLE_PROVIDER_LABEL: hostile
    }));
    assert.match(message, /OPENAI_COMPATIBLE_PROVIDER_LABEL/u);
    assert.equal(message.includes(hostile), false);
  }
});

const numericFields = [
  ['GEMINI_MAX_ATTEMPTS', 'maxAttempts', 4, 1, 8],
  ['GEMINI_RECOVERY_DEADLINE_SECONDS', 'deadlineSeconds', 30, 1, 120],
  ['GEMINI_BASE_BACKOFF_MS', 'baseBackoffMs', 250, 0, 5000],
  ['GEMINI_MAX_BACKOFF_MS', 'maxBackoffMs', 2000, 0, 10000],
  ['GEMINI_COOLDOWN_SECONDS', 'cooldownSeconds', 60, 0, 600]
] as const;

test('recovery numerics accept exact defaults and inclusive boundaries', async () => {
  const defaults = await loadGemini(geminiEnvironment());
  for (const [, property, defaultValue] of numericFields) {
    assert.equal(defaults.recovery[property], defaultValue);
  }

  for (const [variable, property, , minimum, maximum] of numericFields) {
    for (const value of [minimum, maximum]) {
      const companion = variable === 'GEMINI_BASE_BACKOFF_MS'
        ? { GEMINI_MAX_BACKOFF_MS: String(Math.max(value, 2000)) }
        : variable === 'GEMINI_MAX_BACKOFF_MS'
          ? { GEMINI_BASE_BACKOFF_MS: String(Math.min(value, 250)) }
          : {};
      const config = await loadGemini(geminiEnvironment({
        ...companion,
        [variable]: String(value)
      }));
      assert.equal(config.recovery[property], value);
    }
  }

  const equal = await loadGemini(geminiEnvironment({
    GEMINI_BASE_BACKOFF_MS: '5000',
    GEMINI_MAX_BACKOFF_MS: '5000'
  }));
  assert.equal(equal.recovery.baseBackoffMs, equal.recovery.maxBackoffMs);
});

test('every explicit malformed, non-finite, fractional, signed, exponent, and ranged numeric fails', async () => {
  const malformed = ['', ' ', 'abc', 'NaN', 'Infinity', '-Infinity', '1.5', '1e2', '+1', '-1', '900719925474099199'];
  for (const [variable, , , minimum, maximum] of numericFields) {
    const values = [String(minimum - 1), String(maximum + 1), ...malformed];
    for (const value of values) {
      const message = await rejectionMessage(geminiEnvironment({ [variable]: value }));
      assert.match(message, new RegExp(variable, 'u'));
      assert.equal(message.includes(value) && value.length > 3, false);
      assert.equal(message.length < 256, true);
    }
  }
});

test('maximum backoff below base backoff fails with a fixed cross-field message', async () => {
  const message = await rejectionMessage(geminiEnvironment({
    GEMINI_BASE_BACKOFF_MS: '1000',
    GEMINI_MAX_BACKOFF_MS: '999'
  }));
  assert.equal(
    message,
    'GEMINI_MAX_BACKOFF_MS must be greater than or equal to GEMINI_BASE_BACKOFF_MS.'
  );
});

test('backup requires exact affirmative opt-in and disabled backup ignores unused settings', async () => {
  for (const enabled of [undefined, 'false', ' false '] as const) {
    const config = await loadGemini(geminiEnvironment({
      ...(enabled === undefined ? {} : { GEMINI_BACKUP_ENABLED: enabled }),
      OPENAI_COMPATIBLE_API_KEY: '',
      OPENAI_COMPATIBLE_BASE_URL: 'not-a-url',
      OPENAI_COMPATIBLE_MODEL: `bad\u0000model`,
      OPENAI_COMPATIBLE_PROVIDER_LABEL: `bad\u200Elabel`,
      OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS: 'NaN',
      ALLOWED_MEDIA_ROOTS: 'missing',
      OPENROUTER_API_KEY: 'unused-alias'
    }));
    assert.deepEqual(config.recovery.backup, { enabled: false });
  }
  for (const enabled of ['', 'TRUE', '1', '\u00a0true\u00a0']) {
    await assert.rejects(
      loadRecognitionProviderConfig(geminiEnvironment({ GEMINI_BACKUP_ENABLED: enabled })),
      /GEMINI_BACKUP_ENABLED/u
    );
  }
});

test('enabled backup reuses the complete typed Change A OpenAI-compatible config', async () => {
  const config = await loadGemini(completeBackupEnvironment());
  assert.equal(config.recovery.backup.enabled, true);
  if (!config.recovery.backup.enabled) assert.fail('backup unexpectedly disabled');
  assert.deepEqual(config.recovery.backup.providerConfig.allowedMediaRoots, [canonicalTemporaryDirectory]);
  assert.equal(config.recovery.backup.providerConfig.provider, 'openai-compatible');
  assert.equal(config.recovery.backup.providerConfig.model, 'backup/model');
  assert.equal(config.recovery.backup.providerConfig.providerLabel, 'OpenAI-compatible provider');
});

test('enabled backup fails startup when each canonical required setting is incomplete', async () => {
  for (const variable of [
    'OPENAI_COMPATIBLE_API_KEY',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_MODEL',
    'ALLOWED_MEDIA_ROOTS'
  ] as const) {
    const message = await rejectionMessage(completeBackupEnvironment({ [variable]: ' ' }));
    assert.match(message, new RegExp(variable, 'u'));
    assert.equal(message.length < 256, true);
  }
});

test('Group 1 configuration does not claim cooling-pin or pin-driven cooldown behavior', async () => {
  // Cooling-pin bypass and pin-created/refreshed cooldown require the Group 4 store and
  // remain explicit Group 3-4 handoff scenarios; this suite proves configuration only.
  const config = await loadGemini(geminiEnvironment({ GEMINI_MODELS: 'primary,later' }));
  assert.deepEqual(config.recovery.modelRoute, ['primary', 'later']);
  assert.equal('cooldownStore' in config.recovery, false);
});