import type { GatewayErrorCategory } from "./errors";
import { parseStrictContentLength } from "./body";

export interface RequestBounds {
  maxRequestBytes: number;
  maxHeaderBytes: number;
  requireContentLengthForBody?: boolean;
}

export type RequestBoundsResult =
  | { ok: true }
  | { ok: false; category: GatewayErrorCategory };

export function estimateHeaderBytes(req: Request): number {
  let total = 0;
  req.headers.forEach((value, key) => {
    total += key.length + value.length + 4;
  });
  return total;
}

export function isRequestWithinBounds(
  req: Request,
  bounds: RequestBounds,
): RequestBoundsResult {
  if (estimateHeaderBytes(req) > bounds.maxHeaderBytes) {
    return { ok: false, category: "headers_too_large" };
  }

  const contentLengthHeader = req.headers.get("content-length");
  const parsedLength = parseStrictContentLength(contentLengthHeader);
  if (!parsedLength.ok) {
    return parsedLength;
  }

  if (bounds.requireContentLengthForBody && req.method !== "GET" && req.method !== "HEAD") {
    if (parsedLength.length === null && req.body !== null) {
      return { ok: false, category: "request_too_large" };
    }
  }

  if (parsedLength.length !== null && parsedLength.length > bounds.maxRequestBytes) {
    return { ok: false, category: "request_too_large" };
  }

  return { ok: true };
}

type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; category: GatewayErrorCategory };

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent <= 0) {
      throw new Error("maxConcurrent must be positive");
    }
  }

  tryAcquire(): AcquireResult {
    if (this.active >= this.maxConcurrent) {
      return { ok: false, category: "concurrency_limited" };
    }
    this.active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        const next = this.queue.shift();
        next?.();
      },
    };
  }

  acquire(): Promise<() => void> {
    const attempt = this.tryAcquire();
    if (attempt.ok) {
      return Promise.resolve(attempt.release);
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        const next = this.tryAcquire();
        if (!next.ok) {
          throw new Error("concurrency queue woke without capacity");
        }
        resolve(next.release);
      });
    });
  }
}
