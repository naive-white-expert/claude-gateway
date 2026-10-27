import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as undiciRequest, errors as undiciErrors } from 'undici';
import type { ExposedModel, GatewayConfig } from '../config/load.js';
import { fill } from '../config/texts.js';
import { EdgeGuard } from '../auth/guard.js';
import type { KeyRecord, KeyStore } from '../auth/keys.js';
import { ConcurrencyLimiter, QueueAbortedError, QueueTimeoutError, type Release } from '../limits/concurrency.js';
import type { Diagnostic } from '../observability/diagnostics.js';
import type { Logger } from '../observability/log.js';
import type { RequestLog, RequestLogEntry } from '../observability/requestLog.js';
import { errorBody, overlongMessage, rewriteUpstreamError } from '../protocol/anthropic/errors.js';
import { prepareRequestBody, RequestValidationError } from '../protocol/anthropic/request.js';
import { PING_EVENT, SseRewriter, sseErrorEvent, type Usage } from '../protocol/anthropic/sse.js';
import { estimateInputTokens, lowerBoundTokens, TokenCalibrator } from '../protocol/anthropic/tokens.js';
import { buildUpstreamHeaders, filterResponseHeaders, UpstreamPool } from '../providers/upstream.js';
import { sessionInfo, type SessionStore, type ThinkingLedger } from '../router/session.js';

export interface GatewayDeps {
  keys: KeyStore;
  logger: Logger;
  sessions: SessionStore;
  ledger: ThinkingLedger;
  requestLog: RequestLog;
  now?: () => number;
}

class HttpError extends Error {
  constructor(public status: number, public type: string, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

const MODEL_CREATED_AT = '2026-10-27T00:00:00Z';

export class Gateway {
  cfg: GatewayConfig;
  guard: EdgeGuard;
  readonly limiter = new ConcurrencyLimiter();
  readonly pool = new UpstreamPool();
  readonly calibrator = new TokenCalibrator();
  readonly startedAt = Date.now();
  stats = { requests: 0, authFailures: 0, errors: 0 };

  constructor(cfg: GatewayConfig, private deps: GatewayDeps) {
    this.cfg = cfg;
    this.guard = this.makeGuard(cfg);
  }

  private makeGuard(cfg: GatewayConfig): EdgeGuard {
    return new EdgeGuard(cfg, this.deps.keys, (ev) => {
      this.stats.authFailures++;
      this.deps.logger.warn('auth_failure', { ip: ev.ip, keyPrefix: ev.keyPrefix, path: ev.path.slice(0, 120), reason: ev.reason, bannedSec: ev.banned });
      try {
        this.deps.requestLog.writeAuthFailure(Date.now(), ev.ip, ev.keyPrefix, ev.path, ev.reason);
      } catch {
        /* 日志写失败不影响拒绝 */
      }
    });
  }

  async reload(cfg: GatewayConfig): Promise<void> {
    this.cfg = cfg;
    this.guard = this.makeGuard(cfg);
    await this.pool.reset();
  }

  handler = (req: IncomingMessage, res: ServerResponse): void => {
    this.handle(req, res).catch((e) => {
      this.deps.logger.error('unhandled', { err: String((e as Error)?.stack ?? e) });
      if (!res.headersSent) this.sendError(res, 500, 'api_error', 'internal gateway error');
      else res.destroy();
    });
  };

  private sendJson(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }

  private sendError(res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}): void {
    this.sendJson(res, status, errorBody(type, message), headers);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://gateway.invalid');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    // 鉴权在读取请求体之前完成；失败时不读请求体、关闭连接（方案 §8.4）
    const auth = this.guard.authenticate(req.socket.remoteAddress, req.headers, path);
    if (!auth.ok) {
      const msg =
        auth.status === 401
          ? 'invalid x-api-key'
          : auth.status === 403
            ? 'forbidden'
            : 'too many requests';
      const type = auth.status === 401 ? 'authentication_error' : auth.status === 403 ? 'permission_error' : 'rate_limit_error';
      this.sendError(res, auth.status, type, msg, { connection: 'close' });
      res.on('finish', () => setTimeout(() => req.socket.destroy(), 1000).unref());
      return;
    }
    this.stats.requests++;
    try {
      if (req.method === 'POST' && path === '/v1/messages') return await this.messages(req, res, url, auth.key, auth.ip);
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') return await this.countTokens(req, res, url, auth.key);
      if (req.method === 'GET' && path === '/v1/models') return this.listModels(res, url, auth.key);
      if (req.method === 'GET' && path.startsWith('/v1/models/')) return this.getModel(res, decodeURIComponent(path.slice('/v1/models/'.length)), auth.key);
      throw new HttpError(404, 'not_found_error', `${req.method} ${path} not found`);
    } catch (e) {
      if (e instanceof HttpError) {
        this.sendError(res, e.status, e.type, e.message, e.headers);
        return;
      }
      throw e;
    }
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const limit = this.cfg.server.maxRequestBodyMB * 1024 * 1024;
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) throw new HttpError(413, 'request_too_large', `request body exceeds ${this.cfg.server.maxRequestBodyMB}MB`, { connection: 'close' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) throw new HttpError(413, 'request_too_large', `request body exceeds ${this.cfg.server.maxRequestBodyMB}MB`, { connection: 'close' });
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const buf = await this.readBody(req);
    try {
      const j = JSON.parse(buf.toString('utf8'));
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
      return j as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'invalid_request_error', 'request body is not valid JSON');
    }
  }

