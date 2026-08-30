/**
 * Live transport boundary tests.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '../server.js';
import type { RecognitionProvider } from '../types/provider.js';

const repositoryRoot = process.cwd();
const execFileAsync = promisify(execFile);

test('runtime manifest retains the MCP SDK dependency', async () => {
  const manifestText = await readFile(resolve(repositoryRoot, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(manifest.dependencies?.['@modelcontextprotocol/sdk'], '^1.10.1');
  assert.equal(manifest.devDependencies?.['@modelcontextprotocol/sdk'], undefined);
});

test('standalone client spawns stdio server and completes a clean handshake at info log level', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [resolve(repositoryRoot, 'dist/client.js'), '--no-env-file'],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GOOGLE_API_KEY: 'transport-test-key',
        LOG_LEVEL: 'info'
      },
      timeout: 30_000
    }
  );

  const result = JSON.parse(stdout) as {
    connected?: boolean;
    server?: { name?: string };
    tools?: { name?: string }[];
  };

  assert.equal(result.connected, true);
  assert.equal(result.server?.name, 'mcp-video-recognition');
  assert.deepEqual(
    result.tools?.map(tool => tool.name),
    ['image_recognition', 'audio_recognition', 'video_recognition']
  );
  assert.match(stderr, /Server started with stdio transport/u);
  assert.doesNotMatch(stderr, /JSON|parse error|Unexpected token/iu);
});

test('standalone client returns an actionable missing-file tool error', async () => {
  const missingPath = resolve(repositoryRoot, 'missing-transport-test.png');
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        resolve(repositoryRoot, 'dist/client.js'),
        '--no-env-file',
        '--tool',
        'image_recognition',
        '--args',
        JSON.stringify({ filepath: missingPath })
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GOOGLE_API_KEY: 'transport-test-key',
          LOG_LEVEL: 'error'
        },
        timeout: 30_000
      }
    ),
    (caught: unknown) => {
      const error = caught as { stdout?: string; code?: number };
      assert.equal(error.code, 2);
      const result = JSON.parse(error.stdout ?? '') as {
        isError?: boolean;
        content?: { type?: string; text?: string }[];
      };
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text ?? '', /code=MEDIA_FILE_NOT_FOUND/u);
      return true;
    }
  );
});

test('Streamable HTTP initializes on sessionless POST and supports tool calls', async t => {
  const provider: RecognitionProvider = {
    async recognize(request) {
      return { text: `recognized ${request.mediaKind}` };
    }
  };
  const server = new Server({
    provider,
    transport: 'streamable-http',
    host: '127.0.0.1',
    port: 0
  });
  await server.start();
  t.after(async () => {
    await server.stop();
  });

  const port = server.getHttpPort();
  assert.equal(typeof port, 'number');

  const client = new Client({
    name: 'streamable-http-transport-test',
    version: '1.0.0'
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`)
  );
  await client.connect(transport, { timeout: 10_000 });
  t.after(async () => {
    await client.close();
  });

  const tools = await client.listTools(undefined, { timeout: 10_000 });
  assert.deepEqual(
    tools.tools.map(tool => tool.name),
    ['image_recognition', 'audio_recognition', 'video_recognition']
  );

  const result = await client.callTool(
    {
      name: 'image_recognition',
      arguments: { filepath: 'transport-test.png' }
    },
    undefined,
    { timeout: 10_000 }
  );
  assert.deepEqual(result.content, [{ type: 'text', text: 'recognized image' }]);
});

test('invalid startup configuration is visible on stderr', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve(repositoryRoot, 'dist/index.js')],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH ?? '',
          LOG_LEVEL: 'info'
        },
        timeout: 30_000
      }
    ),
    (caught: unknown) => {
      const error = caught as { stderr?: string; code?: number };
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? '', /GOOGLE_API_KEY/u);
      assert.match(error.stderr ?? '', /FATAL/u);
      return true;
    }
  );
});

test('fork registration, routing, and authentication additions remain absent', async () => {
  const serverSource = await readFile(resolve(repositoryRoot, 'src/server.ts'), 'utf8');
  const forbiddenServerTokens = [
    'registerTool(',
    'annotations:',
    'parallelDispatcher',
    'recognitionProviders',
    'rateLimitTracker',
    'throttlingScheduler',
    'fallbackProvider',
    'routingPolicy',
    'ctx.mcpReq.signal',
    'Authorization'
  ];

  for (const token of forbiddenServerTokens) {
    assert.equal(serverSource.includes(token), false, `unexpected server token: ${token}`);
  }

  const forbiddenForkFiles = [
    'src/services/parallel-dispatcher.ts',
    'src/services/rate-limit-tracker.ts',
    'src/services/recognition-providers.ts',
    'src/services/throttling-scheduler.ts'
  ];

  for (const relativePath of forbiddenForkFiles) {
    assert.equal(existsSync(resolve(repositoryRoot, relativePath)), false, `unexpected fork file: ${relativePath}`);
  }
});
