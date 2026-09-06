/**
 * status: active
 * phase: change-b-group-3-ordered-fallback
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-07
 * agent_notes: "Adapter integration covers one preparation, ordered models, one-element pins, and fresh post-preparation deadlines."
 * insights: "Invalid/disallowed pins remain pre-I/O and route-immutable. Raw extraction is classifier-only. Production Gemini generation intentionally has no adapter-wide timeout; the router uses only a soft pre-start clock gate."
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  GeminiRecognitionProvider
} from '../services/gemini-recognition-provider.js';
import {
  GeminiService,
  GeminiVideoProcessingTimeoutError
} from '../services/gemini.js';
import {
  loadRecognitionProviderConfig,
  type GeminiProviderConfig
} from '../services/provider-config.js';
import type { GeminiFile, GeminiResponse } from '../types/index.js';
import type {
  ProviderCallOptions,
  ProviderFailure,
  RecognitionProvider,
  RecognitionRequest
} from '../types/provider.js';
import { createProviderModelCooldownStore } from '../services/provider-cooldown-store.js';
import type { OpenAICompatibleProviderConfig } from '../services/provider-config.js';
import { getRecoveryTerminalMessage } from '../services/recovery-diagnostics.js';

interface ServiceCalls {
  uploadedPaths: string[];
  generations: { file: GeminiFile; prompt: string; model: string }[];
  wrapperCalls: number;
}

interface FakeOptions {
  uploadError?: unknown;
  generationError?: unknown;
  text?: string;
  onUpload?: () => void;
  generate?: (model: string) => Promise<GeminiResponse> | GeminiResponse;
}

const config = (overrides: Partial<GeminiProviderConfig> = {}): GeminiProviderConfig => ({
  provider: 'gemini',
  apiKey: 'credential-free-test-key',
  model: 'configured-model',
  recovery: {
    modelRoute: ['configured-model'],
    maxAttempts: 4,
    deadlineSeconds: 30,
    baseBackoffMs: 250,
    maxBackoffMs: 2000,
    cooldownSeconds: 60,
    backup: { enabled: false }
  },
  ...overrides
});

const request = (overrides: Partial<RecognitionRequest> = {}): RecognitionRequest => ({
  filepath: 'fixture.png',
  prompt: 'describe fixture',
  mediaKind: 'image',
  ...overrides
});

const enabledBackupConfig = (
  allowedMediaRoots: readonly string[],
  overrides: Partial<GeminiProviderConfig['recovery']> = {}
): GeminiProviderConfig => config({
  recovery: {
    modelRoute: ['configured-model'],
    maxAttempts: 2,
    deadlineSeconds: 30,
    baseBackoffMs: 250,
    maxBackoffMs: 2000,
    cooldownSeconds: 60,
    backup: {
      enabled: true,
      providerConfig: {
        provider: 'openai-compatible',
        apiKey: 'credential-free-backup-key',
        baseUrl: new URL('https://example.test/v1/chat/completions'),
        model: 'configured-backup-model',
        providerLabel: 'Configured backup',
        requestTimeoutSeconds: 60,
        maxResponseBytes: 1024,
        maxInlineMediaBytes: 1024,
        allowedMediaRoots,
        allowInsecureLocal: false
      } satisfies OpenAICompatibleProviderConfig
    },
    ...overrides
  }
});

const unexpectedAccess = (property: string): never => {
  throw new Error(`${property} must not be read`);
};

const fakeService = (options: FakeOptions = {}): { service: GeminiService; calls: ServiceCalls } => {
  const calls: ServiceCalls = { uploadedPaths: [], generations: [], wrapperCalls: 0 };
  const file: GeminiFile = { uri: 'gemini://fixture', mimeType: 'image/png', name: 'fixture' };
  const service = {
    uploadFile: async (filepath: string): Promise<GeminiFile> => {
      calls.uploadedPaths.push(filepath);
      options.onUpload?.();
      if (options.uploadError !== undefined) throw options.uploadError;
      return file;
    },
    processFileOrThrow: async (
      uploadedFile: GeminiFile,
      prompt: string,
      model: string
    ): Promise<GeminiResponse> => {
      calls.generations.push({ file: uploadedFile, prompt, model });
      if (options.generate !== undefined) return options.generate(model);
      if (options.generationError !== undefined) throw options.generationError;
      return { text: options.text ?? 'recognized text' };
    },
    processFile: async (): Promise<GeminiResponse> => {
      calls.wrapperCalls += 1;
      return { text: 'forbidden wrapper result' };
    }
  } as unknown as GeminiService;
  return { service, calls };
};

const sdkError = (status: number, providerCode: string): Error => {
  const error = new Error(`got status: ${status} Status Text. ${JSON.stringify({
    error: { code: status, status: providerCode }
  })}`);
  error.name = status < 500 ? 'ClientError' : 'ServerError';
  return error;
};

const captureFailure = async (
  provider: GeminiRecognitionProvider,
  recognitionRequest: RecognitionRequest,
  signal?: AbortSignal
): Promise<ProviderFailure> => {
  try {
    await provider.recognize(recognitionRequest, signal === undefined ? undefined : { signal });
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return error as ProviderFailure;
  }
};

test('success is text-only and uses configured/default or explicit model exactly once', async () => {
  for (const [model, expected] of [[undefined, 'configured-model'], ['explicit-model', 'explicit-model']] as const) {
    const { service, calls } = fakeService({ text: 'exact result' });
    const provider = new GeminiRecognitionProvider(service, config());
    assert.deepEqual(await provider.recognize(request({ model })), { text: 'exact result' });
    assert.equal(calls.uploadedPaths.length, 1);
    assert.equal(calls.generations.length, 1);
    assert.equal(calls.generations[0]?.model, expected);
    assert.equal(calls.wrapperCalls, 0);
  }
});

test('pre-aborted caller performs zero model, filepath, or service work', async () => {
  const { service, calls } = fakeService();
  const hostileConfig = config();
  Object.defineProperty(hostileConfig, 'modelAllowlist', {
    get: () => unexpectedAccess('allowlist')
  });
  const provider = new GeminiRecognitionProvider(service, hostileConfig);
  const controller = new AbortController();
  controller.abort();
  const hostileRequest = {
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); },
    get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); },
    get model(): string { return unexpectedAccess('model'); }
  } as RecognitionRequest;

  const failure = await captureFailure(provider, hostileRequest, controller.signal);
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
  assert.equal(calls.uploadedPaths.length, 0);
  assert.equal(calls.generations.length, 0);
});

test('allowlist uses exact equality and rejects before filepath or service work', async () => {
  const accepted = fakeService();
  const acceptedProvider = new GeminiRecognitionProvider(
    accepted.service,
    config({ modelAllowlist: ['Allowed-Model'] })
  );
  await acceptedProvider.recognize(request({ model: 'Allowed-Model' }));
  assert.equal(accepted.calls.uploadedPaths.length, 1);

  const rejected = fakeService();
  const rejectedProvider = new GeminiRecognitionProvider(
    rejected.service,
    config({ modelAllowlist: ['Allowed-Model'] })
  );
  const rejectedRequest = {
    model: 'allowed-model',
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); },
    get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); }
  } as RecognitionRequest;
  const failure = await captureFailure(rejectedProvider, rejectedRequest);
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is not allowed.');
  assert.equal(rejected.calls.uploadedPaths.length, 0);
});

test('primary, later-route, and allowed off-route pins each make one call without route mutation', async () => {
  const route = ['primary-model', 'later-model'] as const;
  const configured = config({
    model: route[0],
    modelAllowlist: [...route, 'off-route-model'],
    recovery: {
      modelRoute: route,
      maxAttempts: 4,
      deadlineSeconds: 30,
      baseBackoffMs: 250,
      maxBackoffMs: 2000,
      cooldownSeconds: 60,
      backup: { enabled: false }
    }
  });
  const routeBefore = [...configured.recovery.modelRoute];

  for (const pin of ['primary-model', 'later-model', 'off-route-model']) {
    const { service, calls } = fakeService();
    const provider = new GeminiRecognitionProvider(service, configured);
    await provider.recognize(request({ model: pin }));
    assert.deepEqual(calls.uploadedPaths, ['fixture.png']);
    assert.equal(calls.generations.length, 1);
    assert.equal(calls.generations[0]?.model, pin);
    assert.deepEqual(configured.recovery.modelRoute, routeBefore);
  }
});

test('invalid pins fail before filepath, upload, or generation access', async () => {
  for (const model of [
    '', '😀'.repeat(201), `bad\u0000model`, `bad\u0085model`,
    `bad\u200Emodel`, `bad\u202Emodel`, `bad\u2066model`, `bad\u2028model`
  ]) {
    const { service, calls } = fakeService();
    const provider = new GeminiRecognitionProvider(service, config());
    const hostileRequest = {
      model,
      get filepath(): string { return unexpectedAccess('filepath'); },
      get prompt(): string { return unexpectedAccess('prompt'); },
      get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); }
    } as RecognitionRequest;
    const failure = await captureFailure(provider, hostileRequest);
    assert.equal(failure.category, 'invalid-request');
    assert.equal(failure.safeMessage, 'Requested model is invalid.');
    if (model.length > 0) assert.equal(failure.safeMessage.includes(model), false);
    assert.equal(calls.uploadedPaths.length, 0);
    assert.equal(calls.generations.length, 0);
  }
});

test('runtime non-string pin fails as invalid-request before filepath or service access', async () => {
  const { service, calls } = fakeService();
  const provider = new GeminiRecognitionProvider(service, config());
  const hostileRequest = {
    model: { length: 5 },
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); },
    get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); }
  } as unknown as RecognitionRequest;

  const failure = await captureFailure(provider, hostileRequest);
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is invalid.');
  assert.equal(calls.uploadedPaths.length, 0);
  assert.equal(calls.generations.length, 0);
});

test('cooling pin bypasses the read gate and transient failure refreshes later state', async () => {
  const cooldowns = createProviderModelCooldownStore();
  cooldowns.recordTransientFailure('gemini', 'configured-model', 0, 10);
  const pinned = fakeService({ generationError: sdkError(503, 'UNAVAILABLE') });
  await captureFailure(new GeminiRecognitionProvider(pinned.service, config(), {
    now: () => 0, sleep: async () => undefined, cooldowns
  }), request({ model: 'configured-model' }));
  assert.equal(pinned.calls.generations.length, 1);
  assert.equal(cooldowns.isCooling('gemini', 'configured-model', 11), true);

  const later = fakeService();
  const failure = await captureFailure(new GeminiRecognitionProvider(later.service, config(), {
    now: () => 11, sleep: async () => undefined, cooldowns
  }), request());
  assert.equal(later.calls.generations.length, 0);
  assert.equal(failure.safeMessage, 'Recognition recovery failed.');
  assert.match(getRecoveryTerminalMessage(failure) ?? '', /reason=route-exhausted/u);
});

test('allowlist rejection safe message never echoes requested, default, allowed models, or credentials', async () => {
  const { service, calls } = fakeService();
  const provider = new GeminiRecognitionProvider(
    service,
    config({
      apiKey: 'DO-NOT-ECHO-CREDENTIAL',
      model: 'Default-Model',
      modelAllowlist: ['Allowed-One', 'Allowed-Two']
    })
  );
  const failure = await captureFailure(provider, request({ model: 'Requested-Model' }));
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is not allowed.');
  for (const leaked of ['Requested-Model', 'Default-Model', 'Allowed-One', 'Allowed-Two', 'DO-NOT-ECHO-CREDENTIAL']) {
    assert.equal(failure.safeMessage.includes(leaked), false);
  }
  assert.equal(calls.uploadedPaths.length, 0);
  assert.equal(calls.generations.length, 0);
});

test('all supported Gemini media pairs reach upload including ogg', async () => {
  const cases: readonly ['image' | 'audio' | 'video', string][] = [
    ['image', '.jpg'], ['image', '.jpeg'], ['image', '.png'], ['image', '.webp'],
    ['audio', '.wav'], ['audio', '.mp3'], ['audio', '.ogg'],
    ['video', '.mp4']
  ];
  for (const [mediaKind, extension] of cases) {
    const { service, calls } = fakeService();
    const provider = new GeminiRecognitionProvider(service, config());
    await provider.recognize(request({ filepath: `fixture${extension}`, mediaKind }));
    assert.deepEqual(calls.uploadedPaths, [`fixture${extension}`]);
    assert.equal(calls.generations.length, 1);
  }
});

test('mismatches and rejected video formats fail before service work', async () => {
  const cases: readonly ['image' | 'audio' | 'video', string][] = [
    ['image', '.mp3'], ['audio', '.png'], ['video', '.ogg'],
    ['video', '.mpeg'], ['video', '.mov'], ['video', '.avi'], ['video', '.webm'],
    ['image', '.gif'], ['audio', '.flac'], ['video', '']
  ];
  for (const [mediaKind, extension] of cases) {
    const { service, calls } = fakeService();
    const failure = await captureFailure(
      new GeminiRecognitionProvider(service, config()),
      request({ filepath: `fixture${extension}`, mediaKind })
    );
    assert.equal(failure.category, 'unsupported-media');
    assert.equal(calls.uploadedPaths.length, 0);
    assert.equal(calls.generations.length, 0);
  }
});

test('hostile runtime media kind fails closed before filepath or service access', async () => {
  const { service, calls } = fakeService();
  const provider = new GeminiRecognitionProvider(service, config());
  const hostileMedia = 'image\u202ESECRET_MEDIA_KIND';
  const hostileRequest = {
    model: 'configured-model',
    mediaKind: hostileMedia,
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); }
  } as unknown as RecognitionRequest;
  const failure = await captureFailure(provider, hostileRequest);
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage.includes(hostileMedia), false);
  assert.equal(calls.uploadedPaths.length, 0);
  assert.equal(calls.generations.length, 0);
});

test('upload and generation failures terminate after one attempt', async () => {
  const upload = fakeService({ uploadError: new Error('upload secret') });
  const uploadFailure = await captureFailure(
    new GeminiRecognitionProvider(upload.service, config()),
    request()
  );
  assert.equal(uploadFailure.category, 'unknown');
  assert.equal(upload.calls.uploadedPaths.length, 1);
  assert.equal(upload.calls.generations.length, 0);

  const generation = fakeService({ generationError: new Error('generation secret') });
  const generationFailure = await captureFailure(
    new GeminiRecognitionProvider(generation.service, config()),
    request()
  );
  assert.equal(generationFailure.category, 'unknown');
  assert.equal(generation.calls.uploadedPaths.length, 1);
  assert.equal(generation.calls.generations.length, 1);
});

test('exact permanent SDK envelopes fail fast with approved structured statuses', async () => {
  const mapped = [
    [400, 'invalid-request'], [401, 'authentication'], [402, 'billing'],
    [403, 'permission']
  ] as const;
  for (const [status, category] of mapped) {
    const { service } = fakeService({ generationError: sdkError(status, 'PERMANENT') });
    const failure = await captureFailure(new GeminiRecognitionProvider(service, config()), request());
    assert.equal(failure.category, category);
    assert.equal(failure.status, status);
  }
});

test('one preparation supports ordered transient fallback and stops on exact success', async () => {
  const configured = config({
    model: 'primary',
    recovery: {
      modelRoute: ['primary', 'secondary', 'third'], maxAttempts: 3,
      deadlineSeconds: 30, baseBackoffMs: 250, maxBackoffMs: 2000,
      cooldownSeconds: 60, backup: { enabled: false }
    }
  });
  const { service, calls } = fakeService({
    generate: model => {
      if (model === 'primary') throw sdkError(503, 'UNAVAILABLE');
      return { text: 'secondary exact text' };
    }
  });
  const result = await new GeminiRecognitionProvider(service, configured, {
    sleep: async () => undefined
  }).recognize(request());
  assert.deepEqual(result, { text: 'secondary exact text' });
  assert.deepEqual(calls.uploadedPaths, ['fixture.png']);
  assert.deepEqual(calls.generations.map(call => call.model), ['primary', 'secondary']);
  assert.equal(calls.wrapperCalls, 0);
});

test('all transient route failures produce bounded typed terminal content', async () => {
  const configured = config({
    model: 'primary',
    recovery: {
      modelRoute: ['primary', 'secondary'], maxAttempts: 2,
      deadlineSeconds: 30, baseBackoffMs: 250, maxBackoffMs: 2000,
      cooldownSeconds: 60, backup: { enabled: false }
    }
  });
  const { service, calls } = fakeService({ generationError: sdkError(429, 'RESOURCE_EXHAUSTED') });
  const failure = await captureFailure(new GeminiRecognitionProvider(service, configured, {
    sleep: async () => undefined
  }), request());
  assert.equal(failure.category, 'temporary-service');
  assert.equal(failure.safeMessage, 'Recognition recovery failed.');
  const terminal = getRecoveryTerminalMessage(failure) ?? '';
  assert.match(terminal, /reason=route-exhausted/u);
  assert.match(terminal, /model=\\?"primary\\?".*attempt=1.*model=\\?"secondary\\?".*attempt=2/u);
  assert.equal(Buffer.byteLength(terminal, 'utf8') <= 4096, true);
  assert.equal(terminal.includes('RESOURCE_EXHAUSTED'), false);
  assert.deepEqual(calls.uploadedPaths, ['fixture.png']);
  assert.deepEqual(calls.generations.map(call => call.model), ['primary', 'secondary']);
});

test('long preparation receives a fresh deadline and preparation failure starts no generation', async () => {
  let nowMs = 0;
  const prepared = fakeService({ onUpload: () => { nowMs += 45_000; } });
  const result = await new GeminiRecognitionProvider(prepared.service, config(), {
    now: () => nowMs
  }).recognize(request());
  assert.deepEqual(result, { text: 'recognized text' });
  assert.equal(prepared.calls.generations.length, 1);

  const failed = fakeService({ uploadError: new Error('preparation secret') });
  const failure = await captureFailure(new GeminiRecognitionProvider(failed.service, config(), {
    now: () => { throw new Error('deadline must not start'); }
  }), request());
  assert.equal(failure.category, 'unknown');
  assert.equal(failed.calls.generations.length, 0);
});

test('pinned transient call bypasses eligibility and never falls through to route', async () => {
  const configured = config({
    model: 'primary', modelAllowlist: ['primary', 'later', 'off-route'],
    recovery: {
      modelRoute: ['primary', 'later'], maxAttempts: 4,
      deadlineSeconds: 30, baseBackoffMs: 250, maxBackoffMs: 2000,
      cooldownSeconds: 60, backup: { enabled: false }
    }
  });
  const { service, calls } = fakeService({ generationError: sdkError(503, 'UNAVAILABLE') });
  const cooldowns = createProviderModelCooldownStore();
  cooldowns.recordTransientFailure('gemini', 'later', 0, 60_000);
  const failure = await captureFailure(new GeminiRecognitionProvider(service, configured, {
    now: () => 0,
    sleep: async () => undefined,
    cooldowns
  }), request({ model: 'later' }));
  assert.equal(failure.safeMessage, 'Recognition recovery failed.');
  assert.match(getRecoveryTerminalMessage(failure) ?? '', /reason=route-exhausted/u);
  assert.deepEqual(calls.generations.map(call => call.model), ['later']);
  assert.equal(cooldowns.isCooling('gemini', 'later', 1), true);
});

test('enabled backup receives a fresh canonical request without Gemini model and exact options', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gemini-backup-'));
  try {
    const filepath = path.join(root, 'fixture.png');
    await writeFile(filepath, 'fixture');
    const { service, calls } = fakeService({ generationError: sdkError(503, 'UNAVAILABLE') });
    const backupCalls: { request: RecognitionRequest; options?: ProviderCallOptions }[] = [];
    const backupProvider: RecognitionProvider = {
      recognize: async (backupRequest, options) => {
        backupCalls.push({ request: backupRequest, ...(options === undefined ? {} : { options }) });
        return { text: ' exact backup result ' };
      }
    };
    const controller = new AbortController();
    const result = await new GeminiRecognitionProvider(
      service,
      enabledBackupConfig([root]),
      { sleep: async () => undefined, backupProvider }
    ).recognize(request({ filepath, prompt: 'exact prompt' }), { signal: controller.signal });
    assert.deepEqual(result, { text: ' exact backup result ' });
    assert.deepEqual(calls.uploadedPaths, [filepath]);
    assert.equal(calls.generations.length, 1);
    assert.equal(backupCalls.length, 1);
    assert.deepEqual(backupCalls[0]?.request, {
      filepath,
      prompt: 'exact prompt',
      mediaKind: 'image'
    });
    assert.equal('model' in (backupCalls[0]?.request ?? {}), false);
    assert.equal(backupCalls[0]?.options?.signal?.aborted, false);
    controller.abort();
    assert.equal(backupCalls[0]?.options?.signal?.aborted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enabled backup containment rejects before Gemini upload and backup invocation', async () => {
  const allowedRoot = await mkdtemp(path.join(tmpdir(), 'gemini-allowed-'));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'gemini-outside-'));
  try {
    const outside = path.join(outsideRoot, 'outside.png');
    await writeFile(outside, 'fixture');
    const { service, calls } = fakeService();
    let backupCalls = 0;
    const failure = await captureFailure(new GeminiRecognitionProvider(
      service,
      enabledBackupConfig([allowedRoot]),
      { backupProvider: { recognize: async () => { backupCalls += 1; return { text: 'no' }; } } }
    ), request({ filepath: outside }));
    assert.equal(failure.category, 'invalid-request');
    assert.equal(calls.uploadedPaths.length, 0);
    assert.equal(calls.generations.length, 0);
    assert.equal(backupCalls, 0);
  } finally {
    await rm(allowedRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('explicit pin and preparation failure never invoke enabled backup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gemini-backup-blocks-'));
  try {
    const filepath = path.join(root, 'fixture.png');
    await writeFile(filepath, 'fixture');
    for (const [recognitionRequest, serviceOptions] of [
      [request({ filepath, model: 'configured-model' }), { generationError: sdkError(503, 'UNAVAILABLE') }],
      [request({ filepath }), { uploadError: new Error('upload failed') }]
    ] as const) {
      const { service } = fakeService(serviceOptions);
      let backupCalls = 0;
      await captureFailure(new GeminiRecognitionProvider(
        service,
        enabledBackupConfig([root]),
        {
          sleep: async () => undefined,
          backupProvider: { recognize: async () => { backupCalls += 1; return { text: 'no' }; } }
        }
      ), recognitionRequest);
      assert.equal(backupCalls, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backup unsupported media category remains verbatim in final bounded diagnostic', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gemini-backup-category-'));
  try {
    const filepath = path.join(root, 'fixture.png');
    await writeFile(filepath, 'fixture');
    const { service } = fakeService({ generationError: sdkError(503, 'UNAVAILABLE') });
    const failure = await captureFailure(new GeminiRecognitionProvider(
      service,
      enabledBackupConfig([root]),
      {
        sleep: async () => undefined,
        backupProvider: {
          recognize: async () => {
            throw Object.assign(new Error('fixed'), {
              name: 'ProviderFailure', provider: 'openai-compatible',
              category: 'unsupported-media', safeMessage: 'secret should not appear'
            });
          }
        }
      }
    ), request({ filepath }));
    assert.equal(failure.safeMessage, 'Recognition recovery failed.');
    const terminal = getRecoveryTerminalMessage(failure) ?? '';
    assert.match(terminal, /reason=backup-exhausted/u);
    assert.match(terminal, /category=unsupported-media/u);
    assert.equal(terminal.includes('secret should not appear'), false);
    assert.equal(Buffer.byteLength(terminal, 'utf8') <= 4096, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('synthetic raw status properties and malformed envelopes are never trusted', async () => {
  const throwingStatus = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(throwingStatus, 'status', { get: () => { throw new Error('getter secret'); } });
  for (const cause of [
    { status: 429 }, Object.create({ status: 429 }), { status: '429' },
    { status: Number.NaN }, { status: Infinity }, throwingStatus
  ]) {
    const { service } = fakeService({ generationError: cause });
    const failure = await captureFailure(new GeminiRecognitionProvider(service, config()), request());
    assert.equal(failure.category, 'unknown');
    assert.equal(failure.status, undefined);
  }
});

test('preparation message, name, tokens, retryability, and upstream code never alter classification', async () => {
  const variants = [
    new Error('got status: 429 rate limit token exhausted'),
    Object.assign(new Error('server unavailable'), {
      name: 'ApiError', code: 'UPSTREAM_SECRET_CODE', retryable: true, tokens: 0
    })
  ];
  for (const cause of variants) {
    const { service } = fakeService({ uploadError: cause });
    const failure = await captureFailure(new GeminiRecognitionProvider(service, config()), request());
    assert.equal(failure.category, 'unknown');
    assert.equal(failure.status, undefined);
    assert.equal(failure.code, undefined);
  }
});

test('owned timeout identity alone maps to GEMINI_VIDEO_PROCESSING_TIMEOUT', async () => {
  const owned = new GeminiVideoProcessingTimeoutError('sensitive filename');
  const ownedService = fakeService({ uploadError: owned }).service;
  const failure = await captureFailure(new GeminiRecognitionProvider(ownedService, config()), request());
  assert.equal(failure.category, 'timeout');
  assert.equal(failure.code, 'GEMINI_VIDEO_PROCESSING_TIMEOUT');
  assert.equal(failure.status, undefined);

  const impostor = Object.assign(new Error('sensitive filename'), {
    name: 'GeminiVideoProcessingTimeoutError'
  });
  const impostorService = fakeService({ uploadError: impostor }).service;
  const impostorFailure = await captureFailure(
    new GeminiRecognitionProvider(impostorService, config()),
    request()
  );
  assert.equal(impostorFailure.category, 'unknown');
  assert.equal(impostorFailure.code, undefined);
});

test('retained cause is non-enumerable and public failure text is sanitized', async () => {
  const cause = sdkError(403, 'PERMISSION_DENIED');
  Object.assign(cause, { upstreamCode: 'UPSTREAM_CODE_SECRET' });
  const filepath = 'C:/private/media/secret.png';
  const prompt = 'private prompt secret';
  const model = 'private model secret';
  const { service } = fakeService({ generationError: cause });
  const failure = await captureFailure(
    new GeminiRecognitionProvider(service, config()),
    request({ filepath, prompt, model })
  );

  assert.equal(failure.cause, cause);
  assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable, false);
  const publicText = `${failure.safeMessage}${JSON.stringify(failure)}${JSON.stringify({ ...failure })}`;
  for (const secret of [filepath, prompt, model, cause.message, 'UPSTREAM_CODE_SECRET']) {
    assert.equal(publicText.includes(secret), false);
  }
  assert.equal(failure.safeMessage.includes('429'), false);
});

test('valid Gemini config composes directly through the pinned constructor', async () => {
  const loaded = await loadRecognitionProviderConfig({ GOOGLE_API_KEY: 'composition-key' });
  assert.equal(loaded.provider, 'gemini');
  if (loaded.provider !== 'gemini') assert.fail('wrong provider branch');
  const { service } = fakeService({ text: 'composed result' });
  const provider = new GeminiRecognitionProvider(service, loaded);
  assert.deepEqual(await provider.recognize(request()), { text: 'composed result' });
});

test('source boundaries isolate raw SDK extraction and deterministic recovery behavior', async () => {
  const adapterSource = await readFile(
    path.resolve(process.cwd(), 'src/services/gemini-recognition-provider.ts'),
    'utf8'
  );
  const classifierSource = await readFile(
    path.resolve(process.cwd(), 'src/services/gemini-error-classifier.ts'),
    'utf8'
  );
  const routerSource = await readFile(
    path.resolve(process.cwd(), 'src/services/gemini-recovery-router.ts'),
    'utf8'
  );
  assert.match(adapterSource, /\.processFileOrThrow\(/u);
  assert.doesNotMatch(adapterSource, /\.processFile\(/u);
  assert.doesNotMatch(adapterSource, /\bfetch\s*\(|realpath|readFile/u);
  assert.match(adapterSource, /canonicalizeContainedFile/u);
  assert.match(adapterSource, /backupProvider/u);
  assert.doesNotMatch(adapterSource, /\.message|\.name|\.code|ClientError|ServerError|got status:/u);
  assert.match(classifierSource, /\.message/u);
  assert.match(classifierSource, /\.name/u);
  assert.match(classifierSource, /ClientError|ServerError/u);
  assert.match(classifierSource, /got status:/u);
  assert.doesNotMatch(routerSource, /\.(?:message|name|code)\b|ClientError|ServerError|got status:/u);
  for (const source of [adapterSource, classifierSource, routerSource]) {
    assert.doesNotMatch(source, /\brandom\s*[:=(]|jitter\s*[:=(]|Math\.random|operator.?log/iu);
  }
  assert.match(routerSource, /backup-exhausted/u);
  assert.match(routerSource, /baseBackoffMs/u);
  assert.match(routerSource, /recordTransientFailure/u);
  assert.doesNotMatch(routerSource, /setTimeout|AbortController|Promise\.race/u);
});