  private resolve(id: unknown, key: KeyRecord): ExposedModel {
    const ex = typeof id === 'string' ? this.cfg.exposed.get(id) : undefined;
    if (!ex) {
      const known = [...this.cfg.exposed.keys()].join(', ');
      throw new HttpError(404, 'not_found_error', `model: ${String(id)} is not configured on this gateway (configured: ${known})`);
    }
    if (key.allowedModels && !key.allowedModels.includes(ex.id) && !key.allowedModels.includes(ex.model.id))
      throw new HttpError(403, 'permission_error', `model: ${ex.id} is not allowed for this key`);
    if (!ex.model.channelRef.apiKey) throw new HttpError(503, 'api_error', `channel ${ex.model.channel} has no upstream key configured`);
    return ex;
  }

  private modelObject(ex: ExposedModel): Record<string, unknown> {
    const m = ex.model;
    const o: Record<string, unknown> = { type: 'model', id: ex.id, display_name: m.displayName, created_at: MODEL_CREATED_AT };
    if (ex.tier) {
      o.anthropic_family_tier = ex.tier;
      o.is_family_default = true;
    }
    o.supports_1m = m.contextWindow >= 1_000_000;
    o.max_input_tokens = m.contextWindow;
    o.max_effort_level = m.maxEffort;
    return o;
  }

  private visible(key: KeyRecord): ExposedModel[] {
    return [...this.cfg.exposed.values()].filter((ex) => !key.allowedModels || key.allowedModels.includes(ex.id) || key.allowedModels.includes(ex.model.id));
  }

