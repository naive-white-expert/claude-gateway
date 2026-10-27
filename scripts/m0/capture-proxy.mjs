#!/usr/bin/env node
// M0 记录型反代：本机监听，原样转发到上游 Anthropic 兼容端点，记录请求结构摘要。
// 用法：node scripts/m0/capture-proxy.mjs --listen 127.0.0.1:18080 --target https://api.deepseek.com/anthropic --out captures/cc
//       [--duration-sec 600] [--save-bodies]
// 记录内容：方法、路径、请求头（认证头掩码）、请求体结构（model、thinking、beta、system 块与 cache_control 位置、
// tools 名称、消息数与块类型），响应状态与 SSE 事件序列。默认不保存正文；--save-bodies 时请求体另存到 out/bodies/
// （含对话内容，只能放在不入库的目录）。客户端带来的认证头原样转发给上游，不写入记录。
import http from 'node:http';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const [host, port] = (args.listen ?? '127.0.0.1:18080').split(':');
const target = new URL(args.target ?? 'https://api.deepseek.com/anthropic');
const out = args.out ?? 'captures/cc';
mkdirSync(join(out, 'bodies'), { recursive: true });
const logFile = join(out, 'requests.jsonl');
let seq = 0;

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding']);
const mask = (k, v) => (/^(authorization|x-api-key|cookie)$/i.test(k) ? `<masked len=${String(v).length}>` : v);

function summarize(body) {
  let j; try { j = JSON.parse(body); } catch { return { unparsable: true, bytes: body.length }; }
  const sys = typeof j.system === 'string' ? [{ type: 'text', text: j.system }] : (j.system ?? []);
  return {
    keys: Object.keys(j),
    model: j.model, max_tokens: j.max_tokens, stream: j.stream, thinking: j.thinking, output_config: j.output_config,
    temperature: j.temperature, tool_choice: j.tool_choice, context_management: j.context_management,
    metadataKeys: j.metadata ? Object.keys(j.metadata) : undefined,
    metadataUserIdShape: j.metadata?.user_id ? (() => { try { return Object.keys(JSON.parse(j.metadata.user_id)); } catch { return 'string'; } })() : undefined,
    system: sys.map((b) => ({ type: b.type, len: b.text?.length, head: b.text?.slice(0, 60), cache_control: b.cache_control })),
    tools: (j.tools ?? []).map((t) => t.name ?? t.type),
    toolsWithCacheControl: (j.tools ?? []).filter((t) => t.cache_control).map((t) => t.name),
    messages: (j.messages ?? []).map((m) => ({ role: m.role, blocks: typeof m.content === 'string' ? ['string'] : m.content.map((b) => b.type + (b.cache_control ? '+cc' : '') + (b.type === 'thinking' ? `(sig:${b.signature ? b.signature.length : 'none'})` : '')) })),
    bytes: body.length,
  };
}

const server = http.createServer((req, res) => {
  const id = ++seq;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const rec = { id, t: new Date().toISOString(), method: req.method, path: req.url, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, mask(k, v)])) };
    if (body.length) rec.body = summarize(body.toString('utf8'));
    if (args['save-bodies'] && body.length) writeFileSync(join(out, 'bodies', `${id}.json`), body);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const url = target.origin + target.pathname.replace(/\/$/, '') + req.url;
    const t0 = Date.now();
    try {
      const up = await fetch(url, { method: req.method, headers, body: body.length ? body : undefined, redirect: 'manual' });
      rec.status = up.status;
      rec.respHeaders = Object.fromEntries([...up.headers].filter(([k]) => /content-type|retry-after|ratelimit/i.test(k)));
      const h = {}; for (const [k, v] of up.headers) if (!/content-encoding|content-length|transfer-encoding|connection/i.test(k)) h[k] = v;
      res.writeHead(up.status, h);
      const events = []; let buf = ''; let errBody = '';
      const dec = new TextDecoder();
      if (up.body) for await (const c of up.body) {
        res.write(c);
        const s = dec.decode(c, { stream: true });
        if (up.status >= 400) errBody += s;
        buf += s; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const ev = /^event: ?(.*)$/m.exec(buf.slice(0, i))?.[1]; if (ev) events.push(ev); buf = buf.slice(i + 2); }
      }
      res.end();
      if (events.length) { const c = []; for (const e of events) { const l = c.at(-1); if (l && l[0] === e) l[1]++; else c.push([e, 1]); } rec.events = c.map(([e, n]) => (n > 1 ? `${e}×${n}` : e)); }
      if (errBody) rec.errorBody = errBody.slice(0, 800);
    } catch (e) {
      rec.proxyError = String(e?.cause ?? e);
      if (!res.headersSent) res.writeHead(502); res.end();
    }
    rec.ms = Date.now() - t0;
    appendFileSync(logFile, JSON.stringify(rec) + '\n');
    console.log(`#${id} ${req.method} ${req.url} → ${rec.status} ${rec.body?.model ?? ''} ${req.headers['x-claude-code-request-class'] ?? ''} ${rec.ms}ms`);
  });
});
server.listen(Number(port), host, () => console.log(`capture proxy on http://${host}:${port} → ${target.href}, log ${logFile}`));
const dur = Number(args['duration-sec'] ?? 900);
setTimeout(() => { console.log('duration reached, exiting'); process.exit(0); }, dur * 1000).unref?.();
setTimeout(() => process.exit(0), dur * 1000);
