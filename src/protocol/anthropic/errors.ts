import type { ResolvedChannel } from '../../config/load.js';
import { classify, parseUpstreamError, type CompiledRule, type ErrorClass } from '../../config/errorRules.js';
import type { Diagnostic } from '../../observability/diagnostics.js';

// 上游错误的分类与响应（方案 §1.2、§5.4）。先按渠道规则用「状态码 + 错误码 / type + 原文」判定类别，
// 再按类别决定给客户端的响应。没有命中规则的错误原样透传；命中后也只做下表登记的改动：
//
//   quota_exhausted                      状态码不变；error.message 套用已确认文案（内含上游原文）；error.type 设为 billing_error；
//                                        加 x-should-retry: false
//   auth_failed / model_unavailable /
//   invalid_request                      状态码与错误体不变；加 x-should-retry: false
//   rate_limited / overloaded            状态码与错误体不变；上游没给 retry-after 时按规则补上
//   context_overflow                     cc 已能识别的措辞原样转发；否则改写为 prompt is too long
//   history_incompatible                 用户切换模型后改写为已确认的建议文案；未切换时原样转发
//   signature_invalid                    改写为 cc 能识别的签名错误措辞（cc 会剥掉 thinking 重试）

export function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

export function overlongMessage(req: number | string, max: number | string): string {
  return `prompt is too long: ${req} tokens > ${max} maximum`;
}

/** cc 能识别的超长措辞（会话专题 §2.3）。 */
const CC_OVERLONG = /prompt is too long|input is too long for requested model|context window|input length and `?max_tokens`? exceed context limit/i;

/** cc 能识别的签名类措辞（会话专题 §2.1）。 */
function ccRecognizesSignature(msg: string): boolean {
  const s = msg.replace(/`/g, '').toLowerCase();
  return (
    s.includes('signature in thinking block') ||
    s.includes('invalid data in redacted_thinking block') ||
    (s.includes('thinking.signature') && s.includes('field required')) ||
    ((s.includes('thinking block') || s.includes('redacted_thinking')) && (s.includes('cannot be modified') || s.includes('invalid signature')))
  );
}

export interface ErrorContext {
  channel: ResolvedChannel;
  switched: boolean;
  /** 已填好变量的“历史不兼容”文案 */
  historyMessage: () => string;
  /** 余额或额度耗尽的文案，参数为上游 error.message 原文 */
  quotaMessage?: (upstreamMessage: string) => string;
}

export interface ErrorDecision {
  errorClass: ErrorClass;
  ruleId: string | null;
  status: number;
  /** 发给客户端的错误体；与上游相同时为原文 */
  body: string;
  /** 在上游响应头之上追加 / 覆盖的头 */
  headers: Record<string, string>;
  /** 是否改动了错误体（只加头不算） */
  bodyRewritten: boolean;
  diag: Diagnostic;
}

const NO_RETRY_CLASSES: ReadonlySet<ErrorClass> = new Set(['quota_exhausted', 'auth_failed', 'model_unavailable', 'invalid_request']);

function setErrorFields(text: string, type: string, message?: string): string | null {
  try {
    const j = JSON.parse(text) as Record<string, any>;
    if (!j || typeof j !== 'object') return null;
    if (j.error && typeof j.error === 'object') {
      j.error.type = type;
      if (message !== undefined) j.error.message = message;
      if (j.type === undefined) return JSON.stringify({ type: 'error', ...j });
      return JSON.stringify(j);
    }
    return null;
  } catch {
    return null;
  }
}

export function decideUpstreamError(status: number, text: string, upstreamHeaders: Record<string, string>, ctx: ErrorContext): ErrorDecision {
  const err = parseUpstreamError(status, text);
  const hit = classify(err, ctx.channel.errorRules);
  const errorClass: ErrorClass = hit?.rule.class ?? 'unknown';
  const rule: CompiledRule | undefined = hit?.rule;
  const detail = `class=${errorClass} rule=${rule ? `${rule.set}/${rule.id}` : '-'} status=${status} code=${err.code ?? '-'} type=${err.type ?? '-'}`;
  const decision: ErrorDecision = {
    errorClass,
    ruleId: rule ? `${rule.set}/${rule.id}` : null,
    status,
    body: text,
    headers: {},
    bodyRewritten: false,
    diag: { code: 'upstream_error_classified', action: 'observe', detail },
  };
  if (!rule) return decision;
  const msg = err.message ?? '';
  const rewrite = (code: string, newStatus: number, body: string): ErrorDecision => ({
    ...decision,
    status: newStatus,
    body,
    bodyRewritten: true,
    diag: { code, action: 'rewrite', field: 'error', detail },
  });

  switch (rule.class) {
    case 'context_overflow': {
      if (CC_OVERLONG.test(msg)) return decision;
      const g = hit!.groups;
      const message = g?.req && g?.max ? overlongMessage(g.req, g.max) : 'prompt is too long';
      return rewrite('overlong_error_rewritten', 400, errorBody('invalid_request_error', message));
    }
    case 'history_incompatible':
      if (!ctx.switched) return decision;
      return rewrite('cgw_history_incompatible', 400, errorBody('invalid_request_error', ctx.historyMessage()));
    case 'signature_invalid':
      if (ccRecognizesSignature(msg)) return decision;
      return rewrite('signature_error_rewritten', 400, errorBody('invalid_request_error', 'messages.0.content.0: Invalid `signature` in `thinking` block'));
    case 'quota_exhausted': {
      const message = err.message !== undefined && ctx.quotaMessage ? ctx.quotaMessage(err.message) : undefined;
      const body = setErrorFields(text, 'billing_error', message);
      return {
        ...decision,
        body: body ?? text,
        bodyRewritten: body !== null,
        headers: { 'x-should-retry': 'false' },
        diag: { code: 'cgw_quota_exhausted', action: 'rewrite', field: message ? 'error.message,error.type,x-should-retry' : 'error.type,x-should-retry', detail },
      };
    }
    case 'rate_limited':
    case 'overloaded':
      if (rule.retryAfterSec && upstreamHeaders['retry-after'] === undefined)
        return { ...decision, headers: { 'retry-after': String(rule.retryAfterSec) }, diag: { code: 'retry_after_added', action: 'append', field: 'retry-after', detail } };
      return decision;
    default:
      if (NO_RETRY_CLASSES.has(rule.class))
        return { ...decision, headers: { 'x-should-retry': 'false' }, diag: { code: 'no_retry_header_added', action: 'append', field: 'x-should-retry', detail } };
      return decision;
  }
}
