/**
 * status: active
 * phase: phase-4b-request-boundaries
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-05
 * agent_notes: "Provides comprehensive, credential-free unit tests for the OpenAI-compatible recognition provider."
 * insights: "Tests utilize memory-based fetching and isolated temp directories. Important coverage includes verifying exact POST bodies, strict model allowlists, race-safe aborts, and accurate HTTP error mapping."
 */

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  OpenAICompatibleRecognitionProvider,
  canonicalizeContainedFile
} from '../services/openai-compatible-recognition-provider.js';
import type { OpenAICompatibleProviderConfig } from '../services/provider-config.js';
import type {
  MediaKind,
  ProviderCallOptions,
  ProviderFailure,
  RecognitionRequest
} from '../types/provider.js';

interface FetchCall {
  input: unknown;
  init: RequestInit | null;
}

const FIXTURE_KEY = 'credential-free-test-key';
const LEAKED_KEY_FRAGMENT = 'leaked-credential-fragment';
const LEAKED_PROMPT_FRAGMENT = 'leaked-prompt-fragment';
const LEAKED_MODEL_FRAGMENT = 'leaked-model-fragment';
const LEAKED_PATH_FRAGMENT = 'leaked-path-fragment';

const config = (overrides: Partial<OpenAICompatibleProviderConfig> = {}): OpenAICompatibleProviderConfig => ({
  provider: 'openai-compatible',
  apiKey: FIXTURE_KEY,
  baseUrl: new URL('https://openrouter.ai/api/v1/chat/completions'),
  model: 'configured-model',
  providerLabel: 'Test provider',
  requestTimeoutSeconds: 60,
  maxResponseBytes: 1024,
  maxInlineMediaBytes: 1024,
  allowedMediaRoots: [tempRoot],
  allowInsecureLocal: false,
  ...overrides
});

const request = (overrides: Partial<RecognitionRequest> = {}): RecognitionRequest => ({
  filepath: 'fixture.jpg',
  prompt: 'describe fixture',
  mediaKind: 'image',
  ...overrides
});

const unexpectedAccess = (property: string): never => {
  throw new Error(`${property} must not be read`);
};

const captureFailure = async (
  provider: OpenAICompatibleRecognitionProvider,
  recognitionRequest: RecognitionRequest,
  signal?: AbortSignal
): Promise<ProviderFailure> => {
  try {
    await provider.recognize(
      recognitionRequest,
      signal === undefined ? undefined : { signal }
    );
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return error as ProviderFailure;
  }
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });

const recordingFetch = (
  responder: (call: FetchCall) => Response | Error
): { fetchFn: typeof globalThis.fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchFn: typeof globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const call: FetchCall = { input, init: init ?? null };
    calls.push(call);
    const result = responder(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof globalThis.fetch;
  return { fetchFn, calls };
};

const throwFetch = (error: Error): { fetchFn: typeof globalThis.fetch; calls: FetchCall[] } =>
  recordingFetch(() => error);

const tempRoot = await mkdtemp(path.join(tmpdir(), 'openai-compatible-'));

const writeTempFile = async (filename: string, bytes: number | Buffer): Promise<string> => {
  const filepath = path.join(tempRoot, filename);
  const data = typeof bytes === 'number' ? Buffer.alloc(bytes) : bytes;
  await writeFile(filepath, data);
  return filepath;
};

before(async () => {
  // Ensure temp root exists for all tests.
  await writeTempFile('.keep', 0);
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const supportedImageExtensions = ['.jpg', '.jpeg', '.png', '.webp'] as const;
const supportedAudioExtensions = ['.wav', '.mp3'] as const;
const supportedVideoExtensions = ['.mp4', '.mpeg', '.mov', '.webm'] as const;
const supportedMimeByExtension: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mp3',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mov': 'video/mov',
  '.webm': 'video/webm'
};

const successBody = (text: string): unknown => ({
  choices: [{ message: { content: text } }]
});

test('pre-aborted caller throws cancelled with no fetch and no config or request access', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const hostileConfig = config();
  Object.defineProperty(hostileConfig, 'modelAllowlist', {
    get: () => unexpectedAccess('modelAllowlist')
  });
  const provider = new OpenAICompatibleRecognitionProvider(hostileConfig, fetchFn);
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
  assert.equal(calls.length, 0);
});

test('allowlist uses exact equality and rejects before filepath or fetch work', async () => {
  const accepted = recordingFetch(() => jsonResponse(successBody('recognized')));
  const acceptedProvider = new OpenAICompatibleRecognitionProvider(
    config({ modelAllowlist: ['Allowed-Model'] }),
    accepted.fetchFn
  );
  const acceptedFilepath = await writeTempFile('accept.jpg', Buffer.from('x'));
  const acceptedResult = await acceptedProvider.recognize(
    request({ model: 'Allowed-Model', filepath: acceptedFilepath })
  );
  assert.deepEqual(acceptedResult, { text: 'recognized' });
  assert.equal(accepted.calls.length, 1);

  const rejected = throwFetch(new Error('should not be reached'));
  const rejectedProvider = new OpenAICompatibleRecognitionProvider(
    config({ modelAllowlist: ['Allowed-Model'] }),
    rejected.fetchFn
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
  assert.equal(rejected.calls.length, 0);
});

test('allowlist rejection safe message never echoes requested, default, allowed models, or credentials', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({
      apiKey: LEAKED_KEY_FRAGMENT,
      model: 'Default-Model',
      modelAllowlist: ['Allowed-One', 'Allowed-Two']
    }),
    fetchFn
  );
  const failure = await captureFailure(provider, request({ model: 'Requested-Model' }));
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is not allowed.');
  for (const leaked of [
    'Requested-Model',
    'Default-Model',
    'Allowed-One',
    'Allowed-Two',
    LEAKED_KEY_FRAGMENT
  ]) {
    assert.equal(failure.safeMessage.includes(leaked), false, `safeMessage leaked: ${leaked}`);
  }
  assert.equal(calls.length, 0);
});

