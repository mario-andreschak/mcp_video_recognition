import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import http from 'node:http';

const exec = promisify(execFile);
const npm = (args, options) => process.env.npm_execpath
  ? exec(process.execPath, [process.env.npm_execpath, ...args], options)
  : exec('npm', args, options);
const temp = await mkdtemp(path.join(tmpdir(), 'video-package-'));
const children = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bound = (promise, ms = 10000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Acceptance deadline exceeded')), ms); })])
    .finally(() => clearTimeout(timer));
};
let provider;
try {
  let installed = process.argv[2];
  if (!installed) {
    const pack = await npm(['pack', '--json', '--pack-destination', temp], { maxBuffer: 10 * 1024 * 1024 });
    const manifest = JSON.parse(pack.stdout.slice(pack.stdout.indexOf('[')))[0];
    assert.ok(manifest.files.some(file => file.path === 'dist/index.js'));
    assert.ok(!manifest.files.some(file => file.path.startsWith('dist/tests/') || file.path.endsWith('.map')));
    const consumer = path.join(temp, 'consumer'); await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    await npm(['install', '--omit=dev', '--ignore-scripts', path.join(temp, manifest.filename)], { cwd: consumer, maxBuffer: 10 * 1024 * 1024 });
    installed = path.join(consumer, 'node_modules/mcp-video-recognition');
  }
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['mcp-video-recognition'], 'dist/index.js');
  const media = path.join(temp, 'media'); await mkdir(media);
  const files = {};
  for (const [kind, extension] of [['image', 'png'], ['audio', 'wav'], ['video', 'mp4']]) {
    files[kind] = path.join(media, 'private-' + kind + '.' + extension);
    await writeFile(files[kind], 'PRIVATE_MEDIA_FIXTURE');
  }
  let providerCalls = 0, cancelled = 0, waiting = 0;
  provider = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-provider-secret');
    assert.equal(input.model, 'configured-fixture-model');
    const prompt = input.messages[0].content[0].text;
    const part = input.messages[0].content[1];
    assert.ok(['image_url', 'input_audio', 'video_url'].includes(part.type));
    providerCalls++;
    if (prompt === 'wait') {
      waiting++;
      res.on('close', () => { cancelled++; waiting--; });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'fixture ' + part.type } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  for (const modern of [true, false]) {
    const executable = process.platform === 'win32' ? process.execPath : path.join(path.dirname(installed), '.bin', 'mcp-video-recognition');
    const args = process.platform === 'win32' ? [path.join(installed, manifest.bin['mcp-video-recognition'])] : [];
    const child = spawn(executable, args, { cwd: temp, env: {
      ...process.env, TRANSPORT_TYPE: 'stdio', RECOGNITION_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_API_KEY: 'fixture-provider-secret', OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:' + provider.address().port + '/v1',
      OPENAI_COMPATIBLE_MODEL: 'configured-fixture-model', ALLOW_INSECURE_LOCAL_OPENAI_COMPATIBLE: 'true',
      ALLOWED_MEDIA_ROOTS: media, LOG_LEVEL: 'verbose', PARALLEL_PROMPTS: '1'
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const pending = new Map();
    let out = '', errors = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => errors += chunk);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      out += chunk;
      assert.ok(out.length <= 1024 * 1024);
      let line;
      while ((line = out.indexOf('\n')) >= 0) {
        const message = JSON.parse(out.slice(0, line)); out = out.slice(line + 1);
        if (Object.hasOwn(message, 'id')) { pending.get(message.id)?.(message); pending.delete(message.id); }
      }
    });
    const meta = modern ? { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } : undefined;
    const request = (id, method, params = {}) => bound(new Promise(resolve => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...(meta ? { _meta: meta } : {}) } }) + '\n');
    }));
    if (modern) {
      const discovered = await request(10, 'server/discover');
      assert.ok(discovered.result);
    } else {
      const initialized = await request(10, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-acceptance', version: '1' } });
      assert.equal(initialized.result.protocolVersion, '2025-11-25');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    }
    const list = await request(11, 'tools/list');
    assert.equal(list.result.tools.length, 3);
    if (modern) { assert.equal(list.result.ttlMs, 0); assert.equal(list.result.cacheScope, 'private'); }
    let id = 12;
    for (const [kind, type] of [['image', 'image_url'], ['audio', 'input_audio'], ['video', 'video_url']]) {
      const result = (await request(id++, 'tools/call', { name: kind + '_recognition', arguments: { filepath: files[kind] } })).result;
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, 'fixture ' + type);
      if (modern) assert.equal(result.resultType, 'complete');
      else assert.equal(result.resultType, undefined);
    }
    assert.equal((await request(id++, 'tools/call', { name: 'missing', arguments: {} })).error.code, -32602);
    assert.equal((await request(id++, 'tools/call', { name: 'image_recognition', arguments: {} })).result.isError, true);
    const before = cancelled;
    const active = request(0, 'tools/call', { name: 'image_recognition', arguments: { filepath: files.image, prompt: 'wait' } });
    for (let i = 0; i < 1000 && !waiting; i++) await sleep(2);
    assert.equal(waiting, 1);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 0, ...(meta ? { _meta: meta } : {}) } }) + '\n');
    assert.equal((await active).result.isError, true);
    for (let i = 0; i < 500 && cancelled === before; i++) await sleep(2);
    assert.equal(cancelled, before + 1);
    assert.ok((await request(id++, 'tools/list')).result.tools);
    child.stdin.end();
    assert.deepEqual(await bound(closed, 5000), { code: 0, signal: null });
    children.delete(child);
    assert.doesNotMatch(errors, /fixture-provider-secret|PRIVATE_MEDIA_FIXTURE|private-image|private-audio|private-video/u);
    console.log((modern ? 'Modern' : 'Legacy') + ' installed CLI: three actual tools, cancellation id 0, clean stdout and EOF passed');
  }
  assert.equal(providerCalls, 8);
  console.log('Installed artifact acceptance passed without paid provider calls');
} finally {
  for (const child of children) child.kill('SIGKILL');
  provider?.closeAllConnections();
  if (provider) await new Promise(resolve => provider.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
