/**
 * Entry point for the MCP video recognition server
 */

import { Server } from './server.js';
import { createLogger, LogLevel, Logger } from './utils/logger.js';
import type { ServerConfig } from './server.js';

const log = createLogger('Main');

// Set log level from environment variable
const logLevel = ( process.env.LOG_LEVEL || LogLevel.FATAL ) as LogLevel;
Logger.setLogLevel(logLevel as LogLevel);

/**
 * Load configuration from environment variables
 */
function loadConfig(): ServerConfig {
  // Check for required environment variables
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY environment variable is required');
  }

  // Determine transport type
  const transportType = process.env.TRANSPORT_TYPE === 'sse' ? 'sse' : 'stdio';
  
  // Parse port if provided
  const portStr = process.env.PORT;
  const port = portStr ? parseInt(portStr, 10) : undefined;
  
  return {
    gemini: {
      apiKey
    },
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
    const config = loadConfig();
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