test('every supported media pair reaches fetch with exact MIME and content part', async () => {
  const cases: readonly (readonly [MediaKind, string, 'image' | 'audio' | 'video'])[] = [
    ...supportedImageExtensions.map(ext => ['image', ext, 'image'] as const),
    ...supportedAudioExtensions.map(ext => ['audio', ext, 'audio'] as const),
    ...supportedVideoExtensions.map(ext => ['video', ext, 'video'] as const)
  ];
  for (const [mediaKind, extension, _tag] of cases) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`fixture${extension}`, Buffer.from('payload'));
    const result = await provider.recognize(request({ filepath, mediaKind }));
    assert.deepEqual(result, { text: 'ok' });
    assert.equal(calls.length, 1);
    const init = calls[0]?.init;
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    const parts = body.messages[0]?.content ?? [];
    const textPart = parts[0];
    const mediaPart = parts[1];
    assert.equal(textPart?.type, 'text');
    assert.equal(mediaPart?.type === 'image_url'
      || mediaPart?.type === 'input_audio'
      || mediaPart?.type === 'video_url', true);
    const expectedMime = supportedMimeByExtension[extension];
    assert.ok(expectedMime, `unknown extension ${extension}`);
    if (mediaPart?.type === 'image_url') {
      const url = String((mediaPart.image_url as { url: string }).url);
      assert.equal(url.startsWith(`data:${expectedMime};base64,`), true);
    } else if (mediaPart?.type === 'video_url') {
      const url = String((mediaPart.video_url as { url: string }).url);
      assert.equal(url.startsWith(`data:${expectedMime};base64,`), true);
    } else if (mediaPart?.type === 'input_audio') {
      const data = String((mediaPart.input_audio as { data: string }).data);
      assert.equal(data.startsWith('data:'), false);
      const format = (mediaPart.input_audio as { format: string }).format;
      assert.equal(['wav', 'mp3'].includes(format), true);
      assert.equal(supportedMimeByExtension[extension], `audio/${format}`);
    }
  }
});

test('uppercase extensions are normalized to lowercase MIME and content part', async () => {
  for (const [mediaKind, upper] of [['image', '.JPG'], ['audio', '.WAV'], ['video', '.MOV']] as const) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`fixture${upper}`, Buffer.from('payload'));
    await provider.recognize(request({ filepath, mediaKind }));
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: { content: Record<string, unknown>[] }[];
    };
    const mediaPart = body.messages[0]?.content[1];
    if (mediaKind === 'image') {
      const url = String((mediaPart?.image_url as { url: string }).url);
      assert.equal(url.startsWith('data:image/jpeg;base64,'), true);
    } else if (mediaKind === 'audio') {
      const format = (mediaPart?.input_audio as { format: string }).format;
      assert.equal(format, 'wav');
    } else {
      const url = String((mediaPart?.video_url as { url: string }).url);
      assert.equal(url.startsWith('data:video/mov;base64,'), true);
    }
  }
});

test('unsupported, wrong-kind, and missing extensions throw unsupported-media with zero fetch', async () => {
  const cases: readonly (readonly [MediaKind, string])[] = [
    ['image', '.gif'],
    ['image', '.avi'],
    ['audio', '.gif'],
    ['video', '.avi'],
    ['video', '.gif'],
    ['image', '.mp3'],
    ['audio', '.png'],
    ['video', '.wav'],
    ['image', '']
  ];
  let caseIndex = 0;
  for (const [mediaKind, extension] of cases) {
    caseIndex += 1;
    const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    // Use a real file in tempRoot so canonical containment passes and the extension check is what rejects.
    const filename = extension === ''
      ? `unsupported-${caseIndex}-noext`
      : `unsupported-${caseIndex}${extension}`;
    const filepath = await writeTempFile(filename, Buffer.from('payload'));
    const failure = await captureFailure(
      provider,
      request({ filepath, mediaKind })
    );
    assert.equal(failure.category, 'unsupported-media', `extension=${extension} kind=${mediaKind}`);
    assert.equal(calls.length, 0);
  }
});

test('file size equal to maxInlineMediaBytes reaches fetch', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ maxInlineMediaBytes: 64 }),
    fetchFn
  );
  const filepath = await writeTempFile('boundary.jpg', 64);
  const result = await provider.recognize(request({ filepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('file size plus one throws unsupported-media before read or fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ maxInlineMediaBytes: 64 }),
    fetchFn
  );
  const filepath = await writeTempFile('oversize.jpg', 65);
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'unsupported-media');
  assert.equal(calls.length, 0);
});

test('request is a single POST to config.baseUrl with bearer, JSON, redirect manual, no attribution', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const baseUrl = new URL('https://example.test/v1/chat/completions');
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ apiKey: 'sk-test-bearer', baseUrl }),
    fetchFn
  );
  const filepath = await writeTempFile('bearer.png', Buffer.from('payload'));
  await provider.recognize(request({ filepath, mediaKind: 'image', prompt: 'PROMPT-SECRET' }));
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(String(call?.input), baseUrl.toString());
  const init = call?.init;
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'manual');
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test-bearer');
  assert.equal(headers['Content-Type'], 'application/json');
  for (const forbidden of [
    'HTTP-Referer',
    'X-OpenRouter-Title',
    'X-Title',
    'X-Request-Id'
  ]) {
    assert.equal(Object.keys(headers).some(k => k.toLowerCase() === forbidden.toLowerCase()), false);
  }
  const body = JSON.parse(String(init?.body)) as {
    model: string;
    stream: boolean;
    messages: { role: string; content: Record<string, unknown>[] }[];
  };
  assert.equal(body.model, 'configured-model');
  assert.equal(body.stream, false);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[0]?.content[0]?.type, 'text');
  assert.equal(body.messages[0]?.content[0]?.text, 'PROMPT-SECRET');
  const second = body.messages[0]?.content[1];
  assert.equal(second?.type, 'image_url');
});

test('request uses explicit model override and preserves text-first order', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('order.jpg', Buffer.from('payload'));
  await provider.recognize(
    request({ filepath, mediaKind: 'image', model: 'explicit-override', prompt: 'hello' })
  );
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    model: string;
    messages: { content: Record<string, unknown>[] }[];
  };
  assert.equal(body.model, 'explicit-override');
  assert.equal(body.messages[0]?.content[0]?.type, 'text');
  assert.equal(body.messages[0]?.content[1]?.type, 'image_url');
});

test('success returns original untrimmed text without provider fields', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    choices: [{ message: { content: '  exact-text  ' } }]
  }));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('success.jpg', Buffer.from('payload'));
  const result = await provider.recognize(request({ filepath }));
  assert.deepEqual(result, { text: '  exact-text  ' });
});

