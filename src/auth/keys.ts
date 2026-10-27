import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '../store/db.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function base62(bytes: Buffer): string {
  let n = BigInt('0x' + bytes.toString('hex'));
  let s = '';
  while (n > 0n) {
    s = BASE62[Number(n % 62n)] + s;
    n /= 62n;
  }
  return s.padStart(43, '0');
}

export const hashKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

export interface KeyRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  allowedModels: string[] | null;
}

export class KeyStore {
  private byHash = new Map<string, KeyRecord>();
  private loadedAt = 0;

  constructor(private db: Db, private reloadMs = 5000) {
    this.reload();
  }

  reload(): void {
    const rows = this.db.prepare('SELECT * FROM api_keys').all() as Record<string, unknown>[];
    const m = new Map<string, KeyRecord>();
    for (const r of rows) {
      const rec: KeyRecord = {
        id: r.id as string,
        name: r.name as string,
        prefix: r.prefix as string,
        hash: r.hash as string,
        createdAt: Number(r.created_at),
        expiresAt: r.expires_at == null ? null : Number(r.expires_at),
        revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
        allowedModels: r.allowed_models ? (JSON.parse(r.allowed_models as string) as string[]) : null,
      };
      m.set(rec.hash, rec);
    }
    this.byHash = m;
    this.loadedAt = Date.now();
  }

  /** 校验明文 key；返回有效记录或 null。比较在哈希上做常量时间比较。 */
  verify(key: string, now = Date.now()): KeyRecord | null {
    if (now - this.loadedAt > this.reloadMs) this.reload();
    if (!key.startsWith('cgw_') || key.length > 128) return null;
    const h = hashKey(key);
    const rec = this.byHash.get(h);
    if (!rec) return null;
    if (!timingSafeEqual(Buffer.from(rec.hash, 'hex'), Buffer.from(h, 'hex'))) return null;
    if (rec.revokedAt != null) return null;
    if (rec.expiresAt != null && rec.expiresAt <= now) return null;
    return rec;
  }

  create(name: string, opts: { expiresDays?: number; allowedModels?: string[] } = {}): { key: string; record: KeyRecord } {
    const key = 'cgw_' + base62(randomBytes(32));
    const now = Date.now();
    const record: KeyRecord = {
      id: randomUUID().slice(0, 8),
      name,
      prefix: key.slice(0, 8),
      hash: hashKey(key),
      createdAt: now,
      expiresAt: opts.expiresDays ? now + opts.expiresDays * 86400_000 : null,
      revokedAt: null,
      allowedModels: opts.allowedModels?.length ? opts.allowedModels : null,
    };
    this.db
      .prepare('INSERT INTO api_keys (id, name, prefix, hash, created_at, expires_at, revoked_at, allowed_models) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(record.id, name, record.prefix, record.hash, now, record.expiresAt, record.allowedModels ? JSON.stringify(record.allowedModels) : null);
    this.reload();
    return { key, record };
  }

  list(): KeyRecord[] {
    this.reload();
    return [...this.byHash.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  revoke(idOrPrefix: string): number {
    const r = this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE (id = ? OR prefix = ?) AND revoked_at IS NULL').run(Date.now(), idOrPrefix, idOrPrefix);
    this.reload();
    return Number(r.changes);
  }
}
