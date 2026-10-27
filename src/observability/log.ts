// 结构化日志（JSON 行，写 stdout，由 journald 收集）。只记元数据；任何疑似密钥的字符串在输出前掩码。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const SECRET_PATTERNS: RegExp[] = [
  /(?<![0-9A-Za-z_-])cgw_[0-9A-Za-z]{40,}/g,
  /(?<![0-9A-Za-z_-])sk-[0-9A-Za-z_-]{8,}/g,
  /Bearer\s+[^\s"]+/gi,
  /(?<![0-9A-Za-z_-])ark-[0-9a-f-]{16,}/gi,
  /[0-9a-f]{32}\.[0-9A-Za-z]{12,}/g,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => (m.toLowerCase().startsWith('bearer') ? 'Bearer <redacted>' : `${m.slice(0, 4)}<redacted>`));
  return out;
}

export class Logger {
  constructor(private level: Level = 'info', private write: (line: string) => void = (l) => process.stdout.write(l + '\n')) {}

  setLevel(level: Level): void {
    this.level = level;
  }

  log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    this.write(redact(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })));
  }
  debug(msg: string, f?: Record<string, unknown>): void {
    this.log('debug', msg, f);
  }
  info(msg: string, f?: Record<string, unknown>): void {
    this.log('info', msg, f);
  }
  warn(msg: string, f?: Record<string, unknown>): void {
    this.log('warn', msg, f);
  }
  error(msg: string, f?: Record<string, unknown>): void {
    this.log('error', msg, f);
  }
}
