import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleGenAI, ApiError } from '@google/genai';
import { normalizeGeminiGenerationFailure } from '../services/gemini-error-classifier.js';
import { GeminiService } from '../services/gemini.js';

async function withFetch<T>(fetcher: typeof fetch, work: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await work(); } finally { globalThis.fetch = original; }
}
for (const [status, category] of [[403, 'permission'], [429, 'rate-limit'], [503, 'temporary-service']] as const) {
  test('installed Google SDK preserves ' + status + ' for safe recovery without implicit retries', async () => {
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return Response.json({ error: { code: status, message: 'sensitive upstream details', status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
        details: [{ retryDelay: '1.250s' }] } }, { status });
    }, async () => {
      const client = new GoogleGenAI({ apiKey: 'fixture', httpOptions: { retryOptions: { attempts: 1 } } });
      await assert.rejects(client.models.generateContent({ model: 'fixture-model', contents: 'secret' }), error => {
        assert.ok(error instanceof ApiError);
        const normalized = normalizeGeminiGenerationFailure(error);
        assert.equal(normalized.failure.status, status);
        assert.equal(normalized.failure.category, category);
        assert.equal(normalized.failure.retryAfterMs, 1250);
        assert.doesNotMatch(normalized.failure.safeMessage, /sensitive|secret/u);
        return true;
      });
    });
    assert.equal(calls, 1);
  });
}
test('service cancellation reaches actual Google SDK fetch signal and bounds caller completion', async () => {
  const controller = new AbortController();
  let observed = false;
  await withFetch(async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    queueMicrotask(() => controller.abort());
    return await new Promise<Response>((_, reject) => {
      signal.addEventListener('abort', () => { observed = true; reject(signal.reason); }, { once: true });
    });
  }, async () => {
    const service = new GeminiService({ apiKey: 'fixture' }, { requestTimeoutMs: 1000 });
    await assert.rejects(service.processFileOrThrow({ uri: 'https://example.invalid/file', mimeType: 'image/png' }, 'private', 'fixture', controller.signal));
    await service.close();
  });
  assert.equal(observed, true);
});
test('service timeout is independent of a non-cooperative injected SDK', async () => {
  const client = { models: { generateContent: () => new Promise(() => { /* Settled or intentionally pending fixture. */ }) } } as unknown as GoogleGenAI;
  const service = new GeminiService({ apiKey: 'fixture' }, { requestTimeoutMs: 30 }, client);
  const keepAlive = setTimeout(() => { /* Settled or intentionally pending fixture. */ }, 1000);
  try {
    await assert.rejects(service.processFileOrThrow({ uri: 'fixture', mimeType: 'image/png' }, 'private', 'fixture'),
      error => (error as { code?: string }).code === 'ADAPTER_TIMEOUT');
  } finally { clearTimeout(keepAlive); await service.close(); }
});
test('Files REST upload and actual Google SDK poll, generation and deletion work over mocked HTTP', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'genai-wire-'));
  const filepath = path.join(root, 'sensitive-video.mp4');
  await writeFile(filepath, 'media-bytes');
  const calls: string[] = [];
  const file = { name: 'files/owned', uri: 'https://generativelanguage.googleapis.com/v1beta/files/owned', mimeType: 'video/mp4', state: 'ACTIVE' };
  try {
    await withFetch(async (input, init) => {
      const url = new URL(String(input));
      calls.push((init?.method ?? 'GET') + ' ' + url.pathname);
      assert.equal(url.hostname, 'generativelanguage.googleapis.com');
      if (url.pathname === '/upload/v1beta/files') {
        assert.doesNotMatch(String(init?.body), /sensitive-video/u);
        return new Response('', { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session' } });
      }
      if (url.pathname === '/upload/session') return Response.json({ file: { ...file, state: 'PROCESSING' } });
      if (url.pathname === '/v1beta/files/owned' && init?.method === 'DELETE') return Response.json({});
      if (url.pathname === '/v1beta/files/owned') return Response.json(file);
      if (url.pathname.endsWith(':generateContent')) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.generationConfig.maxOutputTokens, 8192);
        return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'mocked visual description' }] } }] });
      }
      throw new Error('Unexpected mock request path: ' + url.pathname);
    }, async () => {
      const service = new GeminiService({ apiKey: 'fixture-key' }, { pollIntervalMs: 1, cacheTtlMs: 0 });
      try {
        const uploaded = await service.uploadFile(filepath);
        assert.equal((await service.processFileOrThrow(uploaded, 'private-prompt', 'gemini-3.5-flash')).text, 'mocked visual description');
        await service.releaseFile(uploaded);
      } finally { await service.close(); }
    });
    assert.equal(calls.length, 5);
    assert.equal(calls.at(-1), 'DELETE /v1beta/files/owned');
  } finally { await rm(root, { recursive: true, force: true }); }
});
