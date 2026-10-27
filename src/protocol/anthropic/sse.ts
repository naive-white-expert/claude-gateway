// SSE 回流（方案 §4.3）：按事件边界转发上游原始字节，只改写 message_start 中的 model（回显对外 ID）。
// 同时旁路收集 usage、stop_reason 与 thinking 块（供来源登记），不改变其他事件。

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CollectedBlock {
  type: string;
  thinking?: string;
  signature?: string;
  data?: string;
}

const SEP = /\r?\n\r?\n/;

export class SseRewriter {
  private buf = '';
  private decoder = new TextDecoder();
  private blocks = new Map<number, CollectedBlock>();
  usage: Usage = {};
  stopReason: string | null = null;
  /** 收到首个内容事件（content_block_*）后为 true，用于区分首字节超时与空闲超时 */
  gotContent = false;
  sawMessageStart = false;
  sawMessageStop = false;
  streamError: { type?: string; message?: string } | null = null;
  rewroteModel = false;

  constructor(private echoModel: string) {}

  /** 输入上游字节，返回可以立即写给客户端的完整事件。 */
  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const out: string[] = [];
    for (;;) {
      const m = SEP.exec(this.buf);
      if (!m) break;
      const raw = this.buf.slice(0, m.index);
      const sep = m[0];
      this.buf = this.buf.slice(m.index + sep.length);
      out.push(this.handle(raw) + sep);
    }
    return out;
  }

  /** 上游结束时剩余的不完整内容原样交出。 */
  flush(): string {
    const rest = this.buf + this.decoder.decode();
    this.buf = '';
    return rest;
  }

  blocksForLedger(): CollectedBlock[] {
    return [...this.blocks.values()].filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
  }

  private handle(raw: string): string {
    const lines = raw.split(/\r?\n/);
    const dataLines = lines.filter((l) => l.startsWith('data:'));
    if (!dataLines.length) return raw;
    const dataText = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    let data: Record<string, any>;
    try {
      data = JSON.parse(dataText);
    } catch {
      return raw;
    }
    switch (data.type) {
      case 'message_start': {
        this.sawMessageStart = true;
        if (data.message?.usage) Object.assign(this.usage, data.message.usage);
        if (data.message && typeof data.message === 'object') {
          data.message.model = this.echoModel;
          this.rewroteModel = true;
          const eventLine = lines.find((l) => l.startsWith('event:'));
          return `${eventLine ?? 'event: message_start'}\ndata: ${JSON.stringify(data)}`;
        }
        return raw;
      }
      case 'content_block_start': {
        this.gotContent = true;
        const cb = data.content_block ?? {};
        this.blocks.set(data.index, {
          type: cb.type,
          thinking: cb.type === 'thinking' ? (cb.thinking ?? '') : undefined,
          signature: cb.type === 'thinking' ? (cb.signature ?? '') : undefined,
          data: cb.type === 'redacted_thinking' ? cb.data : undefined,
        });
        return raw;
      }
      case 'content_block_delta': {
        this.gotContent = true;
        const b = this.blocks.get(data.index);
        const d = data.delta ?? {};
        if (b && d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
        if (b && d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
        return raw;
      }
      case 'message_delta':
        if (data.usage) Object.assign(this.usage, data.usage);
        if (data.delta?.stop_reason) this.stopReason = data.delta.stop_reason;
        return raw;
      case 'message_stop':
        this.sawMessageStop = true;
        return raw;
      case 'error':
        this.streamError = data.error ?? {};
        return raw;
      default:
        return raw;
    }
  }
}

export const PING_EVENT = 'event: ping\ndata: {"type": "ping"}\n\n';

export function sseErrorEvent(type: string, message: string): string {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`;
}