test('whitespace-only content throws malformed-response without flattening', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    choices: [{ message: { content: '   \n\t  ' } }]
  }));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('ws.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'malformed-response');
});

test('non-string, null, array, object, and missing content throw malformed-response', async () => {
  for (const content of [null, 42, true, false, ['text'], { foo: 'bar' }]) {
    const { fetchFn } = recordingFetch(() => jsonResponse({
      choices: [{ message: { content } }]
    }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`bad-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `content=${JSON.stringify(content)}`);
  }
  for (const body of [
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: '' } }] },
    { not_choices: [] }
  ]) {
    const { fetchFn } = recordingFetch(() => jsonResponse(body));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`shape-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `body=${JSON.stringify(body)}`);
  }
});

test('finish_reason error and choice-level error markers throw malformed-response', async () => {
  for (const choice of [
    { finish_reason: 'error', message: { content: 'partial' } },
    { error: { code: 500, message: 'INJECTED-SECRET' }, message: { content: 'partial' } }
  ]) {
    const { fetchFn } = recordingFetch(() => jsonResponse({ choices: [choice] }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`marker-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `choice=${JSON.stringify(choice)}`);
  }
});

test('invalid and empty 2xx JSON throws malformed-response', async () => {
  for (const body of ['not-json', '', '   ']) {
    const { fetchFn } = recordingFetch(() => new Response(body, { status: 200 }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`json-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'malformed-response', `body=${JSON.stringify(body)}`);
  }
});

test('error_type table maps every row and precedence beats HTTP status', async () => {
  const cases: readonly (readonly [string, string, number])[] = [
    ['authentication', 'authentication', 401],
    ['permission_denied', 'permission', 403],
    ['payment_required', 'billing', 402],
    ['rate_limit_exceeded', 'rate-limit', 429],
    ['provider_overloaded', 'temporary-service', 503],
    ['provider_unavailable', 'temporary-service', 502],
    ['server', 'temporary-service', 500],
    ['timeout', 'timeout', 504],
    ['content_policy_violation', 'safety', 400],
    ['refusal', 'safety', 400],
    ['invalid_image', 'unsupported-media', 400],
    ['image_too_large', 'unsupported-media', 400],
    ['image_too_small', 'unsupported-media', 400],
    ['unsupported_image_format', 'unsupported-media', 400],
    ['image_not_found', 'unsupported-media', 404],
    ['image_download_failed', 'unsupported-media', 400],
    ['context_length_exceeded', 'invalid-request', 400],
    ['max_tokens_exceeded', 'invalid-request', 400],
    ['token_limit_exceeded', 'invalid-request', 400],
    ['string_too_long', 'invalid-request', 400],
    ['invalid_request', 'invalid-request', 400],
    ['invalid_prompt', 'invalid-request', 400],
    ['not_found', 'invalid-request', 404],
    ['precondition_failed', 'invalid-request', 412],
    ['payload_too_large', 'invalid-request', 413],
    ['unprocessable', 'invalid-request', 422]
  ];
  for (const [errorType, expectedCategory, status] of cases) {
    const { fetchFn } = recordingFetch(() => jsonResponse({
      error: {
        code: status,
        message: 'INJECTED-SECRET',
        metadata: { error_type: errorType, provider_code: 'INJECTED-CODE' }
      }
    }, status));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`err-${errorType}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, expectedCategory, `error_type=${errorType}`);
    assert.equal(failure.status, status);
    assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
    assert.equal(failure.safeMessage.includes('INJECTED-CODE'), false);
  }
});

test('unmapped error_type falls through to HTTP-status fallback', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    error: { code: 401, message: 'INJECTED', metadata: { error_type: 'unmapped' } }
  }, 401));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('unmapped.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'authentication');
  assert.equal(failure.status, 401);
});

test('choice-level error_type precedence beats HTTP status', async () => {
  const { fetchFn } = recordingFetch(() => jsonResponse({
    choices: [
      {
        error: {
          code: 500,
          message: 'INJECTED-SECRET',
          metadata: { error_type: 'rate_limit_exceeded' }
        },
        message: { content: 'partial text' }
      }
    ]
  }, 200));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('prec.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'rate-limit');
  assert.equal(failure.status, 200);
  assert.equal(failure.safeMessage.includes('partial text'), false);
});

test('HTTP-status fallback maps every named status and 4xx/5xx catch-alls', async () => {
  const cases: readonly (readonly [number, string])[] = [
    [400, 'invalid-request'],
    [401, 'authentication'],
    [402, 'billing'],
    [403, 'permission'],
    [404, 'invalid-request'],
    [408, 'timeout'],
    [412, 'invalid-request'],
    [413, 'invalid-request'],
    [415, 'unsupported-media'],
    [422, 'invalid-request'],
    [429, 'rate-limit'],
    [500, 'temporary-service'],
    [502, 'temporary-service'],
    [503, 'temporary-service'],
    [504, 'timeout'],
    [418, 'invalid-request'],
    [524, 'temporary-service'],
    [529, 'temporary-service'],
    [418, 'invalid-request'],
    [599, 'temporary-service']
  ];
  for (const [status, expectedCategory] of cases) {
    const { fetchFn } = recordingFetch(() => jsonResponse({
      error: { code: status, message: 'INJECTED', metadata: { provider_code: 'INJECTED-CODE' } }
    }, status));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`http-${status}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, expectedCategory, `status=${status}`);
    assert.equal(failure.status, status);
    assert.equal(failure.safeMessage.includes('INJECTED'), false);
  }
});

test('3xx rejects as unknown with one original-origin fetch and no second attempt', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { fetchFn, calls } = recordingFetch(() => new Response(null, { status }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`redir-${status}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'unknown', `status=${status}`);
    assert.equal(failure.status, status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.redirect, 'manual');
  }
});

test('Retry-After accepts finite decimal seconds; invalid values are omitted; no second fetch', async () => {
  for (const [headerValue, expected] of [
    ['0', 0],
    ['1', 1000],
    ['60', 60000],
    ['1.5', 1500]
  ] as const) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse({
      error: { code: 429, message: 'INJECTED', metadata: { error_type: 'rate_limit_exceeded' } }
    }, 429, { 'retry-after': headerValue }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`ra-${headerValue}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'rate-limit');
    assert.equal(failure.retryAfterMs, expected);
    assert.equal(calls.length, 1);
  }
  for (const headerValue of ['-1', 'abc', 'tomorrow', '1e10', '', '   ']) {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse({
      error: { code: 429, message: 'INJECTED', metadata: { error_type: 'rate_limit_exceeded' } }
    }, 429, { 'retry-after': headerValue }));
    const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
    const filepath = await writeTempFile(`ra-bad-${Math.random()}.jpg`, Buffer.from('payload'));
    const failure = await captureFailure(provider, request({ filepath }));
    assert.equal(failure.category, 'rate-limit');
    assert.equal(failure.retryAfterMs, undefined);
    assert.equal(calls.length, 1);
  }
});

