import type { ResolvedChannel } from '../../config/load.js';
import type { Diagnostic } from '../../observability/diagnostics.js';

// 上游错误的措辞兼容改写（方案 §1.2、§5.4）。默认原样返回；只改写登记过的模式。

export function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

/** cc 能识别的超长措辞（会话专题 §2.3）：命中时原样转发。 */
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

export function upstreamErrorMessage(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown; msg?: unknown };
    const m = j.error?.message ?? j.message ?? j.msg;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
}

export type ErrorRewrite =
  | { kind: 'overlong'; status: 400; body: string; diag: Diagnostic }
  | { kind: 'signature'; status: 400; body: string; diag: Diagnostic }
  | { kind: 'history_incompatible'; status: 400; body: string; diag: Diagnostic }
  | null;

export interface RewriteContext {
  channel: ResolvedChannel;
  switched: boolean;
  /** 已填好变量的“历史不兼容”文案 */
  historyMessage: () => string;
}

export function overlongMessage(req: number | string, max: number | string): string {
  return `prompt is too long: ${req} tokens > ${max} maximum`;
}

export function rewriteUpstreamError(status: number, text: string, ctx: RewriteContext): ErrorRewrite {
  if (status < 400 || status >= 500) return null;
  const msg = upstreamErrorMessage(text);
  if (!msg) return null;

  if (!CC_OVERLONG.test(msg)) {
    for (const re of ctx.channel.overlong) {
      const m = re.exec(msg);
      if (m?.groups?.req && m.groups.max)
        return {
          kind: 'overlong',
          status: 400,
          body: errorBody('invalid_request_error', overlongMessage(m.groups.req, m.groups.max)),
          diag: { code: 'overlong_error_rewritten', action: 'rewrite', field: 'error.message', detail: `upstream ${status}: ${msg.slice(0, 160)}` },
        };
    }
  }

  if (ctx.switched && ctx.channel.replay.some((re) => re.test(msg)))
    return {
      kind: 'history_incompatible',
      status: 400,
      body: errorBody('invalid_request_error', ctx.historyMessage()),
      diag: { code: 'cgw_history_incompatible', action: 'rewrite', field: 'error.message', detail: `upstream ${status}: ${msg.slice(0, 160)}` },
    };

  if (!ccRecognizesSignature(msg) && ctx.channel.signature.some((re) => re.test(msg)))
    return {
      kind: 'signature',
      status: 400,
      body: errorBody('invalid_request_error', 'messages.0.content.0: Invalid `signature` in `thinking` block'),
      diag: { code: 'signature_error_rewritten', action: 'rewrite', field: 'error.message', detail: `upstream ${status}: ${msg.slice(0, 160)}` },
    };
  return null;
}
