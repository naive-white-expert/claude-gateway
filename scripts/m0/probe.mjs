#!/usr/bin/env node
// M0 渠道级协议行为探测（方案 §9 M0）。
// 用法：node scripts/m0/probe.mjs --channel deepseek --out <目录> [--cases a,b,c]
// 上游 key 只从环境变量读取（见 CHANNELS[*].keyEnv），不写入输出。输出只含状态码、
// 白名单响应头、错误体与结构摘要（thinking / 正文只记长度与前 80 字符）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const CHANNELS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash', auth: 'x-api-key' },
  'zhipu-api': { baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyEnv: 'ZHIPU_API_KEY', model: 'glm-5.3-flash', auth: 'x-api-key' },
  'zhipu-coding': { baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyEnv: 'ZHIPU_CODING_API_KEY', model: 'glm-5.3-flash', auth: 'x-api-key' },
  'ark-coding': { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', keyEnv: 'ARK_CODING_API_KEY', model: 'deepseek-v4-flash', auth: 'bearer' },
};

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const ch = CHANNELS[args.channel];
if (!ch) throw new Error(`unknown channel ${args.channel}`);
if (args.model) ch.model = args.model;
const key = process.env[ch.keyEnv] ?? '';
const outDir = args.out ?? 'captures/m0';
mkdirSync(outDir, { recursive: true });

const KEEP_HEADERS = /^(content-type|retry-after|x-ratelimit-.*|ratelimit.*|anthropic-ratelimit-.*|x-request-id|request-id|x-ds-.*|server|x-tt-logid|x-client-request-id)$/i;

