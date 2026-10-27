// count_tokens 的本地估算（方案 §4.7）：启发式，宁可偏大；按该模型最近的真实 input_tokens 校准。

const IMAGE_TOKENS = 1600;

function textTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.0 + other / 3.2);
}

function walk(v: unknown, acc: { tokens: number }): void {
  if (typeof v === 'string') acc.tokens += textTokens(v);
  else if (Array.isArray(v)) for (const x of v) walk(x, acc);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'image' || o.type === 'document') {
      acc.tokens += IMAGE_TOKENS;
      return;
    }
    for (const [k, x] of Object.entries(o)) {
      if (k === 'signature' || k === 'cache_control' || k === 'data') continue;
      acc.tokens += 1;
      walk(x, acc);
    }
  }
}

export function estimateInputTokens(body: { system?: unknown; messages?: unknown; tools?: unknown }): number {
  const acc = { tokens: 0 };
  walk(body.system, acc);
  walk(body.messages, acc);
  walk(body.tools, acc);
  return acc.tokens;
}

/** 确定会超出窗口时的下界估计：只数文本字节，按每 token 最多 8 字节计。 */
export function lowerBoundTokens(body: { system?: unknown; messages?: unknown; tools?: unknown }): number {
  let bytes = 0;
  const visit = (v: unknown): void => {
    if (typeof v === 'string') bytes += Buffer.byteLength(v, 'utf8');
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'image' || o.type === 'document') return;
      for (const [k, x] of Object.entries(o)) if (k !== 'signature' && k !== 'data') visit(x);
    }
  };
  visit(body.system);
  visit(body.messages);
  visit(body.tools);
  return Math.floor(bytes / 8);
}

/** 每个对外 ID 的校准系数：真实 input / 估算，取指数滑动平均，且不小于 1（宁可偏大）。 */
export class TokenCalibrator {
  private ratio = new Map<string, number>();
  observe(model: string, estimated: number, actual: number): void {
    if (estimated < 200 || actual <= 0) return;
    const r = actual / estimated;
    const prev = this.ratio.get(model);
    this.ratio.set(model, prev === undefined ? r : prev * 0.7 + r * 0.3);
  }
  apply(model: string, estimated: number): number {
    return Math.ceil(estimated * Math.max(1, this.ratio.get(model) ?? 1));
  }
}
