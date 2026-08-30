/**
 * Entry point for the MCP video recognition server
 * status: active
 * phase: change-b-group-6-observability
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Startup injects one bounded recovery diagnostic sink into the Gemini branch."
 * insights: "Recovery events are preformatted to one bounded string; Logger receives no second data/error argument."
 */

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

// Set log level from environment variable
const logLevel = ( process.env.LOG_LEVEL || LogLevel.FATAL ) as LogLevel;
Logger.setLogLevel(logLevel as LogLevel);

/**
 * Load configuration from environment variables
 */
async function loadConfig(): Promise<ServerConfig> {
  // Load the selected provider configuration
  const providerConfig = await loadRecognitionProviderConfig(process.env);

  // Construct the selected provider
  let provider: RecognitionProvider;
  if (providerConfig.provider === 'gemini') {
    const service = new GeminiService({ apiKey: providerConfig.apiKey });
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

  // Determine transport type
  const transportType = process.env.TRANSPORT_TYPE === 'sse' ? 'sse' : 'stdio';

  // Parse port if provided
  const portStr = process.env.PORT;
  const port = portStr ? parseInt(portStr, 10) : undefined;

  return {
    provider,
    transport: transportType,
    port
  };
}

/**
 * Main function to start the server
 */
async function main(): Promise<void> {
  try {
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
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

// Start the server
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
