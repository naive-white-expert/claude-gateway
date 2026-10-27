import type { Db } from '../store/db.js';
import type { Diagnostic } from './diagnostics.js';

// 基本请求日志（方案 §8.4）：只记元数据，不记正文与密钥。
export interface RequestLogEntry {
  ts: number;
  reqId: string;
  keyId?: string;
  ip?: string;
  session?: string | null;
  agent?: string | null;
  reqClass?: string | null;
  model?: string;
  channel?: string;
  upstreamModel?: string;
  stream?: boolean;
  status: number;
  ms: number;
  ttfbMs?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  errorType?: string | null;
  diags: Diagnostic[];
}

export class RequestLog {
  constructor(private db: Db) {}

  write(e: RequestLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_log (ts, req_id, key_id, ip, session, agent, req_class, model, channel, upstream_model, stream, status, ms, ttfb_ms,
         input_tokens, output_tokens, cache_read, cache_creation, error_type, diags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.ts,
        e.reqId,
        e.keyId ?? null,
        e.ip ?? null,
        e.session ?? null,
        e.agent ?? null,
        e.reqClass ?? null,
        e.model ?? null,
        e.channel ?? null,
        e.upstreamModel ?? null,
        e.stream === undefined ? null : e.stream ? 1 : 0,
        e.status,
        e.ms,
        e.ttfbMs ?? null,
        e.usage?.input_tokens ?? null,
        e.usage?.output_tokens ?? null,
        e.usage?.cache_read_input_tokens ?? null,
        e.usage?.cache_creation_input_tokens ?? null,
        e.errorType ?? null,
        e.diags.length ? JSON.stringify(e.diags) : null,
      );
  }

  writeAuthFailure(ts: number, ip: string, keyPrefix: string | undefined, path: string, reason: string): void {
    this.db.prepare('INSERT INTO auth_failures (ts, ip, key_prefix, path, reason) VALUES (?,?,?,?,?)').run(ts, ip, keyPrefix ?? null, path.slice(0, 200), reason);
  }
}
