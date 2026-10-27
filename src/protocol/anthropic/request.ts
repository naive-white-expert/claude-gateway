import type { GatewayConfig, ResolvedModel } from '../../config/load.js';
import { fill } from '../../config/texts.js';
import type { ThinkingLedger } from '../../router/session.js';
import type { Diagnostic } from '../../observability/diagnostics.js';

// 出站请求体的兼容改写（方案 §1.2）。只做登记过的改写，每一处都产生诊断；其余字段原样保留（键顺序不变）。

type Json = Record<string, unknown>;
type Block = Json & { type?: string };
type Message = { role: string; content: string | Block[] } & Json;

export interface PrepareContext {
  cfg: GatewayConfig;
  model: ResolvedModel;
  requestedId: string;
  requestClass: string | null;
  /** 会话线是否发生过用户切换（只有切换后才过滤 thinking，会话专题 §4.2） */
  switched: boolean;
  ledger: ThinkingLedger;
}

export class RequestValidationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

/** 校验 tool_use / tool_result 配对：assistant 的每个 tool_use 都要在下一条（非 system）user 消息里有 tool_result。 */
export function validateToolPairing(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
    if (!ids.length) continue;
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'system') j++;
    if (j >= messages.length) continue; // 末尾的 assistant 预填，交给上游判断
    const next = messages[j];
    const results = new Set(
      next.role === 'user' && Array.isArray(next.content) ? next.content.filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)) : [],
    );
    const missing = ids.filter((id) => !results.has(id));
    if (missing.length)
      throw new RequestValidationError(
        `messages.${j}: tool_use ids without a matching tool_result in the next user message: ${missing.join(', ')}`,
        'cgw_tool_pairing',
      );
  }
}

const isThinking = (b: Block): boolean => b.type === 'thinking' || b.type === 'redacted_thinking';
const hasSignature = (b: Block): boolean => typeof b.signature === 'string' && b.signature.length > 0;

/** 按目标渠道的 thinkingReplay 过滤历史 thinking（会话专题 §4.2 第 3 条）。只删除，不插入（空消息补 [Thinking removed]）。 */
export function filterThinking(messages: Message[], ctx: Pick<PrepareContext, 'model' | 'requestedId' | 'ledger'>, diags: Diagnostic[]): void {
  const { thinkingReplay, redactedThinking } = ctx.model.channelRef.profile;
  let removed = 0;
  let cacheControlRemoved = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content) || !m.content.some(isThinking)) continue;
    const kept: Block[] = [];
    for (const b of m.content) {
      if (!isThinking(b)) {
        kept.push(b);
        continue;
      }
      let keep: boolean;
      if (b.type === 'redacted_thinking' && redactedThinking === 'unsupported') keep = false;
      else if (thinkingReplay === 'passthrough') keep = true;
      else {
        const origin = ctx.ledger.originOf(b as never);
        const own = origin === ctx.model.id || origin === ctx.requestedId;
        if (thinkingReplay === 'keep-unsigned') keep = own || (b.type === 'thinking' && !hasSignature(b));
        else keep = own;
      }
      if (!keep) {
        removed++;
        continue;
      }
      if (thinkingReplay !== 'passthrough' && 'cache_control' in b) {
        const { cache_control: _drop, ...rest } = b;
        kept.push(rest);
        cacheControlRemoved++;
      } else kept.push(b);
    }
    m.content = kept.length ? kept : [{ type: 'text', text: '[Thinking removed]' }];
  }
  if (removed) diags.push({ code: 'thinking_removed', action: 'strip', field: 'messages[].content[thinking]', count: removed });
  if (cacheControlRemoved) diags.push({ code: 'thinking_cache_control_removed', action: 'strip', field: 'messages[].content[thinking].cache_control', count: cacheControlRemoved });
}

export function concurrencyHintText(cfg: GatewayConfig, model: ResolvedModel): string | null {
  if (cfg.concurrencyHint.injectSystemPrompt === false) return null;
  const n = model.effectiveConcurrency;
  if (n == null) return null;
  return fill(cfg.concurrencyHint.textTemplate, { N: n, 'N-1': Math.max(n - 1, 0) });
}

export function prepareRequestBody(body: Json, ctx: PrepareContext): { body: Json; diags: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const { model, cfg } = ctx;
  const profile = model.channelRef.profile;

  body.model = model.upstreamModel;
  diags.push({ code: 'model_mapped', action: 'rewrite', field: 'model', detail: `${ctx.requestedId}→${model.upstreamModel}` });

  const meta = body.metadata as Json | undefined;
  if (meta && typeof meta === 'object' && 'user_id' in meta && profile.metadataUserId === 'strip') {
    const { user_id: _u, ...rest } = meta;
    if (Object.keys(rest).length) body.metadata = rest;
    else delete body.metadata;
    diags.push({ code: 'metadata_user_id_stripped', action: 'strip', field: 'metadata.user_id' });
  }

  if (typeof body.max_tokens === 'number' && body.max_tokens > model.maxOutputTokens) {
    diags.push({ code: 'max_tokens_clamped', action: 'rewrite', field: 'max_tokens', detail: `${body.max_tokens}→${model.maxOutputTokens}` });
    body.max_tokens = model.maxOutputTokens;
  }

  const thinking = body.thinking as Json | undefined;
  if (thinking?.type === 'disabled' && model.thinking === 'always-on')
    diags.push({ code: 'thinking_cannot_disable', action: 'passthrough', field: 'thinking.type' });

  const messages = body.messages as Message[] | undefined;
  if (Array.isArray(messages)) {
    validateToolPairing(messages);
    if (ctx.switched) filterThinking(messages, ctx, diags);
  }

  const hint = concurrencyHintText(cfg, model);
  if (hint) {
    const cls = ctx.requestClass;
    const tools = body.tools;
    const eligible = cls ? cfg.concurrencyHint.injectFor.includes(cls) : Array.isArray(tools) && tools.length > 0;
    if (eligible) {
      const block = { type: 'text', text: hint };
      if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system }, block];
      else if (Array.isArray(body.system)) body.system = [...body.system, block];
      else body.system = [block];
      diags.push({ code: 'concurrency_hint_injected', action: 'append', field: 'system' });
    }
  }
  return { body, diags };
}