test('unowned fetch throw maps to network with non-enumerable cause', async () => {
  const cause = new Error('DNS lookup failed INJECTED-SECRET');
  const { fetchFn, calls } = throwFetch(cause);
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('net.jpg', Buffer.from('payload'));
  const failure = await captureFailure(provider, request({ filepath }));
  assert.equal(failure.category, 'network');
  assert.equal(failure.cause, cause);
  assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable, false);
  assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
  assert.equal(calls.length, 1);
});

test('caller mid-call abort after fetch begins maps to cancelled with CALLER_CANCELLED', async () => {
  const controller = new AbortController();
  const cause = new Error('aborted INJECTED-SECRET');
  cause.name = 'AbortError';
  const { fetchFn, calls } = recordingFetch(() => {
    controller.abort();
    throw cause;
  });
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('abort.jpg', Buffer.from('payload'));
  const failure = await captureFailure(
    provider,
    request({ filepath }),
    controller.signal
  );
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
  assert.equal(calls.length, 1);
  assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
});

test('public failure text and serialization never include credentials, prompts, models, paths, body, or status text', async () => {
  const secretKey = `sk-${LEAKED_KEY_FRAGMENT}-secret`;
  const secretPrompt = `describe ${LEAKED_PROMPT_FRAGMENT}`;
  const secretModel = LEAKED_MODEL_FRAGMENT;
  const secretFilepath = await writeTempFile('redact.jpg', Buffer.from('payload'));
  const secretPathFragment = LEAKED_PATH_FRAGMENT;
  const { fetchFn } = recordingFetch(() => jsonResponse({
    error: {
      code: 429,
      message: 'INJECTED-UPSTREAM-MESSAGE',
      metadata: { error_type: 'rate_limit_exceeded', provider_code: 'INJECTED-CODE' }
    }
  }, 429, { 'retry-after': '60' }));
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ apiKey: secretKey, model: secretModel }),
    fetchFn
  );
  const failure = await captureFailure(
    provider,
    request({ filepath: secretFilepath, prompt: secretPrompt, model: secretModel })
  );
  const publicText = [
    failure.safeMessage,
    JSON.stringify(failure),
    JSON.stringify({ ...failure })
  ].join('|');
  for (const secret of [
    secretKey,
    secretPrompt,
    secretModel,
    secretPathFragment,
    secretFilepath,
    'INJECTED-UPSTREAM-MESSAGE',
    'INJECTED-CODE',
    secretPathFragment
  ]) {
    assert.equal(publicText.includes(secret), false, `leaked: ${secret}`);
  }
});

test('adapter source uses incremental reader and excludes forbidden behaviors and tokens', async () => {
  const source = await readFile(
    path.resolve(process.cwd(), 'src/services/openai-compatible-recognition-provider.ts'),
    'utf8'
  );
  assert.match(source, /getReader\(\)/u);
  assert.match(source, /new TextDecoder\(\)/u);
  assert.match(source, /setTimeout/u);
  assert.match(source, /clearTimeout/u);
  assert.match(source, /realpath/u);
  assert.match(source, /\[\.\.\.value\]\.length/u);
  assert.match(source, /Provider response exceeded the configured size limit\./u);
  assert.doesNotMatch(source, /response\.text\(\)/u);
  assert.doesNotMatch(source, /response\.arrayBuffer\(\)/u);
  for (const token of [
    /\bfallback\b/iu,
    /\bcooldown\b/iu,
    /\brouting\b/iu,
    /\bparallel\b/iu,
    /\bthrottl/iu,
    /\bcache\b/iu,
    /\btelemetry\b/iu,
    /AbortSignal\.any/u
  ]) {
    assert.doesNotMatch(source, token, `forbidden token in source: ${token}`);
  }
  // Retry-After diagnostic parsing is allowed; no automated retry logic may appear.
  assert.doesNotMatch(source, /\bretry\s*\(/iu);
  assert.doesNotMatch(source, /setTimeout\s*\(\s*retry/iu);
  assert.match(source, /\bredirect: 'manual'/u);
  assert.match(source, /video\/mov/u);
  assert.match(source, /audio\/mp3/u);
});

// =============================================================================
// Phase 4b: abort ownership, bounded reading, identifier validation, containment
// =============================================================================

// Local helper: capture failure with explicit options (Phase 4b needs signal control).
const captureFailureWithOptions = async (
  provider: OpenAICompatibleRecognitionProvider,
  recognitionRequest: RecognitionRequest,
  options?: ProviderCallOptions
): Promise<ProviderFailure> => {
  try {
    await provider.recognize(recognitionRequest, options);
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return error as ProviderFailure;
  }
};

// Local helper: a ReadableStream with read/cancel counters and on-demand chunks.
const createControlledStream = (): {
  body: ReadableStream<Uint8Array>;
  readStarted: Promise<void>;
  readCount: () => number;
  cancelCount: () => number;
  enqueueChunk: (chunk: Uint8Array) => void;
  closeStream: () => void;
} => {
  const state = { readCount: 0, cancelCount: 0 };
  let resolveReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    resolveReadStarted = resolve;
  });
  const queue: { chunk: Uint8Array | null }[] = [];
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined || next.chunk === null) {
          controller.close();
        } else {
          controller.enqueue(next.chunk);
        }
      } else if (closed) {
        controller.close();
      }
      // else: keep waiting for more data
    },
    cancel() {
      state.cancelCount += 1;
    }
  });
  // Wrap getReader to count read() calls.
  const origGetReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, 'getReader', {
    value: () => {
      const reader = origGetReader();
      const origRead = reader.read.bind(reader);
      Object.defineProperty(reader, 'read', {
        value: async () => {
          state.readCount += 1;
          resolveReadStarted?.();
          return origRead();
        }
      });
      return reader;
    },
    configurable: true
  });
  return {
    body: stream,
    readStarted,
    readCount: () => state.readCount,
    cancelCount: () => state.cancelCount,
    enqueueChunk: (chunk) => {
      queue.push({ chunk });
    },
    closeStream: () => {
      closed = true;
      queue.push({ chunk: null });
    }
  };
};

