import { BlockList, isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { GatewayConfig } from '../config/load.js';
import type { KeyRecord, KeyStore } from './keys.js';

/** 固定窗口计数（1 分钟），用于 rpm 限制。 */
class MinuteCounter {
  private buckets = new Map<string, { start: number; n: number }>();
  hit(key: string, limit: number, now: number): boolean {
    const b = this.buckets.get(key);
    if (!b || now - b.start >= 60_000) {
      this.buckets.set(key, { start: now, n: 1 });
      return true;
    }
    b.n++;
    return b.n <= limit;
  }
  sweep(now: number): void {
    for (const [k, b] of this.buckets) if (now - b.start >= 60_000) this.buckets.delete(k);
  }
}

function blockListOf(entries: string[]): BlockList {
  const bl = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (bits) bl.addSubnet(addr, Number(bits), type);
    else bl.addAddress(addr, type);
  }
  return bl;
}

const normalizeIp = (ip: string | undefined): string => (ip ?? '').replace(/^::ffff:/, '');

export type AuthResult =
  | { ok: true; key: KeyRecord; ip: string }
  | { ok: false; status: 401 | 403 | 429; reason: string; ip: string; keyPrefix?: string };

export interface AuthFailureSink {
  (ev: { ip: string; keyPrefix?: string; path: string; reason: string; banned?: number }): void;
}

export class EdgeGuard {
  private allow: BlockList | null;
  private trusted: BlockList;
  private failures = new Map<string, number[]>();
  private bans = new Map<string, { until: number; level: number }>();
  private unauthRpm = new MinuteCounter();
  private keyRpm = new MinuteCounter();

  constructor(private cfg: GatewayConfig, private keys: KeyStore, private onFailure: AuthFailureSink) {
    this.allow = cfg.security.ipAllowlist.enabled ? blockListOf(cfg.security.ipAllowlist.cidrs) : null;
    this.trusted = blockListOf(cfg.security.trustedProxies);
  }

  private matches(bl: BlockList, ip: string): boolean {
    const t = isIP(ip);
    return t !== 0 && bl.check(ip, t === 6 ? 'ipv6' : 'ipv4');
  }

  /** 真实客户端 IP：只有连接来自 trustedProxies 时才采信 X-Forwarded-For（取最右侧的非受信地址）。 */
  clientIp(remote: string | undefined, headers: IncomingHttpHeaders): string {
    const peer = normalizeIp(remote);
    if (!this.cfg.security.trustProxyHeaders || !this.matches(this.trusted, peer)) return peer;
    const xff = String(headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => normalizeIp(s.trim()))
      .filter(Boolean);
    for (let i = xff.length - 1; i >= 0; i--) if (!this.matches(this.trusted, xff[i])) return xff[i];
    const real = normalizeIp(String(headers['x-real-ip'] ?? ''));
    return real || peer;
  }

  extractKey(headers: IncomingHttpHeaders): string | null {
    const accept = this.cfg.security.keys.acceptHeaders;
    if (accept.includes('authorization')) {
      const a = headers.authorization;
      if (typeof a === 'string' && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, '').trim();
    }
    if (accept.includes('x-api-key')) {
      const x = headers['x-api-key'];
      if (typeof x === 'string' && x) return x.trim();
    }
    return null;
  }

  /** 只看请求头，在读取请求体之前调用。 */
  authenticate(remote: string | undefined, headers: IncomingHttpHeaders, path: string, now = Date.now()): AuthResult {
    const ip = this.clientIp(remote, headers);
    if (this.allow && !this.matches(this.allow, ip)) {
      this.onFailure({ ip, path, reason: 'ip_not_allowed' });
      return { ok: false, status: 403, reason: 'ip_not_allowed', ip };
    }
    const ban = this.bans.get(ip);
    if (ban && ban.until > now) return { ok: false, status: 403, reason: 'banned', ip };

    const key = this.extractKey(headers);
    const rec = key ? this.keys.verify(key, now) : null;
    if (!rec) {
      const keyPrefix = key ? key.slice(0, 8) : undefined;
      const reason = key ? 'invalid_key' : 'missing_key';
      const banned = this.recordFailure(ip, now);
      this.onFailure({ ip, keyPrefix, path, reason, banned });
      if (!this.unauthRpm.hit(ip, this.cfg.security.rateLimit.perIpUnauthenticated.rpm, now))
        return { ok: false, status: 429, reason: 'unauthenticated_rate_limited', ip, keyPrefix };
      return { ok: false, status: 401, reason, ip, keyPrefix };
    }
    if (!this.keyRpm.hit(rec.id, this.cfg.security.rateLimit.perKey.rpm, now)) return { ok: false, status: 429, reason: 'key_rate_limited', ip };
    return { ok: true, key: rec, ip };
  }

  private recordFailure(ip: string, now: number): number | undefined {
    const { banAfter, windowSec, banSec } = this.cfg.security.authFailure;
    const list = (this.failures.get(ip) ?? []).filter((t) => now - t < windowSec * 1000);
    list.push(now);
    this.failures.set(ip, list);
    if (list.length < banAfter) return undefined;
    const prev = this.bans.get(ip);
    const level = prev ? Math.min(prev.level + 1, banSec.length - 1) : 0;
    const until = now + banSec[level] * 1000;
    this.bans.set(ip, { until, level });
    this.failures.set(ip, []);
    return banSec[level];
  }

  sweep(now = Date.now()): void {
    this.unauthRpm.sweep(now);
    this.keyRpm.sweep(now);
    const maxBan = Math.max(...this.cfg.security.authFailure.banSec) * 1000;
    for (const [ip, b] of this.bans) if (b.until + maxBan < now) this.bans.delete(ip);
    const win = this.cfg.security.authFailure.windowSec * 1000;
    for (const [ip, l] of this.failures) if (!l.some((t) => now - t < win)) this.failures.delete(ip);
  }

  bannedCount(now = Date.now()): number {
    let n = 0;
    for (const b of this.bans.values()) if (b.until > now) n++;
    return n;
  }
}
