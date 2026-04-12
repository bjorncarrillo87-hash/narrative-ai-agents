// ── Narrative AI — Logger ───────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',   // gray
  info:  '\x1b[36m',   // cyan
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
};

const RESET = '\x1b[0m';
const GOLD = '\x1b[33m';

const VALID_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const envLevel = process.env.LOG_LEVEL as LogLevel;
let minLevel: LogLevel = VALID_LEVELS.includes(envLevel) ? envLevel : 'info';

function formatTime(): string {
  return new Date().toISOString().slice(11, 23);
}

function write(level: LogLevel, message: string, data?: unknown): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const color = LEVEL_COLORS[level];
  const tag = level.toUpperCase().padEnd(5);
  const prefix = `${GOLD}[NAI]${RESET} ${color}${tag}${RESET} ${formatTime()}`;

  if (data !== undefined) {
    let serialized: string;
    try {
      serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 0);
    } catch {
      serialized = String(data);
    }
    console.log(`${prefix} ${message} ${LEVEL_COLORS.debug}${serialized}${RESET}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const log = {
  debug: (msg: string, data?: unknown) => write('debug', msg, data),
  info:  (msg: string, data?: unknown) => write('info', msg, data),
  warn:  (msg: string, data?: unknown) => write('warn', msg, data),
  error: (msg: string, data?: unknown) => write('error', msg, data),
  setLevel: (level: LogLevel) => { minLevel = level; },
};

