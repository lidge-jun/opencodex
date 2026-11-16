import { describe, expect, test } from "bun:test";
import { acquireBounded, admitAcquireUrl, DesktopAcquireError, type AcquireResponse, type AcquireTimers } from "../../src/desktop-update/acquire";

const FEED = "https://github.com/lidge-jun/opencodex/releases/latest/download/latest.json";

/** Timers that fire only when the test says so: no wall clock, no sleeps. */
function manualTimers() {
  const pending = new Map<number, { ms: number; fire: () => void }>();
  let next = 0;
  const timers: AcquireTimers = {
    schedule(ms, fire) { const id = next++; pending.set(id, { ms, fire }); return () => { pending.delete(id); }; },
  };
  return {
    timers,
    armed: () => [...pending.values()].map(entry => entry.ms).sort((a, b) => a - b),
    fire(ms: number) { for (const [id, entry] of [...pending]) if (entry.ms === ms) { pending.delete(id); entry.fire(); return; } throw new Error(`no ${ms} ms timer`); },
  };
}

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
}

function response(status: number, headers: Record<string, string> = {}, chunks: Uint8Array[] = []): AcquireResponse {
  return { status, headers: { get: name => headers[name.toLowerCase()] ?? null }, body: body(...chunks) };
}

function transportOf(map: Record<string, () => AcquireResponse | Promise<AcquireResponse>>) {
  const seen: string[] = [];
  const signals: AbortSignal[] = [];
  return {
    seen,
    signals,
    transport: {
      async request(url: string, signal: AbortSignal) {
        seen.push(url); signals.push(signal);
        const handler = map[url];
        if (!handler) throw new Error(`unexpected request ${url}`);
        return handler();
      },
    },
  };
}

async function refusal(work: Promise<unknown>): Promise<DesktopAcquireError> {
  try { await work; } catch (error) { if (error instanceof DesktopAcquireError) return error; throw error; }
  throw new Error("expected a refusal");
}

describe("acquisition URL admission", () => {
  test("only the exact release source over https starts a download", () => {
    expect(admitAcquireUrl(FEED, true).hostname).toBe("github.com");
    for (const url of [
      "http://github.com/lidge-jun/opencodex/releases/latest/download/latest.json",
      "https://github.com/someone/opencodex/releases/latest/download/latest.json",
      "https://user:pw@github.com/lidge-jun/opencodex/releases/latest/download/latest.json",
      "https://github.com:8443/lidge-jun/opencodex/releases/latest/download/latest.json",
      "https://release-assets.githubusercontent.com/x",
      "https://127.0.0.1/lidge-jun/opencodex/releases/x",
    ]) expect(() => admitAcquireUrl(url, true)).toThrow(DesktopAcquireError);
  });

  test("redirects reach only the listed asset hosts or the same releases", () => {
    expect(admitAcquireUrl("https://release-assets.githubusercontent.com/github-production-release-asset/1", false).hostname).toBe("release-assets.githubusercontent.com");
    expect(admitAcquireUrl("https://objects.githubusercontent.com/x", false).hostname).toBe("objects.githubusercontent.com");
    for (const url of ["https://evil.example/x", "https://github.com/other/repo/releases/x", "http://objects.githubusercontent.com/x",
      "https://objects.githubusercontent.com:444/x", "https://a:b@objects.githubusercontent.com/x"]) {
      expect(() => admitAcquireUrl(url, false)).toThrow(DesktopAcquireError);
    }
  });
});

