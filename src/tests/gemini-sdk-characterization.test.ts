/**
 * status: active
 * phase: change-b-phase-0-task-0.3
 * sprint: sdk-runtime-evidence
 * last_modified: 2026-08-07
 * agent_notes: "Deterministic, credential-free characterization of installed @google/genai; rerun after any SDK resolution change."
 * insights: "v0.9.0 wraps fetch failures without cause, ignores caller signal fields, and owns timeout AbortControllers."
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as genaiNamespace from '@google/genai';
import { GenerateContentResponse, GoogleGenAI, type HttpOptions } from '@google/genai';

const PACKAGE_JSON_PATH = path.resolve(
  process.cwd(),
  'node_modules/@google/genai/package.json'
);
const NODE_BUNDLE_PATH = path.resolve(
  process.cwd(),
  'node_modules/@google/genai/dist/node/index.js'
);
const EXPECTED_VERSION = '0.9.0';
const OVERSIZED_PAYLOAD_LENGTH = 128 * 1024;

interface ErrorRecord {
  name?: unknown;
  message?: unknown;
  cause?: unknown;
  status?: unknown;
  code?: unknown;
  errorDetails?: unknown;
}

interface ErrorBody {
  error: {
    code: number;
    message: string;
    status: string;
    details?: Record<string, string>[];
  };
}

const client = (): GoogleGenAI => new GoogleGenAI({ apiKey: 'fixture-api-key' });

const generate = (
  ai: GoogleGenAI,
  httpOptions?: HttpOptions
): Promise<GenerateContentResponse> => ai.models.generateContent({
  model: 'fixture-model',
  contents: 'fixture prompt',
  config: httpOptions === undefined ? undefined : { httpOptions }
});

const captureThrow = async (operation: () => Promise<unknown>): Promise<ErrorRecord> => {
  try {
    await operation();
    assert.fail('expected operation to throw');
  } catch (error) {
    assert.equal(error instanceof Error, true);
    return error as ErrorRecord;
  }
};

const withFetch = async <T>(
  fakeFetch: typeof globalThis.fetch,
  operation: () => Promise<T>
): Promise<T> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const jsonErrorResponse = (status: number, statusText: string, body: ErrorBody): Response =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' }
  });

const assertSdkEnvelope = (
  error: ErrorRecord,
  expectedName: 'ClientError' | 'ServerError',
  status: number,
  statusText: string,
  body: ErrorBody
): void => {
  const prefix = `got status: ${status} ${statusText}. `;
  assert.equal(error.name, expectedName);
  assert.equal(error.message, `${prefix}${JSON.stringify(body)}`);
  assert.equal('status' in error, false);
  assert.equal('code' in error, false);
  assert.equal('errorDetails' in error, false);

  const message = String(error.message);
  assert.equal(message.startsWith(prefix), true);
  const bodyBoundary = message.slice(prefix.length);
  assert.deepEqual(JSON.parse(bodyBoundary), body);
  assert.equal(`${prefix}${bodyBoundary}`, message);
};

test('resolved package and public namespace are locked to installed @google/genai 0.9.0', async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8')) as {
    version: string;
  };
  const source = await readFile(NODE_BUNDLE_PATH, 'utf8');

  assert.equal(packageJson.version, EXPECTED_VERSION);
  assert.equal(Object.keys(genaiNamespace).length, 70);
  assert.equal('GoogleGenAI' in genaiNamespace, true);
  assert.equal('ClientError' in genaiNamespace, false);
  assert.equal('ServerError' in genaiNamespace, false);
  assert.match(source, /class ClientError extends Error/u);
  assert.match(source, /this\.name = 'ClientError'/u);
  assert.match(source, /class ServerError extends Error/u);
  assert.match(source, /this\.name = 'ServerError'/u);
  assert.doesNotMatch(source, /exports\.ClientError\s*=/u);
  assert.doesNotMatch(source, /exports\.ServerError\s*=/u);
  console.log(`@google/genai resolved version: ${packageJson.version}`);
});

test('429 is one ClientError envelope with typed body fields and one request', async () => {
  const body: ErrorBody = {
    error: {
      code: 429,
      message: 'fixture quota exhausted',
      status: 'RESOURCE_EXHAUSTED',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.RetryInfo',
        retryDelay: '1.250s'
      }]
    }
  };
  let requests = 0;
  const error = await withFetch(async () => {
    requests += 1;
    return jsonErrorResponse(429, 'Too Many Requests', body);
  }, () => captureThrow(() => generate(client())));

  assert.equal(requests, 1);
  assertSdkEnvelope(error, 'ClientError', 429, 'Too Many Requests', body);
  assert.equal(typeof body.error.code, 'number');
  assert.equal(typeof body.error.status, 'string');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.details?.[0]?.retryDelay, 'string');
});

test('503 is one ServerError envelope with typed body fields and one request', async () => {
  const body: ErrorBody = {
    error: {
      code: 503,
      message: 'fixture service unavailable',
      status: 'UNAVAILABLE'
    }
  };
  let requests = 0;
  const error = await withFetch(async () => {
    requests += 1;
    return jsonErrorResponse(503, 'Service Unavailable', body);
  }, () => captureThrow(() => generate(client())));

  assert.equal(requests, 1);
  assertSdkEnvelope(error, 'ServerError', 503, 'Service Unavailable', body);
});

test('403 remains a ClientError even when its body contains retry-looking evidence', async () => {
  const body: ErrorBody = {
    error: {
      code: 403,
      message: 'quota retry billing fixture',
      status: 'RESOURCE_EXHAUSTED',
      details: [{ retryDelay: '2s' }]
    }
  };
  let requests = 0;
  const error = await withFetch(async () => {
    requests += 1;
    return jsonErrorResponse(403, 'Forbidden', body);
  }, () => captureThrow(() => generate(client())));

  assert.equal(requests, 1);
  assertSdkEnvelope(error, 'ClientError', 403, 'Forbidden', body);
});

test('malformed JSON propagates SyntaxError while non-JSON content is replaced by a synthetic envelope', async () => {
  const malformedJson = await withFetch(
    async () => new Response('not-json', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'application/json' }
    }),
    () => captureThrow(() => generate(client()))
  );
  assert.equal(malformedJson.name, 'SyntaxError');
  assert.equal(String(malformedJson.message).startsWith('Unexpected token'), true);
  assert.equal(String(malformedJson.message).includes('got status:'), false);

  const syntheticBody: ErrorBody = {
    error: {
      message: 'exception parsing response',
      code: 429,
      status: 'Too Many Requests'
    }
  };
  const nonJsonContent = await withFetch(
    async () => new Response('raw provider text is discarded', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' }
    }),
    () => captureThrow(() => generate(client()))
  );
  assertSdkEnvelope(
    nonJsonContent,
    'ClientError',
    429,
    'Too Many Requests',
    syntheticBody
  );
  assert.equal(String(nonJsonContent.message).includes('raw provider text'), false);
});

test('oversized JSON body is embedded completely and verbatim with no SDK extraction limit', async () => {
  const marker = 'x'.repeat(OVERSIZED_PAYLOAD_LENGTH);
  const body: ErrorBody = {
    error: {
      code: 429,
      message: marker,
      status: 'RESOURCE_EXHAUSTED'
    }
  };
  const error = await withFetch(
    async () => jsonErrorResponse(429, 'Too Many Requests', body),
    () => captureThrow(() => generate(client()))
  );

  assertSdkEnvelope(error, 'ClientError', 429, 'Too Many Requests', body);
  assert.equal(String(error.message).includes(marker), true);
  assert.equal(
    String(error.message).length,
    'got status: 429 Too Many Requests. '.length + JSON.stringify(body).length
  );
});

test('transport codes in fetch rejection causes are erased by the SDK wrapper', async () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'] as const) {
    const systemError = Object.assign(new Error('fixture system failure'), { code });
    const fetchFailure = new TypeError('fetch failed', { cause: systemError });
    const error = await withFetch(
      async () => Promise.reject(fetchFailure),
      () => captureThrow(() => generate(client()))
    );

    assert.equal(error.name, 'Error');
    assert.equal(error.message, 'exception TypeError: fetch failed sending request');
    assert.equal(error.cause, undefined);
    assert.equal(error.code, undefined);
    assert.equal((error.cause as ErrorRecord | undefined)?.code, undefined);
    assert.equal(
      ((error.cause as ErrorRecord | undefined)?.cause as ErrorRecord | undefined)?.code,
      undefined
    );
    assert.equal(String(error.message).includes(code), false);
  }
});

test('caller AbortSignal is not accepted or threaded to fetch by generateContent', async () => {
  const callerController = new AbortController();
  let capturedSignal: AbortSignal | null | undefined;
  let releaseFetch!: (response: Response) => void;
  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => { fetchStarted = resolve; });
  const response = new Promise<Response>(resolve => { releaseFetch = resolve; });
  const unsupportedOptions = {
    signal: callerController.signal
  } as HttpOptions;

  const operation = withFetch(async (_input, init) => {
    capturedSignal = init?.signal;
    fetchStarted();
    return response;
  }, () => generate(client(), unsupportedOptions));

  await started;
  callerController.abort();
  assert.equal(callerController.signal.aborted, true);
  assert.equal(capturedSignal, undefined);
  releaseFetch(new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  await operation;
});

test('SDK timeout creates its own signal and wraps fetch AbortError without structured identity', async () => {
  let capturedSignal: AbortSignal | null | undefined;
  const error = await withFetch(async (_input, init) => {
    capturedSignal = init?.signal;
    assert.notEqual(capturedSignal, undefined);
    return new Promise<Response>((_resolve, reject) => {
      capturedSignal?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'));
      }, { once: true });
    });
  }, () => captureThrow(() => generate(client(), { timeout: 5 })));

  assert.equal(capturedSignal?.aborted, true);
  assert.equal(error.name, 'Error');
  assert.equal(
    error.message,
    'exception AbortError: This operation was aborted sending request'
  );
  assert.equal(error.cause, undefined);
  assert.equal(error.code, undefined);
  assert.equal(error.status, undefined);
});

test('successful generateContent performs exactly one HTTP request', async () => {
  let requests = 0;
  const result = await withFetch(async () => {
    requests += 1;
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }, () => generate(client()));

  assert.equal(requests, 1);
  assert.equal(result instanceof GenerateContentResponse, true);
});

test('files.upload performs exactly two HTTP requests for a one-chunk Blob', async () => {
  const stages: string[] = [];
  const uploaded = await withFetch(async input => {
    const url = String(input);
    stages.push(url);
    if (stages.length === 1) {
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-goog-upload-url': 'https://upload.fixture/session'
        }
      });
    }
    return new Response(JSON.stringify({
      file: {
        name: 'files/fixture',
        uri: 'gemini://fixture',
        mimeType: 'text/plain'
      }
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-goog-upload-status': 'final'
      }
    });
  }, () => client().files.upload({
    file: new Blob(['fixture'], { type: 'text/plain' })
  }));

  assert.equal(stages.length, 2);
  assert.match(stages[0] ?? '', /generativelanguage\.googleapis\.com\/upload\/v1beta\/files/u);
  assert.equal(stages[1], 'https://upload.fixture/session');
  assert.equal(uploaded.name, 'files/fixture');
});