  private listModels(res: ServerResponse, url: URL, key: KeyRecord): void {
    const all = this.visible(key);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 1000);
    const after = url.searchParams.get('after_id');
    let start = 0;
    if (after) {
      const i = all.findIndex((m) => m.id === after);
      start = i >= 0 ? i + 1 : all.length;
    }
    const page = all.slice(start, start + limit).map((ex) => this.modelObject(ex));
    const body = {
      data: page,
      has_more: start + limit < all.length,
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
    };
    this.sendJson(res, 200, JSON.stringify(body));
  }

  private getModel(res: ServerResponse, id: string, key: KeyRecord): void {
    const ex = this.visible(key).find((m) => m.id === id);
    if (!ex) throw new HttpError(404, 'not_found_error', `model: ${id} not found`);
    this.sendJson(res, 200, JSON.stringify(this.modelObject(ex)));
  }

  private async countTokens(req: IncomingMessage, res: ServerResponse, url: URL, key: KeyRecord): Promise<void> {
    const body = await this.readJson(req);
    const ex = this.resolve(body.model, key);
    const ch = ex.model.channelRef;
    // Coding Plan 渠道不由网关主动发起非交互调用（方案 §4.7、§6.3）
    if (ch.profile.countTokens === 'upstream' && !ch.interactiveOnly) {
      const out: Record<string, unknown> = { ...body, model: ex.model.upstreamModel };
      delete out.metadata;
      try {
        const up = await undiciRequest(ch.baseUrl + url.pathname + url.search, {
          method: 'POST',
          headers: buildUpstreamHeaders(req.headers, ch, []),
          body: JSON.stringify(out),
          dispatcher: this.pool.agentFor(ch),
          headersTimeout: 30_000,
          bodyTimeout: 30_000,
        });
        const text = await up.body.text();
        if (up.statusCode === 200) {
          this.sendJson(res, 200, text);
          return;
        }
        this.deps.logger.warn('count_tokens_upstream_failed', { channel: ch.id, status: up.statusCode });
      } catch (e) {
        this.deps.logger.warn('count_tokens_upstream_error', { channel: ch.id, err: String(e) });
      }
    }
    const est = this.calibrator.apply(ex.model.id, estimateInputTokens(body as never));
    this.sendJson(res, 200, JSON.stringify({ input_tokens: est }));
  }

  private rateLimitHeaders(ex: ExposedModel): Record<string, string> {
    const limit = ex.model.effectiveConcurrency;
    if (limit == null || this.cfg.limits.responseHeaders === 'off') return {};
    const { inFlight } = this.limiter.state(ex.model.id);
    return { 'ratelimit-policy': `"concurrency";q=${limit}`, ratelimit: `"concurrency";r=${Math.max(limit - inFlight, 0)}` };
  }

  private async messages(req: IncomingMessage, res: ServerResponse, url: URL, key: KeyRecord, ip: string): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const t0 = now();
    const reqId = 'req_cgw_' + randomBytes(10).toString('hex');
    const diags: Diagnostic[] = [];
    const body = await this.readJson(req);
    const ex = this.resolve(body.model, key);
    const model = ex.model;
    const ch = model.channelRef;
    const sess = sessionInfo(req.headers, (body.metadata as Record<string, unknown> | undefined)?.user_id);
    const obs = sess.line ? this.deps.sessions.observe(sess.line, ex.id, t0) : { switched: false, switchedNow: false, prevModel: null };
    if (obs.switchedNow) diags.push({ code: 'switch', action: 'observe', detail: `${obs.prevModel}→${ex.id}` });
    const stream = body.stream === true;
    const log: RequestLogEntry = {
      ts: t0,
      reqId,
      keyId: key.id,
      ip,
      session: sess.sessionId,
      agent: sess.agentId,
      reqClass: sess.requestClass,
      model: ex.id,
      channel: ch.id,
      upstreamModel: model.upstreamModel,
      stream,
      status: 0,
      ms: 0,
      diags,
    };
    const finish = (status: number, extra: Partial<RequestLogEntry> = {}): void => {
      Object.assign(log, extra, { status, ms: now() - t0 });
      if (status >= 400) this.stats.errors++;
      try {
        this.deps.requestLog.write(log);
      } catch (e) {
        this.deps.logger.error('request_log_write_failed', { err: String(e) });
      }
      this.deps.logger.info('request', {
        reqId,
        model: ex.id,
        channel: ch.id,
        class: sess.requestClass,
        status,
        ms: log.ms,
        ttfbMs: log.ttfbMs,
        usage: log.usage,
        errorType: log.errorType,
        diags: diags.filter((d) => d.code !== 'model_mapped' && d.code !== 'metadata_user_id_stripped' && d.code !== 'claude_code_headers_not_forwarded').map((d) => d.code),
      });
    };
    const fail = (status: number, type: string, message: string, headers: Record<string, string> = {}, errorType = type): void => {
      this.sendError(res, status, type, message, headers);
      finish(status, { errorType });
    };

    const displayOf = (id: string | null): string => (id ? (this.cfg.exposed.get(id)?.model.displayName ?? this.cfg.modelMap.get(id)?.displayName ?? id) : '');

    // 确定超出窗口时不调用上游，直接返回 cc 能识别的超长错误（桌面端接入 §4.3）
    const lb = lowerBoundTokens(body as never);
    if (lb > model.contextWindow) {
      diags.push({ code: 'overlong_precheck', action: 'reject', detail: `>=${lb} tokens` });
      return fail(400, 'invalid_request_error', overlongMessage(lb, model.contextWindow), {}, 'overlong_precheck');
    }

    const estimate = estimateInputTokens(body as never);
    try {
      const prepared = prepareRequestBody(body, { cfg: this.cfg, model, requestedId: ex.id, requestClass: sess.requestClass, switched: obs.switched, ledger: this.deps.ledger });
      diags.push(...prepared.diags);
    } catch (e) {
      if (e instanceof RequestValidationError) {
        diags.push({ code: e.code, action: 'reject' });
        return fail(400, 'invalid_request_error', e.message, {}, e.code);
      }
      throw e;
    }

    const abort = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        abort.abort(new Error('client_closed'));
      }
    });

    let release: Release;
    try {
      release = await this.limiter.acquire(model.id, model.effectiveConcurrency, this.cfg.limits.queueTimeoutMs, abort.signal);
    } catch (e) {
      if (e instanceof QueueTimeoutError) {
        diags.push({ code: 'cgw_concurrency_limit', action: 'reject' });
        const msg = fill(this.cfg.limits.rejectMessage, { 模型显示名: model.displayName, N: model.effectiveConcurrency ?? 0 });
        return fail(this.cfg.limits.rejectStatus, 'rate_limit_error', msg, { 'retry-after': String(this.cfg.limits.rejectRetryAfterSec), ...this.rateLimitHeaders(ex) }, 'cgw_concurrency_limit');
      }
      if (e instanceof QueueAbortedError) return finish(499, { errorType: 'client_closed_in_queue' });
      throw e;
    }
    const queuedMs = now() - t0;
    if (queuedMs > 1000) diags.push({ code: 'queued', action: 'observe', detail: `${queuedMs}ms` });

    const timeouts = ch.profile.timeouts;
    let timeoutReason: string | null = null;
    const sentAt = now();
    let gotFirstByte = false;
    let lastUpstreamAt = sentAt;
    let lastClientWriteAt = sentAt;
    let streaming = false;
    const watchdog = setInterval(() => {
      const t = now();
      if (!gotFirstByte) {
        if (timeouts.firstByteMs && t - sentAt > timeouts.firstByteMs) {
          timeoutReason = 'first_byte_timeout';
          abort.abort(new Error(timeoutReason));
        }
      } else if (timeouts.idleMs && t - lastUpstreamAt > timeouts.idleMs) {
        timeoutReason = 'idle_timeout';
        abort.abort(new Error(timeoutReason));
      }
      // 上游长时间不出字节时由网关发 ping 保活（方案 §4.3）
      if (streaming && this.cfg.server.pingIntervalMs && t - lastClientWriteAt >= this.cfg.server.pingIntervalMs && !res.writableEnded) {
        res.write(PING_EVENT);
        lastClientWriteAt = t;
      }
    }, 500);

    try {
      const headers = buildUpstreamHeaders(req.headers, ch, diags);
      let up;
      try {
        up = await undiciRequest(ch.baseUrl + url.pathname + url.search, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          dispatcher: this.pool.agentFor(ch),
          signal: abort.signal,
          headersTimeout: timeouts.firstByteMs || undefined,
          bodyTimeout: 0,
        });
      } catch (e) {
        if (clientGone) return finish(499, { errorType: 'client_closed' });
        const connectTimeout = e instanceof undiciErrors.ConnectTimeoutError;
        const reason = connectTimeout ? 'connect_timeout' : timeoutReason ?? (e instanceof undiciErrors.HeadersTimeoutError ? 'first_byte_timeout' : 'upstream_unreachable');
        const status = reason.endsWith('timeout') ? 504 : 502;
        this.deps.logger.warn('upstream_request_failed', { reqId, channel: ch.id, reason, err: String((e as Error)?.message ?? e) });
        return fail(status, 'api_error', `upstream ${ch.id}: ${reason.replace(/_/g, ' ')}`, {}, reason);
      }

      const upHeaders = filterResponseHeaders(up.headers);
      const ct = String(up.headers['content-type'] ?? '');

      if (up.statusCode >= 400) {
        gotFirstByte = true;
        const text = await up.body.text();
        const rewrite = rewriteUpstreamError(up.statusCode, text, {
          channel: ch,
          switched: obs.switched,
          historyMessage: () => fill(this.cfg.switchAdvice.messageTemplate, { 原模型: displayOf(obs.prevModel), 新模型: model.displayName }),
        });
        if (rewrite) {
          diags.push(rewrite.diag);
          this.sendJson(res, rewrite.status, rewrite.body, { ...pick(upHeaders, ['retry-after', 'x-ds-trace-id', 'request-id', 'x-request-id']), 'x-cgw-request-id': reqId });
          return finish(rewrite.status, { errorType: rewrite.kind, ttfbMs: now() - sentAt });
        }
        if (up.statusCode === 401 || up.statusCode === 403) this.deps.logger.warn('upstream_auth_failed', { reqId, channel: ch.id, status: up.statusCode });
        res.writeHead(up.statusCode, { ...upHeaders, 'content-type': ct || 'application/json', 'x-cgw-request-id': reqId });
        res.end(text);
        return finish(up.statusCode, { errorType: 'upstream_error', ttfbMs: now() - sentAt });
      }

      if (ct.includes('text/event-stream')) {
        streaming = true;
        res.writeHead(up.statusCode, { ...upHeaders, 'cache-control': 'no-cache', 'x-cgw-request-id': reqId, ...this.rateLimitHeaders(ex) });
        lastClientWriteAt = now();
        const rw = new SseRewriter(ex.id);
        let ttfb: number | null = null;
        try {
          for await (const chunk of up.body) {
            lastUpstreamAt = now();
            if (!gotFirstByte) {
              // 首字节以首个内容事件为准：message_start 之后、首 token 之前的预填阶段仍按首字节超时计
              const outs = rw.push(chunk as Buffer);
              if (rw.gotContent) {
                gotFirstByte = true;
                ttfb = now() - sentAt;
              }
              for (const o of outs) if (!res.write(o)) await once(res, 'drain');
            } else {
              for (const o of rw.push(chunk as Buffer)) if (!res.write(o)) await once(res, 'drain');
            }
            lastClientWriteAt = now();
          }
          const rest = rw.flush();
          if (rest) res.write(rest);
          res.end();
        } catch (e) {
          if (clientGone) return finish(499, { errorType: 'client_closed', usage: rw.usage, ttfbMs: ttfb });
          const reason = timeoutReason ?? 'upstream_stream_error';
          this.deps.logger.warn('upstream_stream_failed', { reqId, channel: ch.id, reason, err: String((e as Error)?.message ?? e) });
          if (!res.writableEnded) {
            res.write(sseErrorEvent('api_error', `upstream ${ch.id}: ${reason.replace(/_/g, ' ')}`));
            res.end();
          }
          return finish(200, { errorType: reason, usage: rw.usage, ttfbMs: ttfb });
        }
        this.afterResponse(ex.id, rw.blocksForLedger(), rw.usage, estimate, diags);
        if (!rw.rewroteModel) diags.push({ code: 'message_start_missing', action: 'observe' });
        return finish(200, { usage: rw.usage, ttfbMs: ttfb, errorType: rw.streamError ? `stream_error:${rw.streamError.type ?? ''}` : null });
      }

      const text = await (async () => {
        const parts: Buffer[] = [];
        for await (const c of up.body) {
          lastUpstreamAt = now();
          gotFirstByte = true;
          parts.push(c as Buffer);
        }
        return Buffer.concat(parts).toString('utf8');
      })().catch((e) => {
        throw Object.assign(e as Error, { during: 'body' });
      });
      let out = text;
      let usage: Usage | undefined;
      try {
        const j = JSON.parse(text) as Record<string, any>;
        if (j && typeof j === 'object' && j.type === 'message') {
          j.model = ex.id;
          usage = j.usage;
          this.afterResponse(ex.id, (j.content ?? []).filter((b: any) => b?.type === 'thinking' || b?.type === 'redacted_thinking'), usage ?? {}, estimate, diags);
          out = JSON.stringify(j);
        }
      } catch {
        diags.push({ code: 'non_json_response', action: 'passthrough' });
      }
      res.writeHead(up.statusCode, { ...upHeaders, 'content-type': ct || 'application/json', 'content-length': String(Buffer.byteLength(out)), 'x-cgw-request-id': reqId, ...this.rateLimitHeaders(ex) });
      res.end(out);
      return finish(up.statusCode, { usage, ttfbMs: now() - sentAt });
    } catch (e) {
      if (clientGone) return finish(499, { errorType: 'client_closed' });
      const reason = timeoutReason ?? 'upstream_body_error';
      this.deps.logger.warn('upstream_failed', { reqId, channel: ch.id, reason, err: String((e as Error)?.message ?? e) });
      if (!res.headersSent) return fail(reason.endsWith('timeout') ? 504 : 502, 'api_error', `upstream ${ch.id}: ${reason.replace(/_/g, ' ')}`, {}, reason);
      res.destroy();
      return finish(502, { errorType: reason });
    } finally {
      clearInterval(watchdog);
      release();
    }
  }

  private afterResponse(modelId: string, blocks: { type: string }[], usage: Usage, estimate: number, diags: Diagnostic[]): void {
    if (blocks.length) {
      try {
        this.deps.ledger.register(blocks as never, modelId);
      } catch (e) {
        this.deps.logger.warn('ledger_write_failed', { err: String(e) });
      }
    }
    const actual = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (actual) this.calibrator.observe(modelId, estimate, actual);
    if (usage.cache_read_input_tokens === undefined && usage.input_tokens !== undefined) diags.push({ code: 'usage_cache_fields_missing', action: 'observe' });
  }

  snapshot(): Record<string, unknown> {
    return {
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      stats: this.stats,
      bannedIps: this.guard.bannedCount(),
      concurrency: Object.fromEntries(
        [...this.cfg.modelMap.values()].filter((m) => m.channelRef.enabled).map((m) => [m.id, { displayName: m.displayName, channel: m.channel, limit: m.effectiveConcurrency, ...this.limiter.state(m.id) }]),
      ),
    };
  }
}

function pick(h: Record<string, string>, keys: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of keys) if (h[k] !== undefined) o[k] = h[k];
  return o;
}
