import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { GeminiService } from '../services/gemini.js';

test('bounded snapshot coalesces callers, one cancellation keeps surviving upload, release and close delete only owned files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-owned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filepath = path.join(root, 'private.png');
  await writeFile(filepath, 'private-bytes');
  let finish: (value: object) => void = () => { /* Settled or intentionally pending fixture. */ };
  let uploads = 0;
  let sent: Blob | undefined;
  let observedSignal: AbortSignal | undefined;
  const deleted: string[] = [];
  const client = {
    files: {
      upload: async (input: { file: Blob; config: { abortSignal: AbortSignal } }) => {
        uploads++; sent = input.file; observedSignal = input.config.abortSignal;
        return await new Promise(resolve => { finish = resolve; });
      },
      delete: async ({ name }: { name: string }) => { deleted.push(name); }
    }
  } as unknown as GoogleGenAI;
  const service = new GeminiService({ apiKey: 'fixture' }, { maxUploadBytes: 20, cacheTtlMs: 0 }, client);
  t.after(() => service.close());
  const controller = new AbortController();
  const a = service.uploadFile(filepath, controller.signal);
  const b = service.uploadFile(filepath);
  while (!uploads) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(a);
  assert.equal(observedSignal?.aborted, false);
  assert.equal(await sent?.text(), 'private-bytes');
  finish({ uri: 'https://provider.invalid/owned', name: 'files/owned', state: 'ACTIVE' });
  const file = await b;
  assert.equal(uploads, 1);
  assert.equal(deleted.length, 0);
  await service.releaseFile(file);
  assert.deepEqual(deleted, ['files/owned']);
  await service.close();
  assert.deepEqual(deleted, ['files/owned']);
  await assert.rejects(service.uploadFile(filepath), /closed/u);
});
test('size cap is enforced before upload; polling cancellation deletes the accepted remote file', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filepath = path.join(root, 'private.mp4');
  await writeFile(filepath, Buffer.alloc(16));
  let uploads = 0;
  let polls = 0;
  const deleted: string[] = [];
  const client = { files: {
    upload: async () => { uploads++; return { uri: 'fixture', name: 'files/owned', state: 'PROCESSING' }; },
    get: async () => { polls++; return { uri: 'fixture', name: 'files/owned', mimeType: 'video/mp4', state: 'PROCESSING' }; },
    delete: async ({ name }: { name: string }) => { deleted.push(name); }
  } } as unknown as GoogleGenAI;
  const small = new GeminiService({ apiKey: 'fixture' }, { maxUploadBytes: 8 }, client);
  await assert.rejects(small.uploadFile(filepath), /size limit/u);
  assert.equal(uploads, 0);
  await small.close();
  const service = new GeminiService({ apiKey: 'fixture' }, { processingTimeoutMs: 50, pollIntervalMs: 5 }, client);
  t.after(() => service.close());
  await assert.rejects(service.uploadFile(filepath), /timed out/u);
  assert.ok(polls > 0 && polls < 20);
  assert.deepEqual(deleted, ['files/owned']);
});
test('late successful upload after all callers cancel is deleted without caching or exposing media', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-late-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filepath = path.join(root, 'file.png');
  await writeFile(filepath, 'data');
  let finish: (value: object) => void = () => { /* Settled or intentionally pending fixture. */ };
  let started = false;
  const deleted: string[] = [];
  const client = { files: {
    upload: () => new Promise(resolve => { started = true; finish = resolve; }),
    delete: async ({ name }: { name: string }) => { deleted.push(name); }
  } } as unknown as GoogleGenAI;
  const service = new GeminiService({ apiKey: 'fixture' }, {}, client);
  const controller = new AbortController();
  const pending = service.uploadFile(filepath, controller.signal);
  while (!started) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(pending);
  await service.close();
  finish({ name: 'files/late', uri: 'fixture', state: 'ACTIVE' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(deleted, ['files/late']);
});