// Local helper: a fetch that waits for the composed signal to abort.
const waitingFetch = (): typeof globalThis.fetch => {
  const fetchFn: typeof globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error('no signal'));
        return;
      }
      const onAbort = (): void => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }) as typeof globalThis.fetch;
  return fetchFn;
};

test('pre-aborted caller does zero model, path, read, timer, or fetch work', async () => {
  const fetchFn: typeof globalThis.fetch = (async () => {
    assert.fail('fetch must not be reached');
  }) as typeof globalThis.fetch;
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const controller = new AbortController();
  controller.abort();
  const hostileRequest = {
    get filepath(): string { return unexpectedAccess('filepath'); },
    get prompt(): string { return unexpectedAccess('prompt'); },
    get mediaKind(): 'image' { return unexpectedAccess('mediaKind'); },
    get model(): string { return unexpectedAccess('model'); }
  } as RecognitionRequest;
  const failure = await captureFailureWithOptions(
    provider,
    hostileRequest,
    { signal: controller.signal }
  );
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
});

test('caller abort during local preparation is observed before fetch', async () => {
  const controller = new AbortController();
  const { fetchFn, calls } = throwFetch(new Error('fetch must not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('abort-preparation.jpg', Buffer.from('payload'));

  const recognizePromise = provider.recognize(
    request({ filepath }),
    { signal: controller.signal }
  );
  // recognize() has reached its first filesystem await before returning its promise.
  controller.abort();

  let failure: ProviderFailure;
  try {
    await recognizePromise;
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    failure = error as ProviderFailure;
  }
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
  assert.equal(calls.length, 0);
});

test('caller abort during pending fetch yields CALLER_CANCELLED with one fetch and no listener leak', async () => {
  const controller = new AbortController();
  const waiting = waitingFetch();
  let fetchCalls = 0;
  let resolveFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    resolveFetchStarted = resolve;
  });
  const countingFetch: typeof globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    fetchCalls += 1;
    resolveFetchStarted?.();
    return waiting(input, init);
  }) as typeof globalThis.fetch;
  const provider = new OpenAICompatibleRecognitionProvider(config(), countingFetch);
  const filepath = await writeTempFile('abortfetch.jpg', Buffer.from('payload'));

  const recognizePromise = provider.recognize(
    request({ filepath }),
    { signal: controller.signal }
  );
  await fetchStarted;
  const beforeAbort = getEventListeners(controller.signal, 'abort').length;
  controller.abort();

  let failure: ProviderFailure;
  try {
    await recognizePromise;
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    failure = error as ProviderFailure;
  }
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
  assert.equal(fetchCalls, 1);
  const afterAbort = getEventListeners(controller.signal, 'abort').length;
  assert.equal(afterAbort, beforeAbort - 1, 'caller abort listener must be removed');
});

test('caller abort during pending body read yields CALLER_CANCELLED and cancels the active reader', async () => {
  const controller = new AbortController();
  const { body, readStarted, cancelCount } = createControlledStream();
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const { fetchFn, calls } = recordingFetch(() => response);
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('abortread.jpg', Buffer.from('payload'));

  const recognizePromise = provider.recognize(
    request({ filepath }),
    { signal: controller.signal }
  );
  await readStarted;
  const beforeAbort = getEventListeners(controller.signal, 'abort').length;
  controller.abort();

  let failure: ProviderFailure;
  try {
    await recognizePromise;
    assert.fail('expected provider failure');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    failure = error as ProviderFailure;
  }
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.code, 'CALLER_CANCELLED');
  assert.equal(calls.length, 1);
  assert.equal(cancelCount(), 1, 'reader must be cancelled exactly once');
  const afterAbort = getEventListeners(controller.signal, 'abort').length;
  assert.equal(afterAbort, beforeAbort - 1, 'caller abort listener must be removed');
});

test('rejecting reader cancellation is handled during caller abort', async () => {
  const controller = new AbortController();
  const cancelError = new Error('cancel failed');
  let resolveReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    resolveReadStarted = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    cancel: async () => {
      throw cancelError;
    }
  });
  const originalGetReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, 'getReader', {
    value: () => {
      const reader = originalGetReader();
      const originalRead = reader.read.bind(reader);
      Object.defineProperty(reader, 'read', {
        value: async () => {
          resolveReadStarted?.();
          return originalRead();
        }
      });
      return reader;
    },
    configurable: true
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const { fetchFn } = recordingFetch(() => response);
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('reject-cancel.jpg', Buffer.from('payload'));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const recognizePromise = provider.recognize(
      request({ filepath }),
      { signal: controller.signal }
    );
    await readStarted;
    controller.abort();

    let failure: ProviderFailure;
    try {
      await recognizePromise;
      assert.fail('expected provider failure');
    } catch (error) {
      assert.equal(error instanceof Error, true);
      failure = error as ProviderFailure;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(failure.category, 'cancelled');
    assert.equal(failure.code, 'CALLER_CANCELLED');
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('timer abort during fetch yields ADAPTER_TIMEOUT with one fetch', async () => {
  const fetchFn = waitingFetch();
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ requestTimeoutSeconds: 1 }),
    fetchFn
  );
  const filepath = await writeTempFile('timerfetch.jpg', Buffer.from('payload'));
  const start = Date.now();
  const failure = await captureFailureWithOptions(provider, request({ filepath }));
  const elapsed = Date.now() - start;
  assert.equal(failure.category, 'timeout');
  assert.equal(failure.code, 'ADAPTER_TIMEOUT');
  assert.ok(elapsed >= 900, `expected ~1s timer, got ${elapsed}ms`);
  assert.ok(elapsed < 3000, `expected <3s, got ${elapsed}ms`);
});

