import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadGoogleFile } from '../services/google-upload.js';

async function withFetch(fetcher: typeof fetch, work: () => Promise<void>) {
  const original = globalThis.fetch; globalThis.fetch = fetcher;
  try { await work(); } finally { globalThis.fetch = original; }
}
test('resumable upload never sends media or credentials to a foreign upload URL', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get('x-goog-upload-command'), 'start');
    return new Response('', { headers: { 'x-goog-upload-url': 'https://attacker.invalid/collect' } });
  }, async () => {
    await assert.rejects(uploadGoogleFile(new Blob(['private']), 'image/png', 'secret', new AbortController().signal), /not trusted/u);
  });
  assert.equal(calls, 1);
});
test('resumable upload forwards cancellation to the actual byte-transfer request', async () => {
  const controller = new AbortController();
  let calls = 0, aborted = false;
  await withFetch(async (_url, init) => {
    calls++;
    if (calls === 1) return new Response('', { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session' } });
    const signal = init?.signal; assert.ok(signal);
    const pending = new Promise<Response>((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    queueMicrotask(() => controller.abort());
    return pending;
  }, async () => {
    await assert.rejects(uploadGoogleFile(new Blob(['private']), 'image/png', 'secret', controller.signal));
  });
  assert.equal(calls, 2); assert.equal(aborted, true);
});
test('upload metadata download is capped and cancels the oversized response stream', async () => {
  let cancelled = false, calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls === 1) return new Response('', { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session' } });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1048577)); },
      cancel() { cancelled = true; }
    }));
  }, async () => {
    await assert.rejects(uploadGoogleFile(new Blob(['private']), 'image/png', 'secret', new AbortController().signal), /exceeds limit/u);
  });
  assert.equal(cancelled, true);
});
