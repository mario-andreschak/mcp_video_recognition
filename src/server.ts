import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createServer, type Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createLogger } from './utils/logger.js';
import { createImageRecognitionTool } from './tools/image-recognition.js';
import { createAudioRecognitionTool } from './tools/audio-recognition.js';
import { createVideoRecognitionTool } from './tools/video-recognition.js';
import { canonicalizeContainedFile } from './services/openai-compatible-recognition-provider.js';
import { abortable } from './services/operation.js';
import type { RecognitionProvider } from './types/provider.js';

const log = createLogger('Server');
export type ServerTransport = 'stdio' | 'streamable-http';
export interface ServerConfig {
  provider: RecognitionProvider;
  transport: ServerTransport;
  port?: number;
  host?: string;
  authToken?: string;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  mediaRoots?: readonly string[];
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
}
export class Server {
  private httpServer?: HttpServer;
  private httpHandler?: ReturnType<typeof createMcpHandler>;
  private stdioHandle?: ReturnType<typeof serveStdio>;
  private readonly active = new Set<AbortController>();
  private roots?: readonly string[];
  private stopping?: Promise<void>;
  private started = false;
  constructor(private readonly config: ServerConfig) {}
  private createMcpServer(): McpServer {
    const server = new McpServer({ name: 'mcp-video-recognition', version: '2.0.0' });
    const requests = new Map<string | number, AbortController>();
    // SDK 2.0.0 ignores numeric zero in its built-in cancellation handler.
    server.server.setNotificationHandler('notifications/cancelled', notification => {
      const id = notification.params?.requestId;
      if (id !== undefined) requests.get(id)?.abort();
    });
    const provider: RecognitionProvider = {
      recognize: async (request, options) => {
        if (this.roots) request = { ...request, filepath: await canonicalizeContainedFile(request.filepath, this.roots) };
        return this.config.provider.recognize(request, options);
      }
    };
    for (const tool of [createImageRecognitionTool(provider), createAudioRecognitionTool(provider), createVideoRecognitionTool(provider)]) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      }, async (args, ctx) => {
        if (this.stopping || this.active.size >= (this.config.maxConcurrentRequests ?? 8))
          return { isError: true, content: [{ type: 'text' as const, text: 'Recognition capacity reached; retry later.' }] };
        const controller = new AbortController();
        const signal = AbortSignal.any([ctx.mcpReq.signal, controller.signal, AbortSignal.timeout(this.config.requestTimeoutMs ?? 360000)]);
        requests.set(ctx.mcpReq.id, controller);
        this.active.add(controller);
        try {
          const result = await abortable(tool.callback(args, { signal }), signal);
          return result;
        } catch {
          return { isError: true, content: [{ type: 'text' as const, text: signal.aborted ? 'Recognition cancelled or timed out.' : 'Recognition failed.' }] };
        } finally { requests.delete(ctx.mcpReq.id); this.active.delete(controller); }
      });
    }
    server.server.onclose = () => { for (const controller of requests.values()) controller.abort(); };
    return server;
  }
  async start(): Promise<void> {
    if (this.started || this.stopping) throw new Error('Server already started or stopped');
    this.started = true;
    if (this.config.mediaRoots) {
      this.roots = await Promise.all(this.config.mediaRoots.map(async root => {
        const resolved = await realpath(root);
        if (!(await stat(resolved)).isDirectory()) throw new Error('ALLOWED_MEDIA_ROOTS must contain directories');
        return resolved;
      }));
    }
    if (this.config.transport === 'stdio') {
      this.stdioHandle = serveStdio(() => this.createMcpServer(), {
        legacy: 'serve', transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
        onerror: () => log.error('MCP transport error')
      });
      process.stdin.once('end', () => { void this.stop(); });
      log.info('Server started with stdio transport');
      return;
    }
    if (!this.config.authToken || this.config.authToken.length < 32 || /[\r\n]/u.test(this.config.authToken))
      throw new Error('HTTP requires MCP_AUTH_TOKEN of at least 32 characters');
    if (!this.roots?.length) throw new Error('HTTP requires ALLOWED_MEDIA_ROOTS');
    const allowedHosts = new Set(this.config.allowedHosts ?? []);
    const allowedOrigins = new Set(this.config.allowedOrigins ?? []);
    for (const host of allowedHosts)
      if (!/^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(:[0-9]{1,5})?$/u.test(host)) throw new Error('Invalid MCP_ALLOWED_HOSTS');
    for (const origin of allowedOrigins) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid MCP_ALLOWED_ORIGINS');
    }
    this.httpHandler = createMcpHandler(() => this.createMcpServer(), { legacy: 'stateless' });
    const handle = toNodeHandler(this.httpHandler);
    const secret = Buffer.from('Bearer ' + this.config.authToken);
    this.httpServer = createServer(async (req, res) => {
      const reject = (status: number, text: string) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(text); };
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      try {
        const port = this.getHttpPort();
        const localHosts = ['127.0.0.1', 'localhost', '[::1]'].map(host => host + ':' + port);
        if (!allowedHosts.has(req.headers.host ?? '') && !localHosts.includes(req.headers.host ?? '')) return reject(421, 'Invalid Host');
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin) && !localHosts.map(host => 'http://' + host).includes(origin)) return reject(403, 'Invalid Origin');
        const token = Buffer.from(req.headers.authorization ?? '');
        if (token.length !== secret.length || !timingSafeEqual(token, secret)) {
          res.setHeader('www-authenticate', 'Bearer');
          return reject(401, 'Bearer authentication required');
        }
        if (req.url !== '/mcp') return reject(404, 'Use /mcp');
        if (this.stopping) return reject(503, 'Server stopping');
        let parsed: unknown;
        if (req.method === 'POST') {
          if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reject(415, 'Expected application/json');
          let size = 0;
          const chunks: Buffer[] = [];
          const deadline = setTimeout(() => req.destroy(), 10000);
          try {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 1024 * 1024) return reject(413, 'Request too large');
              chunks.push(chunk);
            }
          } finally { clearTimeout(deadline); }
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        if (req.headers['mcp-protocol-version'] === '2026-07-28') res.setHeader('MCP-Protocol-Version', '2026-07-28');
        await handle(req, res, parsed);
      } catch {
        if (!res.headersSent) reject(400, 'Invalid request');
        else res.end();
      }
    });
    this.httpServer.headersTimeout = 10000;
    this.httpServer.requestTimeout = 15000;
    this.httpServer.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once('error', reject);
      this.httpServer?.listen(this.config.port ?? 3000, this.config.host ?? '127.0.0.1', resolve);
    });
    log.info('Server started with authenticated Streamable HTTP transport');
  }
  getHttpPort(): number | undefined {
    return (this.httpServer?.address() as AddressInfo | null)?.port;
  }
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const controller of this.active) controller.abort();
      await this.stdioHandle?.close();
      await this.httpHandler?.close();
      this.httpServer?.closeAllConnections();
      if (this.httpServer) await new Promise<void>(resolve => this.httpServer?.close(() => resolve()));
      await this.config.provider.close?.();
    })();
    return this.stopping;
  }
}
