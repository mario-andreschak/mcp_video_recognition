/**
 * MCP server implementation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { createLogger } from './utils/logger.js';
import { createImageRecognitionTool } from './tools/image-recognition.js';
import { createAudioRecognitionTool } from './tools/audio-recognition.js';
import { createVideoRecognitionTool } from './tools/video-recognition.js';
import type { RecognitionProvider } from './types/provider.js';

const log = createLogger('Server');

export type ServerTransport = 'stdio' | 'streamable-http';

export interface ServerConfig {
  provider: RecognitionProvider;
  transport: ServerTransport;
  port?: number;
  host?: string;
}

interface HttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export class Server {
  private readonly recognitionProvider: RecognitionProvider;
  private readonly config: ServerConfig;
  private readonly httpSessions = new Map<string, HttpSession>();
  private stdioServer?: McpServer;
  private httpServer?: HttpServer;

  constructor(config: ServerConfig) {
    this.config = config;
    this.recognitionProvider = config.provider;
  }

  /**
   * Create one MCP protocol server per transport connection.
   *
   * The SDK only permits a McpServer to connect to one transport. HTTP sessions
   * therefore cannot share the stdio server or each other's server instance.
   */
  private createMcpServer(): McpServer {
    const mcpServer = new McpServer({
      name: 'mcp-video-recognition',
      version: '1.0.0'
    });

    const imageRecognitionTool = createImageRecognitionTool(this.recognitionProvider);
    const audioRecognitionTool = createAudioRecognitionTool(this.recognitionProvider);
    const videoRecognitionTool = createVideoRecognitionTool(this.recognitionProvider);

    mcpServer.tool(
      imageRecognitionTool.name,
      imageRecognitionTool.description,
      imageRecognitionTool.inputSchema.shape,
      imageRecognitionTool.callback
    );

    mcpServer.tool(
      audioRecognitionTool.name,
      audioRecognitionTool.description,
      audioRecognitionTool.inputSchema.shape,
      audioRecognitionTool.callback
    );

    mcpServer.tool(
      videoRecognitionTool.name,
      videoRecognitionTool.description,
      videoRecognitionTool.inputSchema.shape,
      videoRecognitionTool.callback
    );

    return mcpServer;
  }

  async start(): Promise<void> {
    if (this.config.transport === 'stdio') {
      await this.startWithStdio();
      return;
    }

    if (this.config.transport === 'streamable-http') {
      await this.startWithStreamableHttp();
      return;
    }

    const unreachableTransport: never = this.config.transport;
    throw new Error(`Unsupported transport: ${String(unreachableTransport)}`);
  }

  private async startWithStdio(): Promise<void> {
    log.info('Starting server with stdio transport');

    const server = this.createMcpServer();
    const transport = new StdioServerTransport();

    transport.onclose = () => {
      log.info('Stdio transport closed');
    };

    transport.onerror = error => {
      log.error('Stdio transport error', error);
    };

    await server.connect(transport);
    this.stdioServer = server;
    log.info('Server started with stdio transport');
  }

  private getSessionId(req: Request): string | undefined {
    const value = req.headers['mcp-session-id'];
    return typeof value === 'string' ? value : undefined;
  }

  private sendInvalidSession(res: Response): void {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided'
      },
      id: null
    });
  }

  private async startWithStreamableHttp(): Promise<void> {
    const express = await import('express');
    const app = express.default();
    const port = this.config.port ?? 3000;
    const host = this.config.host ?? '127.0.0.1';

    app.use(express.json());

    app.post('/mcp', async (req, res) => {
      let initializingSession: HttpSession | undefined;

      try {
        const sessionId = this.getSessionId(req);
        const existingSession = sessionId === undefined
          ? undefined
          : this.httpSessions.get(sessionId);

        if (existingSession !== undefined) {
          await existingSession.transport.handleRequest(req, res, req.body);
          return;
        }

        if (sessionId !== undefined || !isInitializeRequest(req.body)) {
          this.sendInvalidSession(res);
          return;
        }

        const server = this.createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: initializedSessionId => {
            this.httpSessions.set(initializedSessionId, { server, transport });
            log.info(`Streamable HTTP session initialized: ${initializedSessionId}`);
          }
        });
        initializingSession = { server, transport };

        transport.onclose = () => {
          if (transport.sessionId !== undefined) {
            this.httpSessions.delete(transport.sessionId);
            log.info(`Streamable HTTP session closed: ${transport.sessionId}`);
          }
        };
        transport.onerror = error => {
          log.error('Streamable HTTP transport error', error);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        log.error('Error handling MCP POST request', error);
        if (initializingSession !== undefined && initializingSession.transport.sessionId === undefined) {
          await initializingSession.server.close().catch(closeError => {
            log.error('Error closing failed MCP session', closeError);
          });
        }
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error'
            },
            id: null
          });
        }
      }
    });

    const handleEstablishedSession = async (req: Request, res: Response): Promise<void> => {
      try {
        const sessionId = this.getSessionId(req);
        const session = sessionId === undefined
          ? undefined
          : this.httpSessions.get(sessionId);

        if (session === undefined) {
          this.sendInvalidSession(res);
          return;
        }

        await session.transport.handleRequest(req, res);
      } catch (error) {
        log.error(`Error handling MCP ${req.method} request`, error);
        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    };

    app.get('/mcp', handleEstablishedSession);
    app.delete('/mcp', handleEstablishedSession);

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      const httpServer = app.listen(port, host, () => {
        httpServer.off('error', onError);
        this.httpServer = httpServer;
        resolve();
      });
      httpServer.once('error', onError);
    });

    log.info(`Server started with Streamable HTTP transport at http://${host}:${this.getHttpPort()}/mcp`);
  }

  getHttpPort(): number | undefined {
    const address = this.httpServer?.address();
    return address !== null && typeof address === 'object'
      ? (address as AddressInfo).port
      : undefined;
  }

  async stop(): Promise<void> {
    const sessionServers = [...this.httpSessions.values()].map(session => session.server);
    this.httpSessions.clear();

    for (const server of sessionServers) {
      await server.close().catch(error => {
        log.error('Error closing MCP HTTP session', error);
      });
    }

    if (this.stdioServer !== undefined) {
      await this.stdioServer.close();
      this.stdioServer = undefined;
    }

    if (this.httpServer !== undefined) {
      const httpServer = this.httpServer;
      this.httpServer = undefined;
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    }

    log.info('Server stopped');
  }
}