test('timer abort during body read yields ADAPTER_TIMEOUT and cancels the active reader', async () => {
  const { body, cancelCount } = createControlledStream();
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const { fetchFn, calls } = recordingFetch(() => response);
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ requestTimeoutSeconds: 1 }),
    fetchFn
  );
  const filepath = await writeTempFile('timerread.jpg', Buffer.from('payload'));
  const start = Date.now();
  const failure = await captureFailureWithOptions(provider, request({ filepath }));
  const elapsed = Date.now() - start;
  assert.equal(failure.category, 'timeout');
  assert.equal(failure.code, 'ADAPTER_TIMEOUT');
  assert.equal(calls.length, 1);
  assert.ok(elapsed >= 900, `expected ~1s timer, got ${elapsed}ms`);
  assert.ok(elapsed < 3000, `expected <3s, got ${elapsed}ms`);
  assert.equal(cancelCount() >= 1, true, 'reader must be cancelled when timer aborts');
});

test('abort-like unowned fetch throw with AbortError name remains network', async () => {
  const cause = new Error('aborted INJECTED-SECRET');
  cause.name = 'AbortError';
  const { fetchFn, calls } = throwFetch(cause);
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('abortlike.jpg', Buffer.from('payload'));
  const failure = await captureFailureWithOptions(provider, request({ filepath }));
  assert.equal(failure.category, 'network');
  assert.equal(failure.code, undefined);
  assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
  assert.equal(calls.length, 1);
});

test('abort-like unowned body read rejection with AbortError name remains network', async () => {
  const { body } = createControlledStream();
  // Wrap the body to make read() reject with an AbortError-like error.
  const origGetReader = body.getReader.bind(body);
  Object.defineProperty(body, 'getReader', {
    value: () => {
      const reader = origGetReader();
      // Bind to keep the original read accessible in scope; the wrapper always rejects
      // so the original read is intentionally unused here.
      const _origRead = reader.read.bind(reader);
      void _origRead;
      Object.defineProperty(reader, 'read', {
        value: async () => {
          const err = new Error('aborted INJECTED-SECRET');
          err.name = 'AbortError';
          throw err;
        }
      });
      return reader;
    },
    configurable: true
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const { fetchFn } = recordingFetch(() => response);
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('abortbody.jpg', Buffer.from('payload'));
  const failure = await captureFailureWithOptions(provider, request({ filepath }));
  assert.equal(failure.category, 'network');
  assert.equal(failure.code, undefined);
  assert.equal(failure.safeMessage.includes('INJECTED-SECRET'), false);
});

test('caller abort listener is removed after success', async () => {
  const controller = new AbortController();
  const { fetchFn } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('cleanup.jpg', Buffer.from('payload'));
  const before = getEventListeners(controller.signal, 'abort').length;
  await provider.recognize(request({ filepath }), { signal: controller.signal });
  const after = getEventListeners(controller.signal, 'abort').length;
  assert.equal(after, before, 'caller abort listener must be removed after success');
});

test('caller abort listener is removed after redirect rejection', async () => {
  const controller = new AbortController();
  const { fetchFn } = recordingFetch(() => new Response(null, { status: 301 }));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('cleanup-redir.jpg', Buffer.from('payload'));
  const before = getEventListeners(controller.signal, 'abort').length;
  await captureFailureWithOptions(
    provider,
    request({ filepath }),
    { signal: controller.signal }
  );
  const after = getEventListeners(controller.signal, 'abort').length;
  assert.equal(after, before, 'caller abort listener must be removed after redirect');
});

test('response exactly at maxResponseBytes reaches parse; first byte over cancels the reader', async () => {
  // Chunks: first at exact cap, second would exceed, third must never be read.
  const chunks: Uint8Array[] = [
    new Uint8Array(10),
    new Uint8Array(1),
    new Uint8Array(100)
  ];
  const state = { readCount: 0, cancelCount: 0 };
  const preEnqueuedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
    cancel() {
      state.cancelCount += 1;
    }
  });
  const origGetReader = preEnqueuedStream.getReader.bind(preEnqueuedStream);
  Object.defineProperty(preEnqueuedStream, 'getReader', {
    value: () => {
      const reader = origGetReader();
      const origRead = reader.read.bind(reader);
      Object.defineProperty(reader, 'read', {
        value: async () => {
          state.readCount += 1;
          return origRead();
        }
      });
      return reader;
    },
    configurable: true
  });

  const response = new Response(preEnqueuedStream, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const { fetchFn } = recordingFetch(() => response);
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ maxResponseBytes: 10 }),
    fetchFn
  );
  const filepath = await writeTempFile('cap.jpg', Buffer.from('payload'));
  const failure = await captureFailureWithOptions(provider, request({ filepath }));
  assert.equal(failure.category, 'malformed-response');
  assert.equal(failure.safeMessage, 'Provider response exceeded the configured size limit.');
  assert.equal(state.readCount, 2, 'must not read more than the cap-exceed chunk');
  assert.equal(state.cancelCount, 1, 'reader must be cancelled once');
});

