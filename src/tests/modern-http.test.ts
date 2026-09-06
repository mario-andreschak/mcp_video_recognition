import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Server } from '../server.js';
import type { RecognitionProvider } from '../types/provider.js';

const TOKEN = 'test-bearer-private-owner-0123456789';
const VERSION = '2026-07-28';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function wire(method: string, params: Record<string, unknown> = {}, id = 0) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } };
}
async function decoded(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? '{}' : text) as {
      result?: { resultType?: string; ttlMs?: number; cacheScope?: string; isError?: boolean; tools?: { name: string }[]; content?: { text?: string }[] };
      error?: { code: number; message: string };
    };
}
test('actual modern HTTP has sessionless discovery, version metadata, input validation, authentication and contained media', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filepath = path.join(root, 'fixture.png');
  await writeFile(filepath, 'image');
  let calls = 0;
  const provider: RecognitionProvider = { async recognize(request) { calls++; return { text: request.prompt }; } };
  const server = new Server({ provider, transport: 'streamable-http', port: 0, authToken: TOKEN, mediaRoots: [root] });
  await server.start();
  t.after(() => server.stop());
  const url = 'http://127.0.0.1:' + server.getHttpPort() + '/mcp';
  const send = (method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}, id = 0) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + TOKEN, 'MCP-Protocol-Version': VERSION, 'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}), ...extra }, body: JSON.stringify(wire(method, params, id))
  });
  const discovery = await send('server/discover');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get('mcp-session-id'), null);
  assert.equal(discovery.headers.get('mcp-protocol-version'), VERSION);
  assert.ok((await decoded(discovery)).result);
  const listed = (await decoded(await send('tools/list'))).result;
  assert.deepEqual(listed?.tools?.map(tool => tool.name), ['image_recognition', 'audio_recognition', 'video_recognition']);
  assert.equal(listed?.ttlMs, 0);
  assert.equal(listed?.cacheScope, 'private');
  const params = { name: 'image_recognition', arguments: { filepath, prompt: 'owner-result' } };
  const successful = (await decoded(await send('tools/call', params))).result;
  assert.equal(successful?.resultType, 'complete');
  assert.equal(successful?.content?.[0]?.text, 'owner-result');
  for (const headers of [{ authorization: '' }, { authorization: 'Bearer another-owner-01234567890123456789' }]) {
    assert.equal((await send('tools/call', params, headers)).status, 401);
  }
  assert.equal((await send('tools/call', params, { origin: 'https://hostile.invalid' })).status, 403);
  const hostileStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { host: 'hostile.invalid', authorization: 'Bearer ' + TOKEN } },
      response => { response.resume(); resolve(response.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(hostileStatus, 421);
  assert.equal(calls, 1);
  assert.equal((await decoded(await send('tools/call', { name: 'absent', arguments: {} }))).error?.code, -32602);
  assert.equal((await decoded(await send('tools/call', { name: 'image_recognition', arguments: {} }))).result?.isError, true);
  const outside = path.join(tmpdir(), 'outside-' + path.basename(root) + '.png');
  await writeFile(outside, 'private-outside');
  t.after(() => rm(outside, { force: true }));
  const escaped = (await decoded(await send('tools/call', { name: 'image_recognition', arguments: { filepath: outside } }))).result;
  assert.equal(escaped?.isError, true);
  assert.equal(calls, 1);
  if (process.platform !== 'win32') {
    const link = path.join(root, 'escape.png'); await symlink(outside, link);
    assert.equal((await decoded(await send('tools/call', { name: 'image_recognition', arguments: { filepath: link } }))).result?.isError, true);
    assert.equal(calls, 1);
  }
  const parallel = await Promise.all(['first', 'second'].map(prompt => send('tools/call', {
    name: 'image_recognition', arguments: { filepath, prompt }
  }, {}, 7).then(decoded)));
  assert.deepEqual(parallel.map(result => result.result?.content?.[0]?.text), ['first', 'second']);
});
test('modern HTTP disconnect and deadline abort provider work; capacity recovers; shutdown completes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'video-abort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filepath = path.join(root, 'fixture.png'); await writeFile(filepath, 'image');
  let calls = 0, aborted = 0;
  const provider: RecognitionProvider = { recognize: async (_request, options) => {
    calls++;
    return await new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => { aborted++; reject(new Error('sensitive-provider-error')); }, { once: true });
    });
  } };
  const server = new Server({ provider, transport: 'streamable-http', port: 0, authToken: TOKEN,
    mediaRoots: [root], requestTimeoutMs: 100, maxConcurrentRequests: 1 });
  await server.start(); t.after(() => server.stop());
  const send = (signal?: AbortSignal) => fetch('http://127.0.0.1:' + server.getHttpPort() + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + TOKEN, 'MCP-Protocol-Version': VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'image_recognition' },
    body: JSON.stringify(wire('tools/call', { name: 'image_recognition', arguments: { filepath } })), signal
  });
  const controller = new AbortController();
  const pending = send(controller.signal).then(response => response.text()).catch(() => '');
  while (!calls) await sleep(1);
  const busy = await decoded(await send());
  assert.equal(busy.result?.isError, true);
  controller.abort(); await pending;
  for (let i = 0; i < 100 && !aborted; i++) await sleep(2);
  assert.equal(aborted, 1);
  const expired = await decoded(await send());
  assert.equal(expired.result?.isError, true);
  assert.equal(aborted, 2);
  assert.doesNotMatch(JSON.stringify(expired), /sensitive-provider-error/u);
  await server.stop();
});
