import type { IncomingHttpHeaders } from 'node:http';
import { Agent } from 'undici';
import type { ResolvedChannel } from '../config/load.js';
import type { Diagnostic } from '../observability/diagnostics.js';

// 出站：上游地址只来自渠道配置（白名单），不跟随重定向；清除客户端认证头后注入渠道 key（方案 §8.4）。

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
]);

export function buildUpstreamHeaders(client: IncomingHttpHeaders, channel: ResolvedChannel, diags: Diagnostic[]): Record<string, string> {
  const out: Record<string, string> = {};
  let droppedHint = 0;
  for (const [k, v] of Object.entries(client)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(key)) continue;
    if (key.startsWith('x-claude-code-')) {
      droppedHint++;
      continue;
    }
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (droppedHint) diags.push({ code: 'claude_code_headers_not_forwarded', action: 'strip', field: 'x-claude-code-*', count: droppedHint });

  const beta = out['anthropic-beta'];
  if (beta && channel.profile.betaStrip.length) {
    const values = beta.split(',').map((s) => s.trim()).filter(Boolean);
    const kept = values.filter((v) => !channel.profile.betaStrip.includes(v));
    if (kept.length !== values.length) {
      diags.push({ code: 'beta_stripped', action: 'strip', field: 'anthropic-beta', detail: values.filter((v) => !kept.includes(v)).join(',') });
      if (kept.length) out['anthropic-beta'] = kept.join(',');
      else delete out['anthropic-beta'];
    }
  }
  out['content-type'] = 'application/json';
  out['accept-encoding'] = 'identity';
  if (!out['anthropic-version']) out['anthropic-version'] = '2023-06-01';
  if (channel.profile.authHeader === 'bearer') out.authorization = `Bearer ${channel.apiKey ?? ''}`;
  else out['x-api-key'] = channel.apiKey ?? '';
  return out;
}

const PASS_RESPONSE_HEADER = /^(content-type|retry-after|request-id|x-request-id|anthropic-ratelimit-.+|x-ratelimit-.+|x-ds-trace-id)$/i;

export function filterResponseHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || !PASS_RESPONSE_HEADER.test(k)) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export class UpstreamPool {
  private agents = new Map<string, Agent>();

  agentFor(channel: ResolvedChannel): Agent {
    let a = this.agents.get(channel.id);
    if (!a) {
      a = new Agent({
        connect: { timeout: channel.profile.timeouts.connectMs },
        keepAliveTimeout: 30_000,
        connections: 64,
      });
      this.agents.set(channel.id, a);
    }
    return a;
  }

  async reset(): Promise<void> {
    const old = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(old.map((a) => a.close()));
  }
}
