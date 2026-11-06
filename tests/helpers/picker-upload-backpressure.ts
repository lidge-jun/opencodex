import { expect } from "bun:test";
import { IncomingMessage, type ClientRequest } from "node:http";
import { Http2ServerRequest, type ClientHttp2Stream } from "node:http2";

type Wait = <T>(promise: PromiseLike<T>) => Promise<T>;

/** Observe the real relay pipe without changing its arguments, flow control or return value. */
export function observeUploadBackpressure(protocol: "h1" | "h2", path: string, header: string, token: string) {
  const chunk = Buffer.alloc(256 * 1024, 0x62);
  const cap = 8 * 1024 * 1024;
  const requestClass = protocol === "h2" ? Http2ServerRequest : IncomingMessage;
  const proto = requestClass.prototype;
  const originalPipe = proto.pipe;
  const hadOwnPipe = Object.prototype.hasOwnProperty.call(proto, "pipe");
  const pair = Promise.withResolvers<{ src: IncomingMessage | Http2ServerRequest; dest: ClientRequest }>();
  const counts = { pairs: 0, pauses: 0, resumes: 0, drains: 0 };
  let stopped = false;
  let closed = false;
  let responded = false;
  let sent = 0;
  let stableCounts: { resumes: number; drains: number } | undefined;
  proto.pipe = function (this: IncomingMessage | Http2ServerRequest, ...args: Parameters<typeof originalPipe>) {
    const dest = args[0] as ClientRequest;
    const matches = this instanceof requestClass && this.method === "POST" && dest.method === "POST"
      && this.url === path && dest.path === path && this.headers[header] === token;
    if (matches) {
      counts.pairs++;
      this.on("pause", () => { counts.pauses++; });
      this.on("resume", () => { counts.resumes++; });
      dest.on("drain", () => { counts.drains++; });
      this.once("close", () => { closed = true; });
      dest.once("close", () => { closed = true; });
      dest.once("response", () => { responded = true; });
    }
    const out = Reflect.apply(originalPipe, this, args);
    if (matches) pair.resolve({ src: this, dest });
    return out;
  } as typeof originalPipe;

  const until = async (condition: () => boolean) => {
    while (!stopped && !condition()) await Bun.sleep(20);
    return condition();
  };
  return {
    advertisedLength: cap + chunk.length,
    async holdStable(upload: ClientRequest | ClientHttp2Stream, durationMs: number, wait: Wait, idleTimedOut: () => boolean) {
      const { src, dest } = await wait(pair.promise);
      expect(counts.pairs).toBe(1);
      let stableSince: number | undefined;
      let previous = { resumes: counts.resumes, drains: counts.drains };
      while (!stopped) {
        if (idleTimedOut()) throw new Error("picker upload idle timeout before sustained backpressure");
        if (closed || responded || upload.destroyed || src.destroyed || dest.destroyed || src.complete || dest.writableEnded) {
          throw new Error("picker upload closed, completed or responded before sustained backpressure");
        }
        const paused = src.isPaused() && dest.writableNeedDrain === true;
        const changed = counts.resumes !== previous.resumes || counts.drains !== previous.drains;
        if (!paused || changed) stableSince = undefined;
        if (paused) {
          if (stableSince === undefined) {
            stableSince = performance.now();
            stableCounts = { resumes: counts.resumes, drains: counts.drains };
          }
          if (performance.now() - stableSince >= durationMs) {
            expect(counts.resumes).toBe(stableCounts!.resumes);
            expect(counts.drains).toBe(stableCounts!.drains);
            expect(src.isPaused()).toBe(true);
            expect(dest.writableNeedDrain).toBe(true);
            expect(counts.pauses).toBeGreaterThanOrEqual(1);
            return;
          }
        } else if (!src.isPaused() && sent + chunk.length <= cap) {
          // At the cap, keep observing already queued bytes under the original test deadline.
          sent += chunk.length;
          upload.write(chunk);
        }
        previous = { resumes: counts.resumes, drains: counts.drains };
        await wait(Bun.sleep(20));
      }
      throw new Error("picker upload backpressure observation stopped");
    },
    async resumeAndVerify(upstream: IncomingMessage, wait: Wait) {
      const { src, dest } = await wait(pair.promise);
      let received = 0;
      let payloadIntact = true;
      upstream.on("data", data => {
        received += data.length;
        payloadIntact &&= Buffer.from(data).every(byte => byte === 0x62);
      });
      upstream.resume();
      expect(await wait(until(() => !dest.writableNeedDrain))).toBe(true);
      expect(await wait(until(() => !src.isPaused()))).toBe(true);
      expect(counts.drains).toBeGreaterThan(stableCounts!.drains);
      expect(counts.resumes).toBeGreaterThan(stableCounts!.resumes);
      expect(await wait(until(() => received >= sent || upstream.destroyed))).toBe(true);
      expect(received).toBe(sent);
      expect(payloadIntact).toBe(true);
      expect(counts.pairs).toBe(1);
    },
    async cleanup(upload: ClientRequest | ClientHttp2Stream | undefined, close: () => Promise<void>) {
      stopped = true;
      if (hadOwnPipe) proto.pipe = originalPipe; else delete (proto as { pipe?: unknown }).pipe;
      if (upload && !upload.destroyed) upload.destroy();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("picker upload cleanup deadline")), 5_000);
      });
      try { await Promise.race([close(), deadline]); } finally { clearTimeout(timer); }
      expect(proto.pipe).toBe(originalPipe);
    },
  };
}
