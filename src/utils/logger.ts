/**
 * Logger utility for the MCP server
 */

export enum LogLevel {
  VERBOSE = 'verbose',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal'
}

export class Logger {
  private readonly name: string;
  private static level: LogLevel = LogLevel.FATAL;

  constructor(name: string) {
    this.name = name;
  }

  static setLogLevel(level: LogLevel): void {
    Logger.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = Object.values(LogLevel);
    return levels.indexOf(level) >= levels.indexOf(Logger.level);
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}] ${message}`;
  }

  verbose(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.VERBOSE)) {
      const formattedData = data ? JSON.stringify(data) : '';
      console.log(this.formatMessage(LogLevel.VERBOSE, message), formattedData);
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage(LogLevel.DEBUG, message), data || '');
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage(LogLevel.INFO, message), data || '');
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message), data || '');
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage(LogLevel.ERROR, message), error || '');
    }
  }

  fatal(message: string, error?: unknown): void {
    if (this.shouldLog(LogLevel.FATAL)) {
      console.error(this.formatMessage(LogLevel.FATAL, message), error || '');
    }
  }
}

export const createLogger = (name: string): Logger => new Logger(name);
