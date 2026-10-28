import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CONCURRENCY_LIMIT_MESSAGE, HISTORY_INCOMPATIBLE_MESSAGE, fill } from '../../src/config/texts.js';
import { fixture, mockUpstream, sleep, startGateway, testConfig, type Harness } from '../helpers.js';

const SSE = fixture('deepseek/stream-thinking-tool-use.sse');
const NONSTREAM = fixture('deepseek/nonstream-thinking.json');
const SESSION = { 'x-claude-code-session-id': 's-1', 'x-claude-code-request-class': 'main' };

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(handler: Parameters<typeof mockUpstream>[0], overrides?: (raw: any) => void) {
  const up = await mockUpstream(handler);
  const h = await startGateway(testConfig(up.url, overrides));
  cleanups.push(up.close, h.close);
  return { up, h };
}

function post(h: Harness, body: unknown, headers: Record<string, string> = {}, path = '/v1/messages?beta=true') {
  return fetch(h.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.key}`, 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
  });
}

const sseHandler = (_c: any, _req: any, res: any) => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-ds-trace-id': 'trace' });
  res.end(SSE);
};

describe('edge guard', () => {
  it('rejects a missing key with 401 before reading the body', async () => {
    const { up, h } = await setup(sseHandler);
    const port = Number(new URL(h.url).port);
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    // 声明 10MB 请求体但不发送：网关必须只看请求头就回 401
    sock.write('POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\n\r\n{');
    const data = await new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    sock.destroy();
    expect(data).toMatch(/^HTTP\/1\.1 401/);
    expect(data).toContain('authentication_error');
    expect(up.calls).toHaveLength(0);
  });

  it('answers 401 on every path without a key, and serves /health unauthenticated', async () => {
    const { h } = await setup(sseHandler);
    expect((await fetch(h.url + '/admin')).status).toBe(401);
    expect((await fetch(h.url + '/v1/models')).status).toBe(401);
    const health = await fetch(h.url + '/health');
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect((await fetch(h.url + '/nope', { headers: { authorization: `Bearer ${h.key}` } })).status).toBe(404);
  });

  it('bans an IP after repeated failures and logs only the key prefix', async () => {
    const { h } = await setup(sseHandler);
    const bad = 'cgw_' + 'A'.repeat(43);
    for (let i = 0; i < 5; i++) expect((await fetch(h.url + '/v1/models', { headers: { 'x-api-key': bad } })).status).toBe(401);
    expect((await fetch(h.url + '/v1/models', { headers: { 'x-api-key': h.key } })).status).toBe(403);
    expect(h.logs.join('\n')).not.toContain(bad);
    const rows = h.db.prepare('SELECT key_prefix FROM auth_failures').all() as any[];
    expect(rows.every((r) => r.key_prefix === 'cgw_AAAA')).toBe(true);
  });
});

describe('/v1/models', () => {
  it('returns the fields the desktop app reads, with tier alias, and pages', async () => {
    const { h } = await setup(sseHandler);
    const r = await fetch(h.url + '/v1/models?limit=1000', { headers: { 'x-api-key': h.key } });
    const j = await r.json();
    expect(j.data.map((m: any) => m.id)).toEqual(['claude-gw-dsflash', 'claude-gw-zp53flash-plan', 'claude-gw-dsflash-haiku']);
    expect(j.data[0]).toMatchObject({ type: 'model', display_name: 'DeepSeek V4.1 Flash（官方）', anthropic_family_tier: 'sonnet', is_family_default: true, supports_1m: true, max_input_tokens: 1048576, max_effort_level: 'max' });
    expect(j.has_more).toBe(false);
    const p1 = await (await fetch(h.url + '/v1/models?limit=2', { headers: { 'x-api-key': h.key } })).json();
    expect(p1.has_more).toBe(true);
    const p2 = await (await fetch(h.url + `/v1/models?limit=2&after_id=${p1.last_id}`, { headers: { 'x-api-key': h.key } })).json();
    expect(p2.data.map((m: any) => m.id)).toEqual(['claude-gw-dsflash-haiku']);
  });
});

describe('/v1/messages passthrough', () => {
  it('streams upstream bytes, echoes the external id, swaps auth and strips private fields', async () => {
    const { up, h } = await setup(sseHandler);
    const r = await post(
      h,
      { model: 'claude-gw-dsflash-haiku', max_tokens: 32000, stream: true, metadata: { user_id: '{"device_id":"d","account_uuid":"a","session_id":"s-1"}' }, messages: [{ role: 'user', content: 'hi' }] },
      { ...SESSION, 'anthropic-beta': 'claude-code-20250219', 'x-claude-code-agent-id': 'a1' },
    );
    expect(r.status).toBe(200);
    const text = await r.text();
    const events = text.split('\n\n');
    expect(JSON.parse(events[0].split('data: ')[1]).message.model).toBe('claude-gw-dsflash-haiku');
    expect(events.slice(1)).toEqual(SSE.split('\n\n').slice(1));
    const call = up.calls[0];
    expect(call.url).toBe('/anthropic/v1/messages?beta=true');
    expect(call.body.model).toBe('deepseek-flash');
    expect(call.body.metadata).toBeUndefined();
    expect(call.headers['x-api-key']).toBe('sk-upstream-ds-0000000000');
    expect(call.headers.authorization).toBeUndefined();
    expect(Object.keys(call.headers).some((k) => k.startsWith('x-claude-code-'))).toBe(false);
    expect(call.headers['anthropic-beta']).toBe('claude-code-20250219');
    expect(r.headers.get('x-ds-trace-id')).toBe('trace');
    const log = h.db.prepare('SELECT * FROM request_log').get() as any;
    expect(log).toMatchObject({ model: 'claude-gw-dsflash-haiku', channel: 'deepseek', status: 200, session: 's-1', agent: 'a1' });
    expect(log.input_tokens).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain('hi');
  });

  it('echoes the external id on non-streaming responses', async () => {
    const { h } = await setup((_c, _r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(NONSTREAM);
    });
    const j = await (await post(h, { model: 'claude-gw-dsflash', max_tokens: 100, messages: [{ role: 'user', content: '2+2' }] })).json();
    expect(j.model).toBe('claude-gw-dsflash');
    expect(j.content[0].type).toBe('thinking');
  });

  it('uses bearer auth, strips declared beta values and clamps max_tokens for the plan channel', async () => {
    const { up, h } = await setup(sseHandler);
    await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 500000, stream: true, messages: [{ role: 'user', content: 'x' }] }, { 'anthropic-beta': 'context-1m-2025-08-07,claude-code-20250219' })).text();
    const call = up.calls[0];
    expect(call.headers.authorization).toBe('Bearer plan-upstream-0000000000');
    expect(call.headers['x-api-key']).toBeUndefined();
    expect(call.headers['anthropic-beta']).toBe('claude-code-20250219');
    expect(call.body.max_tokens).toBe(131072);
  });

  it('relays the GLM stream byte-for-byte and logs usage from message_delta', async () => {
    const GLM_SSE = fixture('zhipu-coding/stream-thinking-tool-use.sse');
    const { h } = await setup((_c, _r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(GLM_SSE);
    });
    const text = await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 32000, stream: true, messages: [{ role: 'user', content: 'x' }] }, SESSION)).text();
    const events = text.split('\n\n');
    expect(JSON.parse(events[0].split('data: ')[1]).message.model).toBe('claude-gw-zp53flash-plan');
    expect(events.slice(1)).toEqual(GLM_SSE.split('\n\n').slice(1));
    const log = h.db.prepare('SELECT * FROM request_log').get() as any;
    expect(log).toMatchObject({ model: 'claude-gw-zp53flash-plan', channel: 'plan', status: 200, input_tokens: 169, output_tokens: 29 });
  });

  it('removes toolStrip tools (and a tool_choice naming them) before forwarding', async () => {
    const { up, h } = await setup(sseHandler, (raw) => (raw.channels[1].profile.toolStrip = ['ToolSearch']));
    const tool = (name: string) => ({ name, description: name, input_schema: { type: 'object', properties: {} } });
    const body = { model: 'claude-gw-zp53flash-plan', max_tokens: 100, stream: true, tools: [tool('Bash'), tool('ToolSearch'), tool('Read')], messages: [{ role: 'user', content: 'x' }] };
    await (await post(h, { ...body, tool_choice: { type: 'tool', name: 'ToolSearch' } }, SESSION)).text();
    expect(up.calls[0].body.tools.map((t: any) => t.name)).toEqual(['Bash', 'Read']);
    expect(up.calls[0].body.tool_choice).toBeUndefined();
    await (await post(h, { ...body, model: 'claude-gw-dsflash' }, SESSION)).text();
    expect(up.calls[1].body.tools.map((t: any) => t.name)).toEqual(['Bash', 'ToolSearch', 'Read']);
    const log = h.db.prepare("SELECT diags FROM request_log WHERE model = 'claude-gw-zp53flash-plan'").get() as any;
    expect(log.diags).toContain('tool_stripped');
  });

  it('returns not_found_error for unknown models', async () => {
    const { up, h } = await setup(sseHandler);
    const r = await post(h, { model: 'claude-haiku-4-5', max_tokens: 10, messages: [] });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatchObject({ type: 'not_found_error' });
    expect(up.calls).toHaveLength(0);
  });

  it('rejects unpaired tool_use before calling upstream', async () => {
    const { up, h } = await setup(sseHandler);
    const r = await post(h, {
      model: 'claude-gw-dsflash',
      max_tokens: 10,
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
        { role: 'user', content: 'no result' },
      ],
    });
    expect(r.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });
});

describe('error rewrites end to end', () => {
  const errHandler = (fx: string) => (_c: any, _r: any, res: any) => {
    const f = JSON.parse(fixture(fx));
    res.writeHead(f.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(f.body));
  };

  it('rewrites the DeepSeek overlong error so cc compacts', async () => {
    const { h } = await setup(errHandler('deepseek/error-overlong.json'));
    const r = await post(h, { model: 'claude-gw-dsflash', max_tokens: 32000, stream: true, messages: [{ role: 'user', content: 'x' }] });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe('prompt is too long: 1132004 tokens > 1048576 maximum');
    const log = h.db.prepare('SELECT diags, error_type FROM request_log').get() as any;
    expect(log.error_type).toBe('overlong');
    expect(log.diags).toContain('overlong_error_rewritten');
  });

  it('precheck rejects requests that certainly exceed the window without calling upstream', async () => {
    const { up, h } = await setup(sseHandler, (raw) => (raw.models['claude-gw-dsflash'].contextWindow = 1000));
    const r = await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, messages: [{ role: 'user', content: 'a'.repeat(20000) }] });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/^prompt is too long: \d+ tokens > 1000 maximum$/);
    expect(up.calls).toHaveLength(0);
  });

  it('returns the confirmed history advice after a switch to a channel that rejects the history', async () => {
    const { up, h } = await setup(sseHandler);
    await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }, SESSION)).text();
    const f = JSON.parse(fixture('deepseek/error-thinking-must-be-passed-back.json'));
    up.setHandler((_c, _r, res) => {
      res.writeHead(f.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(f.body));
    });
    const r = await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }, SESSION);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.type).toBe('invalid_request_error');
    expect(j.error.message).toBe(fill(HISTORY_INCOMPATIBLE_MESSAGE, { 原模型: 'GLM-5.3-Flash（智谱 Coding Plan）', 新模型: 'DeepSeek V4.1 Flash（官方）' }));
  });

  it('passes the same upstream error through untouched when there was no switch', async () => {
    const f = JSON.parse(fixture('deepseek/error-thinking-must-be-passed-back.json'));
    const { h } = await setup(errHandler('deepseek/error-thinking-must-be-passed-back.json'));
    const r = await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, SESSION);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual(f.body);
  });

  it('passes upstream 401 through as-is', async () => {
    const f = JSON.parse(fixture('deepseek/error-auth-invalid.json'));
    const { h } = await setup(errHandler('deepseek/error-auth-invalid.json'));
    const r = await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual(f.body);
  });
});

describe('concurrency', () => {
  it('queues, then returns 429 with retry-after 120 and the confirmed message', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const { h } = await setup(
      async (_c, _r, res) => {
        await gate;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(SSE);
      },
      (raw) => {
        raw.models['claude-gw-zp53flash-plan'].concurrency = 1;
        raw.limits = { queueTimeoutMs: 300 };
      },
    );
    const body = { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] };
    const first = post(h, body);
    await sleep(50);
    const second = await post(h, body);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('120');
    const j = await second.json();
    expect(j.error.type).toBe('rate_limit_error');
    expect(j.error.message).toBe(fill(CONCURRENCY_LIMIT_MESSAGE, { 模型显示名: 'GLM-5.3-Flash（智谱 Coding Plan）', N: 1 }));
    releaseFirst();
    const r1 = await first;
    expect(r1.headers.get('ratelimit-policy')).toBe('"concurrency";q=1');
    await r1.text();
    expect(h.gw.limiter.state('claude-gw-zp53flash-plan')).toEqual({ inFlight: 0, queued: 0 });
  });

  it('appends the confirmed concurrency hint as the last system block for main/subagent requests only', async () => {
    const { up, h } = await setup(sseHandler);
    const sys = [
      { type: 'text', text: 'billing' },
      { type: 'text', text: 'main', cache_control: { type: 'ephemeral' } },
    ];
    await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, system: sys, messages: [{ role: 'user', content: 'x' }] }, SESSION)).text();
    const hint = '[claude-gateway] 你当前使用的模型渠道同时最多处理 2 个请求（主对话与所有子 agent 合计）。并行启动子 agent 或批量并行调用工具时，请让同时运行的子 agent 不超过 1 个；任务较多时分批进行，等前一批完成后再启动下一批。超出上限的请求会排队，排队超过 60 秒会失败。';
    expect(up.calls[0].body.system).toEqual([...sys, { type: 'text', text: hint }]);
    await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, system: 'plain', messages: [{ role: 'user', content: 'x' }] }, { 'x-claude-code-request-class': 'subagent' })).text();
    expect(up.calls[1].body.system).toEqual([{ type: 'text', text: 'plain' }, { type: 'text', text: hint }]);
    await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, system: 'plain', messages: [{ role: 'user', content: 'x' }] }, { 'x-claude-code-request-class': 'auxiliary' })).text();
    expect(up.calls[2].body.system).toBe('plain');
    // DeepSeek 渠道未配置并发上限：不注入
    await (await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, stream: true, system: 'plain', messages: [{ role: 'user', content: 'x' }] }, SESSION)).text();
    expect(up.calls[3].body.system).toBe('plain');
  });
});

describe('timeouts and cancellation', () => {
  const partial = SSE.split('\n\n').slice(0, 4).join('\n\n') + '\n\n';

  it('ends the stream with an error event on idle timeout and releases the slot', async () => {
    const { h } = await setup(
      (_c, _r, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(partial);
      },
      (raw) => (raw.channels[1].profile.timeouts = { connectMs: 1000, firstByteMs: 3000, idleMs: 600 }),
    );
    const r = await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] });
    const text = await r.text();
    expect(text).toContain('event: error');
    expect(text).toContain('idle timeout');
    expect(text).not.toContain('message_stop');
    expect(h.gw.limiter.state('claude-gw-zp53flash-plan').inFlight).toBe(0);
  });

  it('first-byte timeout covers the gap between message_start and the first content event', async () => {
    const start = SSE.split('\n\n')[0] + '\n\n';
    const { h } = await setup(
      (_c, _r, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(start);
      },
      (raw) => (raw.channels[1].profile.timeouts = { connectMs: 1000, firstByteMs: 800, idleMs: 100 }),
    );
    const t0 = Date.now();
    const text = await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] })).text();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    expect(text).toContain('first byte timeout');
  });

  it('cancels upstream when the client disconnects and releases exactly once', async () => {
    const { up, h } = await setup((_c, _r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(partial);
    });
    const ac = new AbortController();
    const r = await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }).then((x) => x);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    ac.abort();
    for (let i = 0; i < 40 && !up.calls[0].aborted; i++) await sleep(25);
    expect(up.calls[0].aborted).toBe(true);
    await sleep(50);
    expect(h.gw.limiter.state('claude-gw-zp53flash-plan')).toEqual({ inFlight: 0, queued: 0 });
    const log = h.db.prepare('SELECT status, error_type FROM request_log').get() as any;
    expect(log).toMatchObject({ status: 499, error_type: 'client_closed' });
  });

  it('sends ping while upstream is silent', async () => {
    const { h } = await setup(
      async (_c, _r, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(SSE.split('\n\n')[0] + '\n\n');
        await sleep(1300);
        res.end(SSE.split('\n\n').slice(1).join('\n\n'));
      },
      (raw) => (raw.server.pingIntervalMs = 400),
    );
    const text = await (await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] })).text();
    const pings = text.split('\n\n').filter((e) => e.startsWith('event: ping')).length;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(text).toContain('message_stop');
  });
});

describe('thinking replay after a user switch', () => {
  it('registers thinking origin and filters foreign thinking for strip-foreign channels only after a switch', async () => {
    const { up, h } = await setup(sseHandler);
    // 第一轮：DeepSeek 产生 thinking（来源登记）
    const t1 = await (await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }, SESSION)).text();
    const sig = /"signature":"([^"]*)"/.exec(t1);
    const thinkingText = [...t1.matchAll(/"thinking_delta","thinking":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
    const history = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingText, signature: sig ? sig[1] : '' }, { type: 'text', text: 'ok' }] },
      { role: 'user', content: 'y' },
    ];
    // 同一会话线、同一模型：完全不动
    await (await post(h, { model: 'claude-gw-dsflash', max_tokens: 10, stream: true, messages: history }, SESSION)).text();
    expect(up.calls[1].body.messages[1].content[0].type).toBe('thinking');
    // 切到 strip-foreign 渠道：DeepSeek 的 thinking 被去掉
    await (await post(h, { model: 'claude-gw-zp53flash-plan', max_tokens: 10, stream: true, messages: history }, SESSION)).text();
    expect(up.calls[2].body.messages[1].content).toEqual([{ type: 'text', text: 'ok' }]);
    const diags = (h.db.prepare('SELECT diags FROM request_log ORDER BY rowid DESC LIMIT 1').get() as any).diags;
    expect(diags).toContain('switch');
    expect(diags).toContain('thinking_removed');
  });
});

describe('count_tokens', () => {
  it('forwards to the upstream for payg channels and estimates for coding-plan channels', async () => {
    const { up, h } = await setup((c, _r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 32 }));
    });
    const a = await (await post(h, { model: 'claude-gw-dsflash', messages: [{ role: 'user', content: 'hello world' }] }, {}, '/v1/messages/count_tokens')).json();
    expect(a).toEqual({ input_tokens: 32 });
    expect(up.calls[0].url).toBe('/anthropic/v1/messages/count_tokens');
    expect(up.calls[0].body.model).toBe('deepseek-flash');
    const b = await (await post(h, { model: 'claude-gw-zp53flash-plan', messages: [{ role: 'user', content: 'hello world' }] }, {}, '/v1/messages/count_tokens')).json();
    expect(b.input_tokens).toBeGreaterThan(0);
    expect(up.calls).toHaveLength(1);
  });
});
