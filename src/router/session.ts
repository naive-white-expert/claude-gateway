import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from '../store/db.js';

// 会话线识别与切换检测（会话专题 §4.1）、thinking 来源登记（§4.2）。只存元数据与哈希。

export interface SessionInfo {
  sessionId: string | null;
  agentId: string | null;
  requestClass: string | null;
  /** 参与切换检测的会话线；后台小任务等为 null */
  line: string | null;
}

const h = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 128) : null);

export function sessionInfo(headers: IncomingHttpHeaders, metadataUserId?: unknown): SessionInfo {
  let sessionId = h(headers['x-claude-code-session-id']);
  if (!sessionId && typeof metadataUserId === 'string') {
    try {
      const j = JSON.parse(metadataUserId) as { session_id?: unknown };
      sessionId = h(j.session_id);
    } catch {
      /* 非 JSON 的 user_id 不作会话识别 */
    }
  }
  const agentId = h(headers['x-claude-code-agent-id']);
  const requestClass = h(headers['x-claude-code-request-class']);
  const tracked = !requestClass || requestClass === 'main' || requestClass === 'subagent' || requestClass === 'compaction';
  const line = sessionId && tracked ? `${sessionId}:${agentId ?? 'main'}` : null;
  return { sessionId, agentId, requestClass, line };
}

export interface LineState {
  lastModel: string;
  prevModel: string | null;
  switchedAt: number | null;
}

export interface SwitchObservation {
  /** 本次请求之前，这条会话线上是否发生过切换（含本次） */
  switched: boolean;
  /** 本次请求是否刚切换 */
  switchedNow: boolean;
  /** 切换前的对外 ID */
  prevModel: string | null;
}

export class SessionStore {
  constructor(private db: Db) {}

  get(line: string): LineState | null {
    const r = this.db.prepare('SELECT last_model, prev_model, switched_at FROM session_lines WHERE line = ?').get(line) as
      | { last_model: string; prev_model: string | null; switched_at: number | null }
      | undefined;
    return r ? { lastModel: r.last_model, prevModel: r.prev_model, switchedAt: r.switched_at } : null;
  }

  observe(line: string, model: string, now = Date.now()): SwitchObservation {
    const cur = this.get(line);
    if (!cur) {
      this.db.prepare('INSERT OR REPLACE INTO session_lines (line, last_model, prev_model, switched_at, updated_at) VALUES (?, ?, NULL, NULL, ?)').run(line, model, now);
      return { switched: false, switchedNow: false, prevModel: null };
    }
    if (cur.lastModel !== model) {
      this.db.prepare('UPDATE session_lines SET last_model = ?, prev_model = ?, switched_at = ?, updated_at = ? WHERE line = ?').run(model, cur.lastModel, now, now, line);
      return { switched: true, switchedNow: true, prevModel: cur.lastModel };
    }
    this.db.prepare('UPDATE session_lines SET updated_at = ? WHERE line = ?').run(now, line);
    return { switched: cur.switchedAt != null, switchedNow: false, prevModel: cur.prevModel };
  }
}

export function thinkingHash(block: { type: string; thinking?: string; signature?: string; data?: string }): string {
  const material =
    block.type === 'redacted_thinking' ? `r:${block.data ?? ''}` : block.signature ? `s:${block.signature}` : `t:${block.thinking ?? ''}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export class ThinkingLedger {
  constructor(private db: Db) {}

  register(blocks: { type: string; thinking?: string; signature?: string; data?: string }[], model: string, now = Date.now()): number {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO thinking_ledger (hash, model, created_at) VALUES (?, ?, ?)');
    let n = 0;
    for (const b of blocks) {
      if (b.type !== 'thinking' && b.type !== 'redacted_thinking') continue;
      stmt.run(thinkingHash(b), model, now);
      n++;
    }
    return n;
  }

  originOf(block: { type: string; thinking?: string; signature?: string; data?: string }): string | null {
    const r = this.db.prepare('SELECT model FROM thinking_ledger WHERE hash = ?').get(thinkingHash(block)) as { model: string } | undefined;
    return r?.model ?? null;
  }
}
