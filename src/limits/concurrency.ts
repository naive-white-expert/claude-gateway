// 按“模型 × 渠道”（对外 ID）的并发上限与排队（方案 §4.3、§4.12）。
// 计数单位是同时处理中的请求（从发出到响应结束）。释放操作幂等。

export type Release = () => void;

interface Waiter {
  resolve: (r: Release) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class QueueTimeoutError extends Error {
  constructor() {
    super('queue timeout');
  }
}
export class QueueAbortedError extends Error {
  constructor() {
    super('aborted while queued');
  }
}

class Slot {
  inFlight = 0;
  queue: Waiter[] = [];
  constructor(public limit: number | null) {}
}

export class ConcurrencyLimiter {
  private slots = new Map<string, Slot>();

  private slot(key: string, limit: number | null): Slot {
    let s = this.slots.get(key);
    if (!s) {
      s = new Slot(limit);
      this.slots.set(key, s);
    }
    s.limit = limit;
    return s;
  }

  private makeRelease(s: Slot): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.inFlight--;
      this.pump(s);
    };
  }

  private pump(s: Slot): void {
    while (s.queue.length && (s.limit === null || s.inFlight < s.limit)) {
      const w = s.queue.shift()!;
      clearTimeout(w.timer);
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      s.inFlight++;
      w.resolve(this.makeRelease(s));
    }
  }

  acquire(key: string, limit: number | null, timeoutMs: number, signal?: AbortSignal): Promise<Release> {
    const s = this.slot(key, limit);
    if (signal?.aborted) return Promise.reject(new QueueAbortedError());
    if (s.limit === null || (s.inFlight < s.limit && s.queue.length === 0)) {
      s.inFlight++;
      return Promise.resolve(this.makeRelease(s));
    }
    return new Promise<Release>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          s.queue.splice(s.queue.indexOf(w), 1);
          if (w.onAbort) signal?.removeEventListener('abort', w.onAbort);
          reject(new QueueTimeoutError());
        }, timeoutMs),
      };
      if (signal) {
        w.onAbort = () => {
          const i = s.queue.indexOf(w);
          if (i >= 0) s.queue.splice(i, 1);
          clearTimeout(w.timer);
          reject(new QueueAbortedError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      s.queue.push(w);
    });
  }

  snapshot(): Record<string, { inFlight: number; queued: number; limit: number | null }> {
    const out: Record<string, { inFlight: number; queued: number; limit: number | null }> = {};
    for (const [k, s] of this.slots) out[k] = { inFlight: s.inFlight, queued: s.queue.length, limit: s.limit };
    return out;
  }

  state(key: string): { inFlight: number; queued: number } {
    const s = this.slots.get(key);
    return { inFlight: s?.inFlight ?? 0, queued: s?.queue.length ?? 0 };
  }
}