function redact(s) {
  return String(s)
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-<redacted>')
    .replace(/[A-Za-z0-9]{24,}\.[A-Za-z0-9]{8,}/g, '<redacted-key>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
}

function authHeaders(mode, k = key) {
  return mode === 'bearer' ? { authorization: `Bearer ${k}` } : { 'x-api-key': k };
}

function summarizeContent(content) {
  return (content ?? []).map((b) => {
    const o = { type: b.type };
    if (b.type === 'thinking') {
      o.thinkingLen = b.thinking?.length ?? 0;
      o.signature = b.signature === undefined ? 'absent' : b.signature === '' ? 'empty' : `len${b.signature.length}`;
    }
    if (b.type === 'text') { o.textLen = b.text.length; o.textHead = b.text.slice(0, 80); o.hasThinkTag = /<\/?think>/.test(b.text); }
    if (b.type === 'tool_use') { o.id = b.id; o.idFormatOk = /^[a-zA-Z0-9_-]+$/.test(b.id); o.name = b.name; }
    if (b.type === 'redacted_thinking') o.dataLen = b.data?.length ?? 0;
    return o;
  });
}

async function call(name, { body, headers = {}, auth = ch.auth, path = '/v1/messages', method = 'POST', stream = false, rawKey } = {}) {
  const t0 = performance.now();
  const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeaders(auth, rawKey ?? key), ...headers };
  let res, err;
  try {
    res = await fetch(ch.baseUrl + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(180000) });
  } catch (e) { err = String(e?.cause ?? e); }
  const tHeaders = performance.now() - t0;
  const rec = { case: name, channel: args.channel, model: body?.model, status: res?.status ?? null, error: err, msHeaders: Math.round(tHeaders) };
  if (res) {
    rec.headers = Object.fromEntries([...res.headers].filter(([k]) => KEEP_HEADERS.test(k)));
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) {
      const events = []; let firstEventMs = null; let buf = '';
      const blocks = []; let usageStart, usageEnd, model, stopReason;
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        if (firstEventMs === null) firstEventMs = Math.round(performance.now() - t0);
        buf += dec.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /^event: ?(.*)$/m.exec(raw)?.[1];
          const dataLine = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          let data; try { data = JSON.parse(dataLine); } catch { data = null; }
          events.push(ev ?? data?.type ?? '?');
          if (!data) continue;
          if (data.type === 'message_start') { usageStart = data.message?.usage; model = data.message?.model; }
          if (data.type === 'content_block_start') blocks[data.index] = { ...data.content_block, thinking: data.content_block.thinking ?? '', text: data.content_block.text ?? '', _sig: data.content_block.signature };
          if (data.type === 'content_block_delta') {
            const b = blocks[data.index]; const d = data.delta;
            if (d.type === 'thinking_delta') b.thinking += d.thinking;
            if (d.type === 'text_delta') b.text += d.text;
            if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
            if (d.type === 'input_json_delta') b._json = (b._json ?? '') + d.partial_json;
          }
          if (data.type === 'message_delta') { usageEnd = data.usage; stopReason = data.delta?.stop_reason; }
          if (data.type === 'error') rec.streamError = data.error;
        }
      }
      rec.firstEventMs = firstEventMs;
      rec.totalMs = Math.round(performance.now() - t0);
      const compact = []; for (const e of events) { const last = compact.at(-1); if (last && last[0] === e) last[1]++; else compact.push([e, 1]); }
      rec.eventSeq = compact.map(([e, n]) => (n > 1 ? `${e}×${n}` : e));
      rec.respModel = model; rec.usageStart = usageStart; rec.usageEnd = usageEnd; rec.stopReason = stopReason;
      rec.content = summarizeContent(blocks.filter(Boolean));
      rec._blocks = blocks.filter(Boolean).map(({ _sig, _json, ...b }) => (b.type === 'tool_use' ? { ...b, input: _json ? JSON.parse(_json) : b.input } : b));
    } else {
      const text = await res.text();
      rec.totalMs = Math.round(performance.now() - t0);
      let j; try { j = JSON.parse(text); } catch { rec.rawBody = redact(text.slice(0, 600)); }
      if (j) {
        if (j.type === 'message') {
          rec.respModel = j.model; rec.usage = j.usage; rec.stopReason = j.stop_reason; rec.content = summarizeContent(j.content);
          rec._blocks = j.content;
        } else rec.body = JSON.parse(redact(JSON.stringify(j)).slice(0, 4000).replace(/[^}\]]*$/, '') || 'null');
      }
    }
  }
  const { _blocks, ...printable } = rec;
  console.log(JSON.stringify(printable));
  writeFileSync(join(outDir, `${args.channel}--${name}.json`), JSON.stringify(printable, null, 2));
  return rec;
}

