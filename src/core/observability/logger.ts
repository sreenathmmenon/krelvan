/**
 * Minimal structured logger. Zero third-party deps.
 * Writes JSON lines to stderr (never stdout — stdout is for structured output).
 *
 * Log level controlled by LOG_LEVEL env var (default: info).
 * Valid values: debug | info | warn | error | silent
 *
 * Format: one JSON object per line — pipe to `jq` for pretty output.
 */

export interface Logger {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type LevelName = keyof typeof LEVELS;

function resolveLevel(): number {
  const raw = (process.env["LOG_LEVEL"] ?? "info").toLowerCase() as LevelName;
  return LEVELS[raw] ?? LEVELS.info;
}

let currentLevel = resolveLevel();

/** Update the active log level at runtime (useful in tests). */
export function setLogLevel(level: LevelName): void {
  currentLevel = LEVELS[level];
}

/** Re-read LOG_LEVEL from env (call if env changes after startup). */
export function refreshLogLevel(): void {
  currentLevel = resolveLevel();
}

function write(level: string, levelNum: number, name: string, data: Record<string, unknown>, msg: string): void {
  if (levelNum < currentLevel) return;
  process.stderr.write(
    JSON.stringify({ level, name, msg, ...data, ts: new Date().toISOString() }) + "\n",
  );
}

export function getLogger(name: string): Logger {
  return {
    info:  (data, msg) => write("info",  LEVELS.info,  name, data, msg),
    warn:  (data, msg) => write("warn",  LEVELS.warn,  name, data, msg),
    error: (data, msg) => write("error", LEVELS.error, name, data, msg),
  };
}
