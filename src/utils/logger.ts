/**
 * Logger utility for the MCP server.
 *
 * Stdio MCP reserves stdout for JSON-RPC messages, so every diagnostic is
 * written to stderr regardless of severity.
 */

export enum LogLevel {
  VERBOSE = 'verbose',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal'
}

const LOG_LEVELS = Object.values(LogLevel);

const formatDetail = (detail: unknown): string => {
  if (detail === undefined) return '';
  try {
    if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
    if (typeof detail === 'string') return detail;
    return JSON.stringify(detail);
  } catch {
    try {
      return String(detail);
    } catch {
      return '[unprintable detail]';
    }
  }
};

export class Logger {
  private readonly name: string;
  private static level: LogLevel = LogLevel.INFO;

  constructor(name: string) {
    this.name = name;
  }

  static isLogLevel(value: string): value is LogLevel {
    return LOG_LEVELS.some(level => level === value);
  }

  static setLogLevel(level: LogLevel): void {
    Logger.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(Logger.level);
  }

  private write(level: LogLevel, message: string, detail?: unknown): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const formattedDetail = formatDetail(detail);
    const suffix = formattedDetail.length === 0 ? '' : ` ${formattedDetail}`;
    process.stderr.write(`[${timestamp}] [${level.toUpperCase()}] [${this.name}] ${message}${suffix}\n`);
  }

  verbose(message: string, data?: unknown): void {
    this.write(LogLevel.VERBOSE, message, data);
  }

  debug(message: string, data?: unknown): void {
    this.write(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: unknown): void {
    this.write(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write(LogLevel.WARN, message, data);
  }

  error(message: string, error?: unknown): void {
    this.write(LogLevel.ERROR, message, error);
  }

  fatal(message: string, error?: unknown): void {
    this.write(LogLevel.FATAL, message, error);
  }
}

export const createLogger = (name: string): Logger => new Logger(name);
