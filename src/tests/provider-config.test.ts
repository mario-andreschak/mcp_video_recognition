/**
 * status: active
 * phase: change-b-group-1-configuration
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-21
 * agent_notes: "Tests provider selection, strict environment parsing, and Change C parallel prompt configuration."
 * insights: "Configuration loader validates selected-provider variables only and keeps provider construction out of configuration parsing. PARALLEL_PROMPTS treats an empty value as its default and accepts bounded decimal integers."
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GEMINI_MODEL,
  loadRecognitionProviderConfig,
  parseParallelPrompts,
  type ProviderEnvironment
} from '../services/provider-config.js';

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'provider-config-'));
const canonicalTemporaryDirectory = await realpath(temporaryDirectory);

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

const openAIEnvironment = (overrides: ProviderEnvironment = {}): ProviderEnvironment => ({
  RECOGNITION_PROVIDER: 'openai-compatible',
  OPENAI_COMPATIBLE_API_KEY: 'openai-secret',
  OPENAI_COMPATIBLE_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENAI_COMPATIBLE_MODEL: 'vendor/model',
  ALLOWED_MEDIA_ROOTS: temporaryDirectory,
  ...overrides
});

const rejectionMessage = async (env: ProviderEnvironment): Promise<string> => {
  try {
    await loadRecognitionProviderConfig(env);
    assert.fail('expected configuration rejection');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return (error as Error).message;
  }
};

test('omitted selection defaults to exact Gemini config and ignores all OpenAI variables', async () => {
  const config = await loadRecognitionProviderConfig({
    GOOGLE_API_KEY: '  google-secret\t',
    OPENAI_COMPATIBLE_API_KEY: '',
    OPENAI_COMPATIBLE_BASE_URL: 'not a url',
    OPENAI_COMPATIBLE_MODEL: '\u0000',
    OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS: 'NaN',
    ALLOWED_MEDIA_ROOTS: 'missing',
    MEDIA_ROOTS: '',
    OPENROUTER_API_KEY: ''
  });

  assert.deepEqual(config, {
    provider: 'gemini',
    apiKey: 'google-secret',
    model: DEFAULT_GEMINI_MODEL,
    recovery: {
      modelRoute: [DEFAULT_GEMINI_MODEL],
      maxAttempts: 4,
      deadlineSeconds: 30,
      baseBackoffMs: 250,
      maxBackoffMs: 2000,
      cooldownSeconds: 60,
      backup: { enabled: false }
    }
  });
});

test('Gemini validates only its selected values, aliases, identifiers, and allowlist grammar', async () => {
  const config = await loadRecognitionProviderConfig({
    RECOGNITION_PROVIDER: '\tgemini\r',
    GOOGLE_API_KEY: 'key',
    GEMINI_MODEL: ' model-A ',
    GEMINI_MODEL_ALLOWLIST: ' model-A,model-B,,model-A '
  });
  assert.deepEqual(config, {
    provider: 'gemini',
    apiKey: 'key',
    model: 'model-A',
    modelAllowlist: ['model-A', 'model-B'],
    recovery: {
      modelRoute: ['model-A'],
      maxAttempts: 4,
      deadlineSeconds: 30,
      baseBackoffMs: 250,
      maxBackoffMs: 2000,
      cooldownSeconds: 60,
      backup: { enabled: false }
    }
  });

  const routed = await loadRecognitionProviderConfig({
    GOOGLE_API_KEY: 'key',
    GEMINI_MODELS: ' model-A, model-B '
  });
  assert.equal(routed.provider, 'gemini');
  if (routed.provider !== 'gemini') assert.fail('wrong provider branch');
  assert.deepEqual(routed.recovery.modelRoute, ['model-A', 'model-B']);
  await assert.rejects(
    loadRecognitionProviderConfig({ GOOGLE_API_KEY: 'key', GEMINI_MODEL_ALLOWLIST: ' , \t, ' }),
    /GEMINI_MODEL_ALLOWLIST/u
  );
  await assert.rejects(
    loadRecognitionProviderConfig({ GOOGLE_API_KEY: 'key', GEMINI_MODEL: `bad\u2028model` }),
    /GEMINI_MODEL/u
  );
});

test('selection is exact, case-sensitive, ASCII-trimmed, and never inferred from credentials', async () => {
  await assert.rejects(
    loadRecognitionProviderConfig({ RECOGNITION_PROVIDER: 'Gemini', GOOGLE_API_KEY: 'key' }),
    /RECOGNITION_PROVIDER/u
  );
  await assert.rejects(
    loadRecognitionProviderConfig({
      RECOGNITION_PROVIDER: '\u00a0gemini\u00a0',
      GOOGLE_API_KEY: 'key'
    }),
    /RECOGNITION_PROVIDER/u
  );
  await assert.rejects(
    loadRecognitionProviderConfig({ OPENAI_COMPATIBLE_API_KEY: 'openai-only' }),
    /GOOGLE_API_KEY/u
  );
});

test('OpenAI-compatible branch returns exact defaults, final URL, and canonical roots', async () => {
  const config = await loadRecognitionProviderConfig(openAIEnvironment({
    OPENAI_COMPATIBLE_BASE_URL: 'https://openrouter.ai/api/v1///'
  }));

  assert.equal(config.provider, 'openai-compatible');
  if (config.provider !== 'openai-compatible') assert.fail('wrong provider branch');
  assert.equal(config.apiKey, 'openai-secret');
  assert.equal(config.baseUrl.href, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(config.model, 'vendor/model');
  assert.equal(config.providerLabel, 'OpenAI-compatible provider');
  assert.equal(config.modelAllowlist, undefined);
  assert.equal(config.requestTimeoutSeconds, 60);
  assert.equal(config.maxResponseBytes, 1048576);
  assert.equal(config.maxInlineMediaBytes, 20971520);
  assert.deepEqual(config.allowedMediaRoots, [canonicalTemporaryDirectory]);
  assert.equal(config.allowInsecureLocal, false);
});

test('OpenAI-compatible ignores malformed Gemini values and both credential sets select explicitly', async () => {
  const config = await loadRecognitionProviderConfig(openAIEnvironment({
    GOOGLE_API_KEY: 'google-secret',
    GEMINI_MODEL: '\u0000',
    GEMINI_MODEL_ALLOWLIST: ',,,',
    GEMINI_MODELS: ''
  }));
  assert.equal(config.provider, 'openai-compatible');
  assert.equal(config.apiKey, 'openai-secret');
});

test('numeric values require decimal safe integers within exact inclusive ranges', async () => {
  const lowerBoundaryConfig = await loadRecognitionProviderConfig(openAIEnvironment({
    OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS: '1',
    OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES: '1024',
    MAX_INLINE_MEDIA_BYTES: '1048576'
  }));
  assert.equal(lowerBoundaryConfig.provider, 'openai-compatible');
  if (lowerBoundaryConfig.provider !== 'openai-compatible') assert.fail('wrong provider branch');
  assert.equal(lowerBoundaryConfig.requestTimeoutSeconds, 1);
  assert.equal(lowerBoundaryConfig.maxResponseBytes, 1024);
  assert.equal(lowerBoundaryConfig.maxInlineMediaBytes, 1048576);

  const upperBoundaryConfig = await loadRecognitionProviderConfig(openAIEnvironment({
    OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS: '120',
    OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES: '4194304',
    MAX_INLINE_MEDIA_BYTES: '104857600'
  }));
  assert.equal(upperBoundaryConfig.provider, 'openai-compatible');
  if (upperBoundaryConfig.provider !== 'openai-compatible') assert.fail('wrong provider branch');
  assert.equal(upperBoundaryConfig.requestTimeoutSeconds, 120);
  assert.equal(upperBoundaryConfig.maxResponseBytes, 4194304);
  assert.equal(upperBoundaryConfig.maxInlineMediaBytes, 104857600);

  const invalidCases: readonly [string, string][] = [
    ['OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS', '0'],
    ['OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS', '121'],
    ['OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS', '1.5'],
    ['OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES', '1023'],
    ['OPENAI_COMPATIBLE_MAX_RESPONSE_BYTES', '4194305'],
    ['MAX_INLINE_MEDIA_BYTES', '1048575'],
    ['MAX_INLINE_MEDIA_BYTES', '104857601'],
    ['MAX_INLINE_MEDIA_BYTES', 'Infinity'],
    ['MAX_INLINE_MEDIA_BYTES', '900719925474099199']
  ];
  for (const [variable, value] of invalidCases) {
    const message = await rejectionMessage(openAIEnvironment({ [variable]: value }));
    assert.match(message, new RegExp(variable, 'u'));
    if (value !== '0') assert.equal(message.includes(value), false);
  }
});

test('boolean grammar is trim-then-exact', async () => {
  for (const [value, expected] of [[' true ', true], [' false ', false], ['', false]] as const) {
    const config = await loadRecognitionProviderConfig(openAIEnvironment({
      ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE: value
    }));
    assert.equal(config.provider, 'openai-compatible');
    if (config.provider !== 'openai-compatible') assert.fail('wrong provider branch');
    assert.equal(config.allowInsecureLocal, expected);
  }
  for (const value of ['TRUE', '1', '\u00a0true\u00a0']) {
    await assert.rejects(
      loadRecognitionProviderConfig(openAIEnvironment({
        ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE: value
      })),
      /ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE/u
    );
  }
});

test('URL safety and exact loopback HTTP matrix are enforced', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const config = await loadRecognitionProviderConfig(openAIEnvironment({
      OPENAI_COMPATIBLE_BASE_URL: `http://${host}:8080/v1`,
      ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE: 'true'
    }));
    assert.equal(config.provider, 'openai-compatible');
    if (config.provider !== 'openai-compatible') assert.fail('wrong provider branch');
    assert.equal(config.baseUrl.pathname, '/v1/chat/completions');
  }

  const rejectedUrls: readonly [string, string][] = [
    ['http://localhost/v1', 'false'],
    ['http://localhost./v1', 'true'],
    ['http://127.0.0.2/v1', 'true'],
    ['http://127.1/v1', 'true'],
    ['http://[::ffff:127.0.0.1]/v1', 'true'],
    ['http://[::2]/v1', 'true'],
    ['http://example.test/v1', 'true'],
    ['ftp://example.test/v1', 'false'],
    ['https://user:pass@example.test/v1', 'false'],
    ['https://example.test/v1?query=1', 'false'],
    ['https://example.test/v1#fragment', 'false'],
    ['https://example.test/v 1', 'false'],
    ['https://example.test/v\u00851', 'false'],
    ['https://example.test/v1/chat/completions', 'false'],
    ['https://example.test/v1/chat/completions///', 'false']
  ];
  for (const [baseUrl, insecureLocal] of rejectedUrls) {
    const message = await rejectionMessage(openAIEnvironment({
      OPENAI_COMPATIBLE_BASE_URL: baseUrl,
      ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE: insecureLocal
    }));
    assert.match(message, /OPENAI_COMPATIBLE_BASE_URL/u);
    assert.equal(message.includes(baseUrl), false);
  }
});

test('aliases, identifiers, allowlists, and required fields fail safely', async () => {
  for (const alias of [
    'MEDIA_ROOTS', 'OPENROUTER_API_KEY', 'OPENROUTER_MODELS', 'OPENROUTER_RESPONSE_CACHE'
  ]) {
    const message = await rejectionMessage(openAIEnvironment({ [alias]: '' }));
    assert.match(message, new RegExp(alias, 'u'));
  }

  const requiredVariables = [
    'OPENAI_COMPATIBLE_API_KEY',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_MODEL',
    'ALLOWED_MEDIA_ROOTS'
  ] as const;
  for (const variable of requiredVariables) {
    const message = await rejectionMessage(openAIEnvironment({ [variable]: ' \t ' }));
    assert.match(message, new RegExp(variable, 'u'));
  }

  const exact200Scalars = '😀'.repeat(200);
  const config = await loadRecognitionProviderConfig(openAIEnvironment({
    OPENAI_COMPATIBLE_MODEL: exact200Scalars,
    OPENAI_COMPATIBLE_PROVIDER_LABEL: 'L'.repeat(64),
    OPENAI_COMPATIBLE_MODEL_ALLOWLIST: ` Alpha,alpha,Alpha,,${exact200Scalars}`
  }));
  assert.equal(config.provider, 'openai-compatible');
  if (config.provider !== 'openai-compatible') assert.fail('wrong provider branch');
  assert.deepEqual(config.modelAllowlist, ['Alpha', 'alpha', exact200Scalars]);

  await assert.rejects(
    loadRecognitionProviderConfig(openAIEnvironment({ OPENAI_COMPATIBLE_MODEL: '😀'.repeat(201) })),
    /OPENAI_COMPATIBLE_MODEL/u
  );
  await assert.rejects(
    loadRecognitionProviderConfig(openAIEnvironment({ OPENAI_COMPATIBLE_PROVIDER_LABEL: 'L'.repeat(65) })),
    /OPENAI_COMPATIBLE_PROVIDER_LABEL/u
  );
  await assert.rejects(
    loadRecognitionProviderConfig(openAIEnvironment({ OPENAI_COMPATIBLE_MODEL_ALLOWLIST: ', ,\t' })),
    /OPENAI_COMPATIBLE_MODEL_ALLOWLIST/u
  );
});

test('Gemini model allowlist grammar trims, drops empties, is case-sensitive, dedupes by first occurrence', async () => {
  const config = await loadRecognitionProviderConfig({
    GOOGLE_API_KEY: 'google-secret',
    GEMINI_MODEL_ALLOWLIST: ' Flash,flash,,Flash ,\tPro\t'
  });
  assert.equal(config.provider, 'gemini');
  if (config.provider !== 'gemini') assert.fail('wrong provider branch');
  assert.deepEqual(config.modelAllowlist, ['Flash', 'flash', 'Pro']);
});

test('Gemini model allowlist with no non-empty entry fails startup naming the variable', async () => {
  const message = await rejectionMessage({
    GOOGLE_API_KEY: 'google-secret',
    GEMINI_MODEL_ALLOWLIST: ' , ,\t'
  });
  assert.match(message, /GEMINI_MODEL_ALLOWLIST/u);
});

test('allowed roots use path delimiter and require existing directories without requested-file access', async () => {
  const secondRoot = await mkdtemp(path.join(temporaryDirectory, 'second-'));
  const canonicalSecondRoot = await realpath(secondRoot);
  const config = await loadRecognitionProviderConfig(openAIEnvironment({
    ALLOWED_MEDIA_ROOTS: ` ${temporaryDirectory} ${path.delimiter}\t${secondRoot}\r${path.delimiter}`
  }));
  assert.equal(config.provider, 'openai-compatible');
  if (config.provider !== 'openai-compatible') assert.fail('wrong provider branch');
  assert.deepEqual(config.allowedMediaRoots, [canonicalTemporaryDirectory, canonicalSecondRoot]);

  const regularFile = path.join(temporaryDirectory, 'not-a-directory.txt');
  await writeFile(regularFile, 'fixture');
  for (const invalidRoot of [path.join(temporaryDirectory, 'missing'), regularFile]) {
    const message = await rejectionMessage(openAIEnvironment({ ALLOWED_MEDIA_ROOTS: invalidRoot }));
    assert.match(message, /ALLOWED_MEDIA_ROOTS/u);
    assert.equal(message.includes(invalidRoot), false);
  }
});

test('configuration errors are bounded and never ProviderFailure instances', async () => {
  const secret = 'DO-NOT-ECHO-THIS-SECRET';
  const message = await rejectionMessage(openAIEnvironment({
    OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS: secret
  }));
  assert.match(message, /OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS/u);
  assert.equal(message.includes(secret), false);
  assert.equal(message.length < 256, true);
});

test('loader remains standalone and contains no provider construction, media read, network, or containment', async () => {
  const source = await readFile(path.resolve(process.cwd(), 'src/services/provider-config.ts'), 'utf8');
  assert.doesNotMatch(source, /new\s+(?:GeminiService|Server|GeminiRecognitionProvider)/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\b(?:readFile|createReadStream)\b/u);
  assert.doesNotMatch(source, /requested(?:File|Path)|isPathContained|containsPath/u);
  assert.doesNotMatch(source, /from ['"]\.\/gemini/u);
});

test('parseParallelPrompts returns 1 if missing', () => {
  assert.strictEqual(parseParallelPrompts({}), 1);
  assert.strictEqual(parseParallelPrompts({ PARALLEL_PROMPTS: '' }), 1);
});

test('parseParallelPrompts parses valid integers', () => {
  assert.strictEqual(parseParallelPrompts({ PARALLEL_PROMPTS: '1' }), 1);
  assert.strictEqual(parseParallelPrompts({ PARALLEL_PROMPTS: '4' }), 4);
  assert.strictEqual(parseParallelPrompts({ PARALLEL_PROMPTS: '8' }), 8);
});

test('parseParallelPrompts rejects invalid or out of bounds', () => {
  assert.throws(() => parseParallelPrompts({ PARALLEL_PROMPTS: '0' }));
  assert.throws(() => parseParallelPrompts({ PARALLEL_PROMPTS: '9' }));
  assert.throws(() => parseParallelPrompts({ PARALLEL_PROMPTS: '2.5' }));
  assert.throws(() => parseParallelPrompts({ PARALLEL_PROMPTS: 'abc' }));
}); // End parallel prompt parsing regression coverage.

