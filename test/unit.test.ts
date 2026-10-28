import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter, QueueAbortedError, QueueTimeoutError } from '../src/limits/concurrency.js';
import { SseRewriter } from '../src/protocol/anthropic/sse.js';
import { rewriteUpstreamError } from '../src/protocol/anthropic/errors.js';
import { filterThinking, validateToolPairing, RequestValidationError } from '../src/protocol/anthropic/request.js';
import { ThinkingLedger } from '../src/router/session.js';
import { openDb } from '../src/store/db.js';
import { redact } from '../src/observability/log.js';
import { KeyStore } from '../src/auth/keys.js';
import { loadConfigFile } from '../src/config/load.js';
import { fixture, testConfig } from './helpers.js';
import { join } from 'node:path';

describe('SseRewriter', () => {
  it('rewrites only message_start.model and keeps every other byte', () => {
    const raw = fixture('deepseek/stream-thinking-tool-use.sse');
    const rw = new SseRewriter('claude-gw-dsflash');
    // 以随机切分模拟网络分片
    const bytes = Buffer.from(raw);
    let out = '';
    for (let i = 0; i < bytes.length; i += 37) out += rw.push(bytes.subarray(i, i + 37)).join('');
    out += rw.flush();
    const before = raw.split('\n\n');
    const after = out.split('\n\n');
    expect(after.length).toBe(before.length);
    expect(JSON.parse(after[0].split('data: ')[1]).message.model).toBe('claude-gw-dsflash');
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(rw.gotContent).toBe(true);
    expect(rw.stopReason).toBe('tool_use');
    expect(rw.usage.input_tokens).toBeGreaterThan(0);
    const [thinking] = rw.blocksForLedger();
    expect(thinking.type).toBe('thinking');
    expect(thinking.signature).toMatch(/^[0-9a-f-]{36}$/);
    expect(thinking.thinking!.length).toBeGreaterThan(10);
  });
  it('handles the GLM stream: spaced JSON, zero usage in message_start, signature via signature_delta', () => {
    const raw = fixture('zhipu-coding/stream-thinking-tool-use.sse');
    const rw = new SseRewriter('claude-gw-zp53flash-plan');
    const bytes = Buffer.from(raw);
    let out = '';
    for (let i = 0; i < bytes.length; i += 29) out += rw.push(bytes.subarray(i, i + 29)).join('');
    out += rw.flush();
    const before = raw.split('\n\n');
    const after = out.split('\n\n');
    expect(after.length).toBe(before.length);
    expect(JSON.parse(after[0].split('data: ')[1]).message.model).toBe('claude-gw-zp53flash-plan');
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(rw.stopReason).toBe('tool_use');
    expect(rw.usage.input_tokens).toBe(169);
    expect(rw.usage.cache_read_input_tokens).toBe(0);
    const [thinking] = rw.blocksForLedger();
    expect(thinking.signature).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('ConcurrencyLimiter', () => {
  it('queues, times out and releases idempotently', async () => {
    const l = new ConcurrencyLimiter();
    const r1 = await l.acquire('m', 1, 50);
    const p2 = l.acquire('m', 1, 50);
    await expect(p2).rejects.toBeInstanceOf(QueueTimeoutError);
    const p3 = l.acquire('m', 1, 1000);
    r1();
    r1();
    const r3 = await p3;
    expect(l.state('m')).toEqual({ inFlight: 1, queued: 0 });
    r3();
    expect(l.state('m')).toEqual({ inFlight: 0, queued: 0 });
  });
  it('drops a queued waiter when the client goes away', async () => {
    const l = new ConcurrencyLimiter();
    const r1 = await l.acquire('m', 1, 1000);
    const ac = new AbortController();
    const p = l.acquire('m', 1, 1000, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(QueueAbortedError);
    expect(l.state('m').queued).toBe(0);
    r1();
  });
  it('null limit never queues', async () => {
    const l = new ConcurrencyLimiter();
    const rs = await Promise.all([1, 2, 3].map(() => l.acquire('x', null, 10)));
    expect(l.state('x').inFlight).toBe(3);
    rs.forEach((r) => r());
  });
});

describe('error rewrites', () => {
  const cfg = testConfig('http://127.0.0.1:9');
  const ch = cfg.channelMap.get('deepseek')!;
  const ctx = (switched: boolean) => ({ channel: ch, switched, historyMessage: () => 'HISTORY' });
  it('rewrites the DeepSeek overlong wording to the cc-recognized form', () => {
    const f = JSON.parse(fixture('deepseek/error-overlong.json'));
    const r = rewriteUpstreamError(f.status, JSON.stringify(f.body), ctx(false));
    expect(r?.kind).toBe('overlong');
    expect(JSON.parse(r!.body)).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1132004 tokens > 1048576 maximum' } });
  });
  it('passes through wording cc already recognizes', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' } });
    expect(rewriteUpstreamError(400, body, ctx(false))).toBeNull();
  });
  it('turns the must-be-passed-back 400 into the history advice only after a switch', () => {
    const f = JSON.parse(fixture('deepseek/error-thinking-must-be-passed-back.json'));
    expect(rewriteUpstreamError(f.status, JSON.stringify(f.body), ctx(false))).toBeNull();
    const r = rewriteUpstreamError(f.status, JSON.stringify(f.body), ctx(true));
    expect(r?.kind).toBe('history_incompatible');
    expect(JSON.parse(r!.body).error.message).toBe('HISTORY');
  });
  it('leaves other errors alone', () => {
    const f = JSON.parse(fixture('deepseek/error-unknown-model.json'));
    expect(rewriteUpstreamError(f.status, JSON.stringify(f.body), ctx(true))).toBeNull();
    expect(rewriteUpstreamError(500, '{}', ctx(true))).toBeNull();
  });
  it('passes GLM errors through unchanged (no overlong / replay / signature rule matches)', () => {
    const ex = loadConfigFile(join(import.meta.dirname, '../config/gateway.example.yaml'), {});
    const zctx = { channel: ex.channelMap.get('zhipu-coding')!, switched: true, historyMessage: () => 'HISTORY' };
    for (const fx of ['zhipu-coding/error-unknown-model.json', 'zhipu-coding/error-max-tokens-over.json', 'zhipu-api/error-1113-insufficient-balance.json', 'zhipu-api/error-1210-thinking-disabled.json']) {
      const f = JSON.parse(fixture(fx));
      expect(rewriteUpstreamError(f.status, JSON.stringify(f.body), zctx)).toBeNull();
    }
  });
});

describe('tool pairing', () => {
  it('skips interleaved system messages and rejects missing results', () => {
    const ok = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
      { role: 'system', content: 'env' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
    ];
    expect(() => validateToolPairing(ok as any)).not.toThrow();
    const bad = [ok[0], ok[1], { role: 'user', content: [{ type: 'text', text: 'no result' }] }];
    expect(() => validateToolPairing(bad as any)).toThrow(RequestValidationError);
  });
});

describe('thinking filter', () => {
  const cfg = testConfig('http://127.0.0.1:9');
  const db = openDb(':memory:');
  const ledger = new ThinkingLedger(db);
  const own = { type: 'thinking', thinking: 'mine', signature: 'sig-own' };
  ledger.register([own], 'claude-gw-zp53flash-plan');
  const msgs = () => [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ ...own, cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign', signature: 'x' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'unsigned' }, { type: 'redacted_thinking', data: 'zz' }, { type: 'text', text: 'b' }] },
  ];
  it('strip-foreign keeps only blocks registered to the target and drops their cache_control', () => {
    const m = msgs();
    const diags: any[] = [];
    filterThinking(m as any, { model: cfg.modelMap.get('claude-gw-zp53flash-plan')!, requestedId: 'claude-gw-zp53flash-plan', ledger }, diags);
    expect(m[1].content).toEqual([own, { type: 'text', text: 'a' }]);
    expect(m[2].content).toEqual([{ type: 'text', text: '[Thinking removed]' }]);
    expect(m[3].content).toEqual([{ type: 'text', text: 'b' }]);
    expect(diags.map((d) => d.code)).toEqual(['thinking_removed', 'thinking_cache_control_removed']);
  });
  it('passthrough keeps everything except unsupported redacted_thinking', () => {
    const m = msgs();
    filterThinking(m as any, { model: cfg.modelMap.get('claude-gw-dsflash')!, requestedId: 'claude-gw-dsflash', ledger }, []);
    expect(m[1].content[0]).toHaveProperty('cache_control');
    expect(m[2].content).toHaveLength(1);
    expect((m[3].content as any[]).map((b) => b.type)).toEqual(['thinking', 'text']);
  });
  it('the measured zhipu-coding profile keeps every thinking block, redacted_thinking included', () => {
    const ex = loadConfigFile(join(import.meta.dirname, '../config/gateway.example.yaml'), {});
    const model = ex.modelMap.get('claude-gw-zp53flash-plan')!;
    expect(model.channelRef.profile).toMatchObject({ thinkingReplay: 'passthrough', redactedThinking: 'supported', betaStrip: [], toolStrip: ['ToolSearch'] });
    const m = msgs();
    const diags: any[] = [];
    filterThinking(m as any, { model, requestedId: model.id, ledger }, diags);
    expect(m).toEqual(msgs());
    expect(diags).toEqual([]);
  });
});

describe('keys and redaction', () => {
  it('creates cgw_ keys, stores only the hash, verifies and revokes', () => {
    const db = openDb(':memory:');
    const ks = new KeyStore(db, 0);
    const { key, record } = ks.create('me', { expiresDays: 1 });
    expect(key).toMatch(/^cgw_[0-9A-Za-z]{43}$/);
    const row = db.prepare('SELECT * FROM api_keys').get() as any;
    expect(JSON.stringify(row)).not.toContain(key);
    expect(ks.verify(key)?.id).toBe(record.id);
    expect(ks.verify(key + 'x')).toBeNull();
    expect(ks.verify(key, Date.now() + 2 * 86400_000)).toBeNull();
    ks.revoke(record.prefix);
    expect(ks.verify(key)).toBeNull();
  });
  it('masks secrets in log lines', () => {
    const key = 'cgw_' + '0123456789abcdefghij'.repeat(2) + 'XYZ';
    const s = redact(`{"a":"Bearer sk-abcdefghijklmnop","k":"${key}","z":"sk-1234567890abcdef","d":"cgw_concurrency_limit","r":"req_cgw_1a2b-sk-3c4d5e6f7a8b"}`);
    expect(s).not.toMatch(/abcdefghijklmnop|0123456789abcdefghij|1234567890abcdef/);
    expect(s).toContain('cgw_concurrency_limit');
    expect(s).toContain('req_cgw_1a2b-sk-3c4d5e6f7a8b');
  });
});