function solidPng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const idat = deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const M = ch.model;
const user = (t) => ({ role: 'user', content: t });
const TOOLS = [{ name: 'get_weather', description: 'Get weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];

const CASES = {
  async models() { await call('models', { method: 'GET', path: '/v1/models' }); },
  async auth_invalid() { await call('auth_invalid', { rawKey: 'sk-invalid0000000000000000000000', body: { model: M, max_tokens: 8, messages: [user('hi')] } }); },
  async auth_xapikey() { await call('auth_xapikey', { auth: 'x-api-key', body: { model: M, max_tokens: 16, thinking: { type: 'disabled' }, messages: [user('Say OK')] } }); },
  async auth_bearer() { await call('auth_bearer', { auth: 'bearer', body: { model: M, max_tokens: 16, thinking: { type: 'disabled' }, messages: [user('Say OK')] } }); },
  async unknown_model() { await call('unknown_model', { body: { model: 'no-such-model-xyz', max_tokens: 8, messages: [user('hi')] } }); },
  async claude_model_name() { await call('claude_model_name', { body: { model: 'claude-gw-dsflash', max_tokens: 8, thinking: { type: 'disabled' }, messages: [user('Say OK')] } }); },
  async max_tokens_over() { await call('max_tokens_over', { body: { model: M, max_tokens: 2000000, thinking: { type: 'disabled' }, messages: [user('hi')] } }); },
  async count_tokens() { await call('count_tokens', { path: '/v1/messages/count_tokens', body: { model: M, messages: [user('hello world')] } }); },
  async metadata_user_id() { await call('metadata_user_id', { body: { model: M, max_tokens: 8, thinking: { type: 'disabled' }, metadata: { user_id: JSON.stringify({ device_id: 'x', session_id: 'y' }) }, messages: [user('Say OK')] } }); },
  async thinking_default() { this.td = await call('thinking_default', { stream: true, body: { model: M, max_tokens: 400, stream: true, messages: [user('What is 17*3? Answer with just the number.')] } }); },
  async thinking_enabled_budget() { await call('thinking_enabled_budget', { body: { model: M, max_tokens: 400, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [user('What is 2+2? Just the number.')] } }); },
  async thinking_adaptive() { await call('thinking_adaptive', { body: { model: M, max_tokens: 400, thinking: { type: 'adaptive' }, messages: [user('What is 2+3? Just the number.')] } }); },
  async thinking_disabled() { await call('thinking_disabled', { body: { model: M, max_tokens: 64, thinking: { type: 'disabled' }, messages: [user('What is 2+5? Just the number.')] } }); },
  async effort_low() { await call('effort_low', { body: { model: M, max_tokens: 400, output_config: { effort: 'low' }, messages: [user('What is 3+5? Just the number.')] } }); },
  async effort_max_stream() { await call('effort_max_stream', { stream: true, body: { model: M, max_tokens: 800, stream: true, output_config: { effort: 'max' }, messages: [user('What is 6*7? Just the number.')] } }); },
  async tool_use_stream() {
    this.tu = await call('tool_use_stream', { stream: true, body: { model: M, max_tokens: 600, stream: true, tools: TOOLS, tool_choice: { type: 'auto' }, messages: [user('Use the get_weather tool for Beijing. Do not answer without calling it.')] } });
  },
  async replay_own_thinking() {
    const tu = this.tu ?? (await CASES.tool_use_stream.call(this), this.tu);
    const blocks = tu._blocks.map((b) => (b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b.type === 'text' ? { type: 'text', text: b.text } : b));
    const tool = blocks.find((b) => b.type === 'tool_use');
    if (!tool) { console.log('no tool_use in previous case'); return; }
    this.replayBase = { blocks, tool };
    await call('replay_own_thinking', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing. Do not answer without calling it.'), { role: 'assistant', content: blocks }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'Sunny, 20C' }] }] } });
  },
  async replay_missing_thinking() {
    // 模拟 GLM → DeepSeek：历史 assistant 工具调用轮没有 thinking 块
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await call('replay_missing_thinking', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async replay_missing_thinking_text_only() {
    await call('replay_missing_thinking_text_only', { body: { model: M, max_tokens: 300, messages: [user('Hi'), { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }, user('What is 1+1? Just the number.')] } });
  },
  async replay_missing_thinking_disabled() {
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await call('replay_missing_thinking_disabled', { body: { model: M, max_tokens: 300, thinking: { type: 'disabled' }, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async replay_foreign_signed() {
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await call('replay_foreign_signed', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should call the weather tool.', signature: 'EqQBCkYIBxgCKkAforeignSignatureForProbeOnly0000000000000000000000000000000000000000==' }, { type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async replay_deepseek_signed() {
    // 模拟 DeepSeek → 其他渠道：历史里是 DeepSeek 形态的 thinking（signature 为 36 位 UUID）
    const id = 'call_00_AbCdEfGhIjKlMnOpQrStUvWx';
    await call('replay_deepseek_signed', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should call the weather tool.', signature: '0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5' }, { type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async replay_glm_signed() {
    // 模拟 GLM → 其他渠道：历史里是 GLM 形态的 thinking（signature 为 24 位十六进制）
    const id = 'call_0123456789abcdef01234567';
    await call('replay_glm_signed', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should call the weather tool.', signature: '0123456789abcdef01234567' }, { type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async replay_foreign_unsigned() {
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await call('replay_foreign_unsigned', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should call the weather tool.' }, { type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async replay_redacted() {
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await call('replay_redacted', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpPkNRj2YfWXGmKDxH4mPnZ5sQ7vB5URj' }, { type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async thinking_cache_control() {
    const id = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
    await call('thinking_cache_control', { body: { model: M, max_tokens: 300, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should call the weather tool.', cache_control: { type: 'ephemeral' } }, { type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async foreign_tool_id() {
    const id = 'functions.get_weather:0';
    await call('foreign_tool_id', { body: { model: M, max_tokens: 300, thinking: { type: 'disabled' }, tools: TOOLS, messages: [user('Use the get_weather tool for Beijing.'), { role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_weather', input: { city: 'Beijing' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Sunny, 20C' }] }] } });
  },
  async cache_usage() {
    const prefix = Array.from({ length: 300 }, (_, i) => `Rule ${i}: always keep the codebase tidy and documented, item ${i}.`).join('\n');
    const body = { model: M, max_tokens: 16, thinking: { type: 'disabled' }, system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }], messages: [user('Say OK')] };
    await call('cache_usage_1', { body });
    await new Promise((r) => setTimeout(r, 2000));
    await call('cache_usage_2', { body });
  },
  async betas() {
    const list = (args.betas ?? 'context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,claude-code-20250219,oauth-2025-04-20,prompt-caching-scope-2026-01-05,effort-2025-11-24,context-management-2025-06-27,redact-thinking-2026-02-12,advanced-tool-use-2025-11-20,tool-search-tool-2025-10-19').split(',');
    // --betasAllOnly：先只发一次合并请求（Coding Plan 渠道少发请求），被拒再逐个跑
    if (args.betasAllOnly !== 'true') for (const b of list) await call(`beta_${b}`, { headers: { 'anthropic-beta': b }, body: { model: M, max_tokens: 8, thinking: { type: 'disabled' }, messages: [user('Say OK')] } });
    await call('beta_all', { headers: { 'anthropic-beta': list.join(',') }, body: { model: M, max_tokens: 8, thinking: { type: 'disabled' }, messages: [user('Say OK')] } });
  },
  async image_block() {
    // 1x1 PNG
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await call('image_block', { body: { model: M, max_tokens: 32, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: 'What color is this pixel? One word.' }] }] } });
  },
  async image_color() {
    // 64x64 纯红 PNG：答对颜色且 input_tokens 明显大于纯文本，才算图片真的被处理（V4 Pro 静默丢图时两者都不满足）
    const png = solidPng(64, 64, (args.imageRgb ?? '220,20,20').split(',').map(Number));
    const q = 'What color is this image? Answer with one word.';
    await call('image_color', { body: { model: M, max_tokens: Number(args.imageMaxTokens ?? 32), thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: q }] }] } });
    await call('image_color_text_only', { body: { model: M, max_tokens: 8, thinking: { type: 'disabled' }, messages: [user(q)] } });
  },
  async overlong() {
    const n = Number(args.overlongWords ?? 1100000);
    const big = ' hello'.repeat(n);
    await call('overlong', { body: { model: M, max_tokens: 32000, thinking: { type: 'disabled' }, messages: [user(big)] } });
  },
  async ttfb_medium() {
    const text = Array.from({ length: 4000 }, (_, i) => `Line ${i}: The quick brown fox jumps over the lazy dog number ${i}.`).join('\n');
    await call('ttfb_medium', { stream: true, body: { model: M, max_tokens: 32, stream: true, thinking: { type: 'disabled' }, messages: [user(text + '\nSay OK')] } });
  },
};

const order = (args.cases ?? Object.keys(CASES).filter((c) => c !== 'overlong').join(',')).split(',');
const ctx = {};
for (const c of order) {
  if (!CASES[c]) { console.log(`skip unknown case ${c}`); continue; }
  try { await CASES[c].call(ctx); } catch (e) { console.log(JSON.stringify({ case: c, scriptError: String(e) })); }
}
