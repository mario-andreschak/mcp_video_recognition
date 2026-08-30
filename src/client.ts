#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ClientOptions {
  serverPath: string;
  cwd: string;
  envFile?: string;
  tool?: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}

const clientModuleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultServerPath = resolve(clientModuleDirectory, 'index.js');
const defaultCwd = resolve(clientModuleDirectory, '..');

const usage = `Usage:
  npm run client -- [--server PATH] [--cwd PATH] [--env-file PATH]
  npm run client -- --tool TOOL_NAME --args '{"filepath":"C:/media/file.mp4"}'

With no --tool, the client spawns the server, completes MCP initialization, and
lists its tools. The default server is dist/index.js and .env is loaded from the
server working directory when present. Existing process environment variables
take precedence over .env.

Options:
  --server PATH       Compiled MCP server entry point (default: dist/index.js)
  --cwd PATH          Server working directory (default: repository root)
  --env-file PATH     Environment file to load (default: <cwd>/.env)
  --no-env-file       Do not load an environment file
  --tool NAME         Call one tool after connecting
  --args JSON         JSON object passed as tool arguments (default: {})
  --timeout-ms N      Initialize/call timeout in milliseconds (default: 600000)
  --help              Show this help
`;

const requireValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
};

const parseArguments = (argv: string[]): ClientOptions | undefined => {
  let serverPath = defaultServerPath;
  let cwd = defaultCwd;
  let envFile: string | undefined;
  let loadDefaultEnvFile = true;
  let tool: string | undefined;
  let toolArguments: Record<string, unknown> = {};
  let timeoutMs = 600_000;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return undefined;
    if (argument === '--no-env-file') {
      loadDefaultEnvFile = false;
      envFile = undefined;
      continue;
    }

    if (argument === '--server') {
      serverPath = resolve(requireValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--cwd') {
      cwd = resolve(requireValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--env-file') {
      envFile = resolve(requireValue(argv, index, argument));
      loadDefaultEnvFile = false;
      index += 1;
      continue;
    }
    if (argument === '--tool') {
      tool = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--args') {
      const rawArguments = requireValue(argv, index, argument);
      const parsed: unknown = JSON.parse(rawArguments);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('--args must be a JSON object');
      }
      toolArguments = parsed as Record<string, unknown>;
      index += 1;
      continue;
    }
    if (argument === '--timeout-ms') {
      const rawTimeout = requireValue(argv, index, argument);
      if (!/^[0-9]+$/u.test(rawTimeout)) {
        throw new Error('--timeout-ms must be a positive decimal integer');
      }
      timeoutMs = Number(rawTimeout);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error('--timeout-ms must be a positive decimal integer');
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (loadDefaultEnvFile) envFile = resolve(cwd, '.env');

  return {
    serverPath: resolve(serverPath),
    cwd: resolve(cwd),
    envFile,
    tool,
    arguments: toolArguments,
    timeoutMs
  };
};

const unquoteEnvValue = (rawValue: string): string => {
  const value = rawValue.trim();
  if (value.length < 2) return value;

  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) {
    const commentIndex = value.search(/\s#/u);
    return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
  }

  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\r')
    .replace(/\\t/gu, '\t')
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, '\\');
};

const readEnvironmentFile = async (path: string | undefined): Promise<Record<string, string>> => {
  if (path === undefined || !existsSync(path)) return {};

  const result: Record<string, string> = {};
  const contents = await readFile(path, 'utf8');
  for (const originalLine of contents.split(/\r?\n/u)) {
    const line = originalLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(withoutExport);
    if (match === null) {
      throw new Error(`Invalid environment line in ${path}`);
    }
    result[match[1]] = unquoteEnvValue(match[2]);
  }
  return result;
};

const inheritedEnvironment = (): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
};

const formatError = (error: unknown): string => {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
};

const run = async (): Promise<void> => {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.stdout.write(usage);
    return;
  }
  if (!existsSync(options.serverPath)) {
    throw new Error(`Server entry point does not exist: ${options.serverPath}`);
  }

  const fileEnvironment = await readEnvironmentFile(options.envFile);
  const environment = { ...fileEnvironment, ...inheritedEnvironment() };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverPath],
    cwd: options.cwd,
    env: environment,
    stderr: 'pipe'
  });
  transport.stderr?.on('data', chunk => {
    process.stderr.write(`[server] ${String(chunk)}`);
  });

  const client = new Client({
    name: 'mcp-video-recognition-standalone-client',
    version: '1.0.0'
  });

  try {
    await client.connect(transport, { timeout: options.timeoutMs });
    const tools = await client.listTools(undefined, { timeout: options.timeoutMs });

    if (options.tool === undefined) {
      process.stdout.write(`${JSON.stringify({
        connected: true,
        server: client.getServerVersion(),
        pid: transport.pid,
        tools: tools.tools
      }, null, 2)}\n`);
      return;
    }

    if (!tools.tools.some(tool => tool.name === options.tool)) {
      throw new Error(
        `Unknown tool "${options.tool}". Available tools: ${tools.tools.map(tool => tool.name).join(', ')}`
      );
    }

    const result = await client.callTool(
      {
        name: options.tool,
        arguments: options.arguments
      },
      undefined,
      {
        timeout: options.timeoutMs,
        maxTotalTimeout: options.timeoutMs
      }
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.isError === true) process.exitCode = 2;
  } finally {
    await client.close();
  }
};

run().catch(error => {
  process.stderr.write(`Client failed: ${formatError(error)}\n`);
  process.exitCode = 1;
});
