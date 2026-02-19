type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) ?? "info";
const minLevelNum = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= minLevelNum;
}

function formatMessage(level: LogLevel, tag: string, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const base = `${timestamp} [${level.toUpperCase()}] [${tag}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

export const logger = {
  debug(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog("debug")) console.error(formatMessage("debug", tag, message, data));
  },
  info(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog("info")) console.error(formatMessage("info", tag, message, data));
  },
  warn(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog("warn")) console.error(formatMessage("warn", tag, message, data));
  },
  error(tag: string, message: string, data?: Record<string, unknown>): void {
    if (shouldLog("error")) console.error(formatMessage("error", tag, message, data));
  },
};