describe("bounded acquisition", () => {
  test("follows the GitHub redirect chain and returns the exact bytes", async () => {
    const asset = "https://release-assets.githubusercontent.com/asset?sig=1";
    const tag = "https://github.com/lidge-jun/opencodex/releases/download/v2.100.3/latest.json";
    const t = transportOf({
      [FEED]: () => response(302, { location: "/lidge-jun/opencodex/releases/download/v2.100.3/latest.json" }),
      [tag]: () => response(302, { location: asset }),
      [asset]: () => response(200, { "content-length": "5" }, [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)]),
    });
    const timers = manualTimers();
    const bytes = await acquireBounded(FEED, { maxBytes: 5 }, { transport: t.transport, timers: timers.timers });
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(t.seen).toEqual([FEED, tag, asset]);
    expect(timers.armed()).toEqual([]);
  });

  test("a redirect to an unlisted host is refused before it is requested", async () => {
    const t = transportOf({ [FEED]: () => response(302, { location: "https://evil.example/latest.json" }) });
    const error = await refusal(acquireBounded(FEED, { maxBytes: 10 }, { transport: t.transport, timers: manualTimers().timers }));
    expect(error.code).toBe("redirect_refused");
    expect(t.seen).toEqual([FEED]);
  });

  test("more than three redirects are refused", async () => {
    const hop = (n: number) => `https://github.com/lidge-jun/opencodex/releases/hop${n}`;
    const t = transportOf({
      [FEED]: () => response(302, { location: hop(1) }),
      [hop(1)]: () => response(302, { location: hop(2) }),
      [hop(2)]: () => response(302, { location: hop(3) }),
      [hop(3)]: () => response(302, { location: hop(4) }),
    });
    const error = await refusal(acquireBounded(FEED, { maxBytes: 10 }, { transport: t.transport, timers: manualTimers().timers }));
    expect(error.code).toBe("too_many_redirects");
    expect(t.seen).toHaveLength(4);
  });

  test("the size cap holds at the exact boundary and refuses one byte more", async () => {
    const t = (chunks: Uint8Array[], headers: Record<string, string> = {}) => transportOf({ [FEED]: () => response(200, headers, chunks) }).transport;
    expect((await acquireBounded(FEED, { maxBytes: 4 }, { transport: t([new Uint8Array(4)]), timers: manualTimers().timers })).byteLength).toBe(4);
    expect((await refusal(acquireBounded(FEED, { maxBytes: 4 }, { transport: t([new Uint8Array(3), new Uint8Array(2)]), timers: manualTimers().timers }))).code).toBe("oversize");
    // A header can refuse early; a misleading small one never raises the bound.
    expect((await refusal(acquireBounded(FEED, { maxBytes: 4 }, { transport: t([], { "content-length": "5" }), timers: manualTimers().timers }))).code).toBe("oversize");
    expect((await refusal(acquireBounded(FEED, { maxBytes: 4 }, { transport: t([new Uint8Array(5)], { "content-length": "1" }), timers: manualTimers().timers }))).code).toBe("oversize");
    expect((await refusal(acquireBounded(FEED, { maxBytes: 9 }, { transport: t([new Uint8Array(2)], { "content-length": "3" }), timers: manualTimers().timers }))).code).toBe("truncated");
  });

  test("HTTP failures carry whether a retry can help", async () => {
    for (const [status, retryable] of [[404, false], [429, true], [503, true]] as const) {
      const t = transportOf({ [FEED]: () => response(status) });
      const error = await refusal(acquireBounded(FEED, { maxBytes: 4 }, { transport: t.transport, timers: manualTimers().timers }));
      expect([error.code, error.retryable]).toEqual(["http_status", retryable]);
    }
  });

  test("connect, idle-read and total deadlines each abort the request", async () => {
    const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    // Connect: no response headers.
    {
      const timers = manualTimers();
      let signal!: AbortSignal;
      const work = acquireBounded(FEED, { maxBytes: 4, connectMs: 10, idleReadMs: 30, totalMs: 1200 }, {
        timers: timers.timers, transport: { request: (_url, s) => { signal = s; return hang(s); } },
      });
      await Promise.resolve();
      expect(timers.armed()).toEqual([10, 1200]);
      timers.fire(10);
      expect((await refusal(work)).code).toBe("connect_timeout");
      expect(signal.aborted).toBe(true);
      expect(timers.armed()).toEqual([]);
    }
    // Idle: the body stalls after its first chunk.
    {
      const timers = manualTimers();
      let signal!: AbortSignal;
      const stalled: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { yield Uint8Array.of(1); await hang(signal); } };
      const work = acquireBounded(FEED, { maxBytes: 4, connectMs: 10, idleReadMs: 30, totalMs: 1200 }, {
        timers: timers.timers, transport: { request: async (_url, s) => { signal = s; return { status: 200, headers: { get: () => null }, body: stalled }; } },
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(timers.armed()).toEqual([30, 1200]);
      timers.fire(30);
      expect((await refusal(work)).code).toBe("idle_timeout");
      expect(signal.aborted).toBe(true);
    }
    // Total: the overall deadline wins even while the connection is waiting.
    {
      const timers = manualTimers();
      const work = acquireBounded(FEED, { maxBytes: 4, connectMs: 10, idleReadMs: 30, totalMs: 1200 }, {
        timers: timers.timers, transport: { request: (_url, s) => hang(s) },
      });
      await Promise.resolve();
      timers.fire(1200);
      expect((await refusal(work)).code).toBe("total_timeout");
    }
  });

  test("a transport error is a retryable failure with no partial bytes", async () => {
    const error = await refusal(acquireBounded(FEED, { maxBytes: 4 }, { timers: manualTimers().timers, transport: { request: async () => { throw new Error("ECONNRESET with secret detail"); } } }));
    expect([error.code, error.retryable]).toEqual(["transport", true]);
    expect(error.message).not.toContain("secret");
  });
});