test('response exactly at maxResponseBytes with single chunk is accepted for parse', async () => {
  // Use a valid JSON of exactly the cap size so parse can succeed.
  const validJson = '{"choices":[{"message":{"content":"ok"}}]}';
  const jsonBytes = new TextEncoder().encode(validJson);
  assert.equal(jsonBytes.byteLength, 42, 'fixture must be exactly 42 bytes');
  const chunks: Uint8Array[] = [jsonBytes];
  const state = { readCount: 0, cancelCount: 0 };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
    cancel() {
      state.cancelCount += 1;
    }
  });
  const origGetReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, 'getReader', {
    value: () => {
      const reader = origGetReader();
      const origRead = reader.read.bind(reader);
      Object.defineProperty(reader, 'read', {
        value: async () => {
          state.readCount += 1;
          return origRead();
        }
      });
      return reader;
    },
    configurable: true
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const { fetchFn } = recordingFetch(() => response);
  const provider = new OpenAICompatibleRecognitionProvider(
    config({ maxResponseBytes: 42 }),
    fetchFn
  );
  const filepath = await writeTempFile('exactcap.jpg', Buffer.from('payload'));
  const result = await provider.recognize(request({ filepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(state.readCount, 2); // one for the chunk, one for done
  assert.equal(state.cancelCount, 0);
});

test('call-time model accepts exactly 200 Unicode scalar values', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('model200.jpg', Buffer.from('payload'));
  const model200 = 'a'.repeat(200);
  const result = await provider.recognize(request({ model: model200, filepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('call-time model rejects 201 Unicode scalar values before file or fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('model201.jpg', Buffer.from('payload'));
  const model201 = 'a'.repeat(201);
  const failure = await captureFailureWithOptions(
    provider,
    request({ model: model201, filepath })
  );
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'Requested model is invalid.');
  assert.equal(calls.length, 0);
});

test('call-time model counts astral scalars as one code point', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('astral.jpg', Buffer.from('payload'));
  // 😀 is U+1F600, one astral scalar.
  const model = '😀'.repeat(200);
  const result = await provider.recognize(request({ model, filepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('call-time model rejects C0, DEL, U+2028, and U+2029 before file or fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const cases: readonly (readonly [string, string])[] = [
    ['C0 NUL', '\u0000'],
    ['C0 LF', '\u000a'],
    ['C0 CR', '\u000d'],
    ['C0 US', '\u001f'],
    ['DEL', '\u007f'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029']
  ];
  let caseIndex = 0;
  for (const [label, char] of cases) {
    caseIndex += 1;
    const filepath = await writeTempFile(`model-${label}-${caseIndex}.jpg`, Buffer.from('payload'));
    const failure = await captureFailureWithOptions(
      provider,
      request({ model: `goodprefix-${char}-goodsuffix`, filepath })
    );
    assert.equal(failure.category, 'invalid-request', `char=${label}`);
    assert.equal(failure.safeMessage, 'Requested model is invalid.');
  }
  assert.equal(calls.length, 0);
});

test('every public safeMessage is below 4096 UTF-8 bytes with no raw line separators', () => {
  const safeMessages: readonly string[] = [
    'Requested model is not allowed.',
    'Requested model is invalid.',
    'OpenAI-compatible file is not in an allowed media root.',
    'Provider response exceeded the configured size limit.',
    'OpenAI-compatible provider configuration is invalid.',
    'OpenAI-compatible provider authentication failed.',
    'OpenAI-compatible provider permission was denied.',
    'OpenAI-compatible provider billing authorization failed.',
    'OpenAI-compatible provider rejected the request.',
    'OpenAI-compatible provider does not support this media.',
    'OpenAI-compatible provider refused the request for safety reasons.',
    'OpenAI-compatible provider rate limit was reached.',
    'OpenAI-compatible request timed out.',
    'OpenAI-compatible provider is temporarily unavailable.',
    'OpenAI-compatible network request failed.',
    'OpenAI-compatible request was cancelled.',
    'OpenAI-compatible provider returned a malformed response.',
    'OpenAI-compatible request failed.'
  ];
  for (const msg of safeMessages) {
    const bytes = new TextEncoder().encode(msg).byteLength;
    assert.ok(bytes < 4096, `safeMessage exceeds 4096 bytes (${bytes}): ${msg}`);
    assert.equal(msg.includes('\u2028'), false, `safeMessage contains U+2028: ${msg}`);
    assert.equal(msg.includes('\u2029'), false, `safeMessage contains U+2029: ${msg}`);
  }
});

test('canonical containment accepts a regular file directly inside an allowed root', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('inside.jpg', Buffer.from('payload'));
  const result = await provider.recognize(request({ filepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('canonical containment helper is exported as the adapter call-site implementation', async () => {
  const filepath = await writeTempFile('exported-helper.jpg', Buffer.from('payload'));
  assert.equal(await canonicalizeContainedFile(filepath, [tempRoot]), filepath);
  const source = await readFile(
    path.resolve(process.cwd(), 'src/services/openai-compatible-recognition-provider.ts'),
    'utf8'
  );
  assert.match(source, /export const canonicalizeContainedFile = async/u);
  assert.match(source, /await canonicalizeContainedFile\(/u);
});

test('canonical containment accepts a nested file below an allowed root', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const nestedDir = path.join(tempRoot, 'nested');
  await mkdir(nestedDir);
  const filepath = path.join(nestedDir, 'nested.jpg');
  await writeFile(filepath, Buffer.from('payload'));
  const result = await provider.recognize(request({ filepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('canonical containment rejects a directory before fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const failure = await captureFailureWithOptions(
    provider,
    request({ filepath: tempRoot })
  );
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'OpenAI-compatible file is not in an allowed media root.');
  assert.equal(calls.length, 0);
});

test('canonical containment rejects a missing path before fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const missingPath = path.join(tempRoot, 'does-not-exist.jpg');
  const failure = await captureFailureWithOptions(
    provider,
    request({ filepath: missingPath })
  );
  assert.equal(failure.category, 'invalid-request');
  assert.equal(failure.safeMessage, 'OpenAI-compatible file is not in an allowed media root.');
  assert.equal(calls.length, 0);
});

test('canonical containment rejects an outside file before fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'openai-outside-'));
  try {
    const filepath = path.join(outsideRoot, 'outside.jpg');
    await writeFile(filepath, Buffer.from('payload'));
    const failure = await captureFailureWithOptions(
      provider,
      request({ filepath })
    );
    assert.equal(failure.category, 'invalid-request');
    assert.equal(failure.safeMessage, 'OpenAI-compatible file is not in an allowed media root.');
    assert.equal(calls.length, 0);
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('canonical containment rejects traversal to an outside file before fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'openai-outside-'));
  try {
    const outsideFile = path.join(outsideRoot, 'outside.jpg');
    await writeFile(outsideFile, Buffer.from('payload'));
    // Traverse from tempRoot up and into outsideRoot.
    const traversalPath = path.join(
      tempRoot,
      '..',
      path.basename(outsideRoot),
      'outside.jpg'
    );
    const failure = await captureFailureWithOptions(
      provider,
      request({ filepath: traversalPath })
    );
    assert.equal(failure.category, 'invalid-request');
    assert.equal(failure.safeMessage, 'OpenAI-compatible file is not in an allowed media root.');
    assert.equal(calls.length, 0);
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('canonical containment rejects sibling-prefix confusion before fetch', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  // Create a sibling directory whose name starts with tempRoot's name.
  const siblingRoot = `${tempRoot}-sibling`;
  await mkdir(siblingRoot);
  try {
    const siblingFile = path.join(siblingRoot, 'sibling.jpg');
    await writeFile(siblingFile, Buffer.from('payload'));
    const failure = await captureFailureWithOptions(
      provider,
      request({ filepath: siblingFile })
    );
    assert.equal(failure.category, 'invalid-request');
    assert.equal(failure.safeMessage, 'OpenAI-compatible file is not in an allowed media root.');
    assert.equal(calls.length, 0);
  } finally {
    await rm(siblingRoot, { recursive: true, force: true });
  }
});

test('canonical containment accepts an inside link whose target is inside', async () => {
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const target = await writeTempFile('link-target.jpg', Buffer.from('payload'));
  const linkPath = path.join(tempRoot, 'inside-link.jpg');
  try {
    await symlink(target, linkPath);
  } catch (cause) {
    // symlink may fail on Windows without privilege; skip without weakening production.
    console.log(`symlink skipped: ${(cause as Error).message}`);
    return;
  }
  const result = await provider.recognize(request({ filepath: linkPath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('canonical containment rejects an inside link whose target is outside', async () => {
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'openai-outside-'));
  try {
    const target = path.join(outsideRoot, 'outside.jpg');
    await writeFile(target, Buffer.from('payload'));
    const linkPath = path.join(tempRoot, 'outside-link.jpg');
    try {
      await symlink(target, linkPath);
    } catch (cause) {
      // symlink may fail on Windows without privilege; skip without weakening production.
      console.log(`symlink skipped: ${(cause as Error).message}`);
      return;
    }
    const failure = await captureFailureWithOptions(
      provider,
      request({ filepath: linkPath })
    );
    assert.equal(failure.category, 'invalid-request');
    assert.equal(failure.safeMessage, 'OpenAI-compatible file is not in an allowed media root.');
    assert.equal(calls.length, 0);
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('canonical containment is case-insensitive on Windows for separator-aware containment', async function () {
  if (process.platform !== 'win32') {
    // POSIX is case-sensitive; Windows-only test.
    return;
  }
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const filepath = await writeTempFile('case.jpg', Buffer.from('payload'));
  // Request the file with a different case; realpath normalizes case on Windows.
  const upperFilepath = filepath.toUpperCase();
  const result = await provider.recognize(request({ filepath: upperFilepath }));
  assert.deepEqual(result, { text: 'ok' });
  assert.equal(calls.length, 1);
});

test('canonical containment rejects an outside Windows directory junction', async function () {
  if (process.platform !== 'win32') {
    return;
  }
  const { fetchFn, calls } = throwFetch(new Error('should not be reached'));
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn);
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'openai-outside-'));
  const junctionPath = path.join(tempRoot, 'outside-junction');
  try {
    // Directory junction (Windows-specific).
    await symlink(outsideRoot, junctionPath, 'junction');
  } catch (cause) {
    const message = (cause as Error).message;
    const code = (cause as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    console.log(`Windows junction skipped (${code}): ${message}`);
    await rm(outsideRoot, { recursive: true, force: true });
    return;
  }
  try {
    const target = path.join(outsideRoot, 'outside.jpg');
    await writeFile(target, Buffer.from('payload'));
    const failure = await captureFailureWithOptions(
      provider,
      request({ filepath: path.join(junctionPath, 'outside.jpg') })
    );
    assert.equal(failure.category, 'invalid-request');
    assert.equal(failure.safeMessage, 'OpenAI-compatible file is not in an allowed media root.');
    assert.equal(calls.length, 0);
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
    try {
      await rm(junctionPath, { recursive: true, force: true });
    } catch {
      // junction may already be cleaned up
    }
  }
});

test('recognize coalesces overlapping real file preparation and base64 conversion', async () => {
  const filepath = await writeTempFile('coalesced.png', Buffer.from('coalesced bytes'));
  const observedBodies: string[] = [];
  const { fetchFn, calls } = recordingFetch(call => {
    observedBodies.push(String(call.init?.body));
    return jsonResponse(successBody('ok'));
  });
  let reads = 0;
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn, async file => {
    reads += 1;
    return readFile(file);
  });

  const [first, second] = await Promise.all([
    provider.recognize(request({ filepath })),
    provider.recognize(request({ filepath }))
  ]);

  assert.deepEqual([first, second], [{ text: 'ok' }, { text: 'ok' }]);
  assert.equal(reads, 1, 'overlapping recognitions share one real read/base64 preparation');
  assert.equal(calls.length, 2, 'each recognition still dispatches its own upstream request');
  assert.match(observedBodies[0] ?? '', /Y29hbGVzY2VkIGJ5dGVz/u);
  assert.match(observedBodies[1] ?? '', /Y29hbGVzY2VkIGJ5dGVz/u);
});

test('recognize evicts a rejected preparation so a later recognition retries', async () => {
  const filepath = await writeTempFile('retry-read.png', Buffer.from('retry bytes'));
  const { fetchFn, calls } = recordingFetch(() => jsonResponse(successBody('ok')));
  let reads = 0;
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn, async file => {
    reads += 1;
    if (reads === 1) throw new Error('read failed once');
    return readFile(file);
  });

  const firstFailure = await captureFailure(provider, request({ filepath }));
  assert.equal(firstFailure.category, 'unsupported-media');
  assert.deepEqual(await provider.recognize(request({ filepath })), { text: 'ok' });
  assert.equal(reads, 2, 'rejected preparation is evicted before the retry');
  assert.equal(calls.length, 1, 'the failed preparation never reaches fetch');
});

test('recognize reads a replacement at the same path after preparation settles', async () => {
  const filepath = await writeTempFile('replacement.png', Buffer.from('first bytes'));
  const bodies: string[] = [];
  const { fetchFn } = recordingFetch(call => {
    bodies.push(String(call.init?.body));
    return jsonResponse(successBody('ok'));
  });
  let reads = 0;
  const provider = new OpenAICompatibleRecognitionProvider(config(), fetchFn, async file => {
    reads += 1;
    return readFile(file);
  });

  await provider.recognize(request({ filepath }));
  await writeFile(filepath, Buffer.from('second bytes'));
  await provider.recognize(request({ filepath }));

  assert.equal(reads, 2, 'settled preparation is not retained by canonical path');
  assert.match(bodies[0] ?? '', /Zmlyc3QgYnl0ZXM/u);
  assert.match(bodies[1] ?? '', /c2Vjb25kIGJ5dGVz/u);
}); // End R4 coalescing regression coverage.

