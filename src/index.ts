#!/usr/bin/env node
/**
 * Entry point for the MCP video recognition server
 * status: active
 * phase: change-b-group-6-observability
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Startup injects one bounded recovery diagnostic sink into the Gemini branch."
 * insights: "Recovery events are preformatted to one bounded string; Logger receives no second data/error argument."
 */

import path from 'node:path';
import { Server } from './server.js';
import { createLogger, LogLevel, Logger } from './utils/logger.js';
import { loadRecognitionProviderConfig, parseParallelPrompts } from './services/provider-config.js';
import { GeminiService } from './services/gemini.js';
import { GeminiRecognitionProvider } from './services/gemini-recognition-provider.js';
import { OpenAICompatibleRecognitionProvider } from './services/openai-compatible-recognition-provider.js';
import { ParallelRecognitionProvider } from './services/parallel-recognition-provider.js';
import { createProviderModelCooldownStore } from './services/provider-cooldown-store.js';
import { formatRecoveryDiagnosticEvent } from './services/recovery-diagnostics.js';
import type { RecognitionProvider } from './types/provider.js';
import type { ServerConfig } from './server.js';

const log = createLogger('Main');

const configureLogging = (): void => {
  const configuredLevel = process.env.LOG_LEVEL?.trim() || LogLevel.INFO;
  if (!Logger.isLogLevel(configuredLevel)) {
    throw new Error(
      `LOG_LEVEL must be one of: ${Object.values(LogLevel).join(', ')}`
    );
  }
  Logger.setLogLevel(configuredLevel);
};

const parseTransport = (): ServerConfig['transport'] => {
  const configuredTransport = process.env.TRANSPORT_TYPE?.trim() || 'stdio';
  if (configuredTransport === 'stdio') return 'stdio';
  if (configuredTransport === 'streamable-http' || configuredTransport === 'streamable') {
    return 'streamable-http';
  }
  if (configuredTransport === 'sse') {
    log.warn(
      'TRANSPORT_TYPE=sse is a legacy alias; this endpoint uses Streamable HTTP, not legacy SSE'
    );
    return 'streamable-http';
  }
  throw new Error(
    'TRANSPORT_TYPE must be stdio, streamable-http, or the legacy sse alias'
  );
};

const parsePort = (): number | undefined => {
  const configuredPort = process.env.PORT?.trim();
  if (configuredPort === undefined || configuredPort.length === 0) return undefined;
  if (!/^[0-9]+$/u.test(configuredPort)) {
    throw new Error('PORT must be a decimal integer between 0 and 65535');
  }

  const port = Number(configuredPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a decimal integer between 0 and 65535');
  }
  return port;
};

/**
 * Load configuration from environment variables
 */
async function loadConfig(): Promise<ServerConfig> {
  // Load the selected provider configuration
  const providerConfig = await loadRecognitionProviderConfig(process.env);

  // Construct the selected provider
  let provider: RecognitionProvider;
  if (providerConfig.provider === 'gemini') {
    const limit = (key: string, fallback: number, min: number, max: number) => {
      const value = process.env[key];
      if (value === undefined) return fallback;
      if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(key + ' is outside its supported range');
      return Number(value);
    };
    const service = new GeminiService({ apiKey: providerConfig.apiKey }, {
      maxUploadBytes: limit('GEMINI_MAX_UPLOAD_BYTES', 33554432, 1024, 268435456),
      requestTimeoutMs: limit('GEMINI_REQUEST_TIMEOUT_MS', 120000, 1000, 120000),
      processingTimeoutMs: limit('GEMINI_PROCESSING_TIMEOUT_MS', 300000, 1000, 300000),
      maxResponseBytes: limit('GEMINI_MAX_RESPONSE_BYTES', 1048576, 1024, 4194304),
      maxCachedFiles: limit('GEMINI_MAX_CACHED_FILES', 16, 1, 64),
      cacheTtlMs: limit('GEMINI_CACHE_TTL_MS', 3600000, 0, 86400000)
    });
    const cooldowns = createProviderModelCooldownStore();
    const backupProvider = providerConfig.recovery.backup.enabled
      ? new OpenAICompatibleRecognitionProvider(providerConfig.recovery.backup.providerConfig)
      : undefined;
    provider = new GeminiRecognitionProvider(service, providerConfig, {
      cooldowns,
      diagnosticSink: event => {
        const message = formatRecoveryDiagnosticEvent(event);
        if (event.kind === 'attempt-started' || event.kind === 'fallback-succeeded') log.info(message);
        else log.warn(message);
      },
      ...(backupProvider === undefined ? {} : { backupProvider })
    });
  } else {
    provider = new OpenAICompatibleRecognitionProvider(providerConfig);
  }

  const parallelPrompts = parseParallelPrompts(process.env);
  if (parallelPrompts > 1) {
    provider = new ParallelRecognitionProvider(provider, parallelPrompts, providerConfig.provider);
  }

  const transport = parseTransport();
  const port = parsePort();
  const configuredHost = process.env.MCP_HOST?.trim();
  const host = configuredHost === undefined || configuredHost.length === 0
    ? undefined
    : configuredHost;

  const mediaRoots = process.env.ALLOWED_MEDIA_ROOTS?.split(path.delimiter).filter(Boolean);
  return {
    authToken: process.env.MCP_AUTH_TOKEN,
    allowedHosts: process.env.MCP_ALLOWED_HOSTS?.split(',').filter(Boolean),
    allowedOrigins: process.env.MCP_ALLOWED_ORIGINS?.split(',').filter(Boolean),
    mediaRoots,
    provider,
    transport,
    port,
    host
  };
}

/**
 * Main function to start the server
 */
async function main(): Promise<void> {
  try {
    configureLogging();
    log.info('Starting MCP video recognition server');

    // Load configuration
    const config = await loadConfig();
    log.info(`Using provider: ${config.provider.constructor.name}`);
    log.info(`Using transport: ${config.transport}`);
    
    // Create and start server
    const server = new Server(config);
    await server.start();
    
    // Handle process termination
    process.on('SIGINT', async () => {
      log.info('Received SIGINT signal, shutting down...');
      await server.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      log.info('Received SIGTERM signal, shutting down...');
      await server.stop();
      process.exit(0);
    });
    
    log.info('Server started successfully');
  } catch (error) {
    const variable = error instanceof Error ? /^[A-Z][A-Z0-9_]{2,48}(?= )/u.exec(error.message)?.[0] : undefined;
    log.fatal('Failed to start server; check configuration' + (variable ? ': ' + variable : ''));
    process.exitCode = 1;
  }
}

// Start the server
main().catch(() => {
  process.stderr.write('Unhandled startup error\n');
  process.exitCode = 1;
});
