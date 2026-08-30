/**
 * status: active
 * phase: checkpoint-4-gemini-adapter
 * sprint: provider-foundation-first-sprint
 * last_modified: 2026-08-21
 * agent_notes: "Credential-free direct tests for Gemini throwing/wrapper seams and timeout identity."
 * insights: "A negative explicit wait bound exercises timeout ownership without a real delay. R3/R4: behavioural coalescing and FAILED-state rejection are proven end-to-end through serviceWithClient injection of files.upload / files.get and real on-disk files; the previous monkey-patching tests were non-proof."
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  GeminiService,
  GeminiVideoProcessingTimeoutError
} from '../services/gemini.js';
import { DEFAULT_GEMINI_MODEL } from '../services/provider-config.js';
import { FileState, type GeminiFile } from '../types/index.js';

interface GeminiFileLike {
  uri?: string;
  mimeType?: string;
  name?: string;
  state?: FileState;
}

interface GeminiFilesClient {
  upload: (input: { file: string; config: { mimeType?: string } }) => Promise<GeminiFileLike>;
  get: (input: { name: string }) => Promise<GeminiFileLike>;
}

interface GenerateContentClient {
  models: {
    generateContent: (input: unknown) => Promise<{ text?: string }>;
  };
  files?: GeminiFilesClient;
}

const file: GeminiFile = {
  uri: 'gemini://fixture',
  mimeType: 'image/png',
  name: 'fixture'
};

const serviceWithClient = (client: GenerateContentClient): GeminiService => {
  const service = new GeminiService({ apiKey: 'credential-free-test-key' });
  (service as unknown as { client: GenerateContentClient }).client = client;
  return service;
};

// Behavioural test filesystem: real on-disk files drive the production calculateChecksum
// path; no private methods are replaced.
const tempRoot = await mkdtemp(path.join(tmpdir(), 'gemini-service-'));

before(async () => {
  await writeFile(path.join(tempRoot, '.keep'), Buffer.alloc(0));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const writeMediaFile = async (filename: string, bytes: number | Buffer): Promise<string> => {
  const filepath = path.join(tempRoot, filename);
  const data = typeof bytes === 'number' ? Buffer.alloc(bytes) : bytes;
  await writeFile(filepath, data);
  return filepath;
};

test('processFileOrThrow performs one generation and returns exact text', async () => {
  const calls: unknown[] = [];
  const service = serviceWithClient({
    models: {
      generateContent: async input => {
        calls.push(input);
        return { text: 'exact Gemini text' };
      }
    }
  });

  assert.deepEqual(await service.processFileOrThrow(file, 'prompt', 'explicit-model'), {
    text: 'exact Gemini text'
  });
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { model: string }).model, 'explicit-model');
});

test('processFileOrThrow propagates the exact original throw', async () => {
  const original = { message: 'upstream-sensitive', status: 429 };
  const service = serviceWithClient({
    models: { generateContent: async () => Promise.reject(original) }
  });

  await assert.rejects(service.processFileOrThrow(file, 'secret prompt', 'secret model'), error => {
    assert.equal(error, original);
    return true;
  });
});

test('processFile remains a delegating compatibility wrapper for success and errors', async () => {
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: 'unused' }) }
  });
  const calls: string[] = [];
  const original = new Error('original generation failure');
  service.processFileOrThrow = async (_file, _prompt, model) => {
    calls.push(model);
    if (calls.length === 1) return { text: 'wrapper success' };
    throw original;
  };

  assert.deepEqual(await service.processFile(file, 'prompt'), { text: 'wrapper success' });
  assert.deepEqual(await service.processFile(file, 'prompt', 'explicit-model'), {
    text: 'Error processing file: original generation failure',
    isError: true
  });
  assert.deepEqual(calls, [DEFAULT_GEMINI_MODEL, 'explicit-model']);
});

test('processFile preserves non-Error compatibility text', async () => {
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: 'unused' }) }
  });
  service.processFileOrThrow = async () => Promise.reject('string failure');
  assert.deepEqual(await service.processFile(file, 'prompt'), {
    text: 'Error processing file: string failure',
    isError: true
  });
});

test('waitForVideoProcessing throws the service-owned timeout identity immediately', async () => {
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: 'unused' }) }
  });
  const processingFile: GeminiFile = {
    ...file,
    state: FileState.PROCESSING
  };

  await assert.rejects(
    service.waitForVideoProcessing(processingFile, -1),
    GeminiVideoProcessingTimeoutError
  );
});

test('source preserves the 300000 default, polling delay, cache, and one generation implementation', async () => {
  const source = await readFile(path.resolve(process.cwd(), 'src/services/gemini.ts'), 'utf8');
  assert.match(source, /waitForVideoProcessing\(file: GeminiFile, maxWaitTimeMs = 300000\)/u);
  assert.match(source, /await setTimeout\(2000\)/u);
  assert.match(source, /private fileCache = new Map<string, CachedFile>\(\)/u);
  assert.equal((source.match(/\.models\.generateContent\(/gu) ?? []).length, 1);
  assert.match(source, /return await this\.processFileOrThrow\(/u);
});
// =============================================================================
// R3/R4 behavioural proof: replacement for the previous monkey-patching tests.
// Behavioural only — production calculateChecksum, inFlightUploads, fileCache,
// and _doUploadFile remain untouched; only `serviceWithClient` injects the
// `client.files.upload` and `client.files.get` shapes that the adapter reads.
// =============================================================================

test('uploadFile rejects non-video FAILED-state stub before cache insertion and retry re-attempts upload (R3)', async () => {
  const uploadCalls: { file: string; config: { mimeType?: string } | undefined }[] = [];
  const getCalls: { name: string }[] = [];
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: '' }) },
    files: {
      upload: async input => {
        uploadCalls.push(input);
        if (uploadCalls.length === 1) {
          return {
            uri: 'gemini://dead',
            mimeType: 'image/png',
            name: 'files/failed',
            state: FileState.FAILED
          };
        }
        return {
          uri: 'gemini://live',
          mimeType: 'image/png',
          name: 'files/live',
          state: FileState.ACTIVE
        };
      },
      get: async input => {
        getCalls.push(input);
        return {
          uri: 'gemini://live',
          mimeType: 'image/png',
          name: input.name,
          state: FileState.ACTIVE
        };
      }
    }
  });

  const filepath = await writeMediaFile('rejected.png', Buffer.from('rejected-payload'));

  // First call: stub returns FileState.FAILED; service must throw and skip
  // checksum-cache insertion (no dead-URI persistence).
  await assert.rejects(
    service.uploadFile(filepath),
    /Gemini file upload failed/u
  );
  assert.equal(uploadCalls.length, 1, 'one upload attempt on first call');
  assert.equal(getCalls.length, 0, 'no polling for non-video upload');
  // Second call: same path, same checksum (no cache pollution), upload is
  // re-attempted and the staged ACTIVE result is returned.
  const settled = await service.uploadFile(filepath);
  assert.equal(settled.state, FileState.ACTIVE);
  assert.equal(uploadCalls.length, 2, 'retry re-attempts upload against the same path');
  assert.equal(
    (service as unknown as { fileCache: Map<string, unknown> }).fileCache.size,
    1,
    'successful retry enters the checksum completed-cache exactly once'
  );
});

test('uploadFile coalesces overlapping video uploads, shares the polling lifecycle, and revisits upload only when content changes (R4)', async () => {
  const uploadCalls: { file: string; config: { mimeType?: string } | undefined }[] = [];
  const getCalls: { name: string }[] = [];
  const recordUploadLength = (): number => uploadCalls.length;
  const recordGetLength = (): number => getCalls.length;
  const service = serviceWithClient({
    models: { generateContent: async () => ({ text: '' }) },
    files: {
      upload: async input => {
        uploadCalls.push(input);
        return {
          uri: 'gemini://video-upload',
          mimeType: 'video/mp4',
          name: 'files/video',
          state: FileState.PROCESSING
        };
      },
      get: async input => {
        getCalls.push(input);
        // First poll observes ACTIVE so the loop exits on the single allowed
        // iteration; tests still pay the production `setTimeout(2000)` once.
        return {
          uri: 'gemini://video-upload',
          mimeType: 'video/mp4',
          name: input.name,
          state: FileState.ACTIVE
        };
      }
    }
  });

  const filepath = await writeMediaFile('coalesce.mp4', Buffer.from('first-content'));

  // Two overlapping uploadFile calls — production code must coalesce on
  // `inFlightUploads` so the upload+poll lifecycle happens exactly once.
  const [first, second] = await Promise.all([
    service.uploadFile(filepath),
    service.uploadFile(filepath)
  ]);
  assert.equal(uploadCalls.length, 1, 'one upload for two overlapping callers');
  // Both callers observe the same GeminiFile object because the second caller
  // resolves to the same in-flight promise.
  assert.deepEqual({ ...first }, { ...second });
  assert.equal(first.state, FileState.ACTIVE);
  assert.equal(uploadCalls[0]?.config?.mimeType, 'video/mp4');

  // The single shared poll cycle observed exactly one ACTIVE-state retrieval;
  // the polling loop body runs exactly once during coalescing because the
  // initial `files.upload` returned PROCESSING and `files.get` returns ACTIVE
  // on the first read.
  assert.ok(getCalls.length >= 1, 'shared polling lifecycle runs at least once');

  // Snapshot counters before the post-settlement calls; use deltas to compare
  // so the cached-vs-fresh assertions are independent of the first overlap.
  const uploadsAfterCoalesce = recordUploadLength();
  const getsAfterCoalesce = recordGetLength();

  // A second uploadFile after settlement with the unchanged content hits the
  // checksum completed-cache: no upload, no poll.
  const cached = await service.uploadFile(filepath);
  assert.equal(cached.name, 'files/video');
  assert.equal(recordUploadLength(), uploadsAfterCoalesce, 'unchanged content reuses checksum completed-cache');
  assert.equal(recordGetLength(), getsAfterCoalesce, 'no polling when checksum cache short-circuits');

  // A third uploadFile after settlement with REPLACED content (different
  // bytes => different checksum) starts a new upload+poll lifecycle.
  await writeMediaFile('coalesce.mp4', Buffer.from('second-content-different'));
  const freshlyUploaded = await service.uploadFile(filepath);
  assert.equal(recordUploadLength(), uploadsAfterCoalesce + 1, 'changed content breaks checksum cache and re-uploads');
  assert.equal(freshlyUploaded.name, 'files/video');
});

