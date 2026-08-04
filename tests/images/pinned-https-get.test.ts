import { EventEmitter } from "node:events";
import { describe, expect, mock, test } from "bun:test";

type LookupCb =
  | ((err: Error | null, address: string, family: number) => void)
  | ((err: Error | null, addresses: { address: string; family: number }[]) => void);

/**
 * Capture the custom lookup + response-stream path used by pinnedHttpsGet without
 * opening a real TLS socket (Windows CI friendly).
 */
function installHttpsMock(bodyChunks: Buffer[], statusCode = 200) {
  const requestMock = mock((
    _options: unknown,
    onResponse?: (res: EventEmitter & { statusCode: number; headers: Record<string, string>; setTimeout: Function; resume: Function }) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: Function;
      end: Function;
      destroy: Function;
      destroyed: boolean;
    };
    req.destroyed = false;
    req.setTimeout = mock(() => {});
    req.destroy = mock(() => { req.destroyed = true; });
    req.end = mock(() => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        setTimeout: Function;
        resume: Function;
      };
      res.statusCode = statusCode;
      res.headers = { "content-type": "image/png" };
      res.setTimeout = mock(() => {});
      res.resume = mock(() => {});
      queueMicrotask(() => {
        onResponse?.(res);
        queueMicrotask(() => {
          for (const chunk of bodyChunks) res.emit("data", chunk);
          res.emit("end");
        });
      });
    });
    return req;
  });

  mock.module("node:https", () => ({
    default: { request: requestMock },
    request: requestMock,
  }));

  return requestMock;
}

describe("pinnedHttpsGet transport", () => {
  test("lookup honors scalar and { all: true } callback shapes", async () => {
    let capturedLookup: ((hostname: string, opts: unknown, cb?: LookupCb) => void) | undefined;
    const requestMock = mock((options: { lookup?: typeof capturedLookup }, onResponse?: Function) => {
      capturedLookup = options.lookup;
      const req = new EventEmitter() as EventEmitter & { setTimeout: Function; end: Function; destroy: Function };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          setTimeout: Function;
          resume: Function;
        };
        res.statusCode = 200;
        res.headers = {};
        res.setTimeout = () => {};
        res.resume = () => {};
        queueMicrotask(() => {
          onResponse?.(res);
          queueMicrotask(() => res.emit("end"));
        });
      };
      return req;
    });
    mock.module("node:https", () => ({ default: { request: requestMock }, request: requestMock }));

    const { pinnedHttpsGet } = await import("../../src/images/artifacts");
    const pinned = { address: "93.184.216.34", family: 4 };
    const respPromise = pinnedHttpsGet("https://cdn.example/img.png", pinned);
    // Give request() a tick to store lookup.
    await Promise.resolve();
    expect(capturedLookup).toBeTypeOf("function");

    let scalar: { address?: string; family?: number } = {};
    capturedLookup!("cdn.example", {}, ((err, address, family) => {
      expect(err).toBeNull();
      scalar = { address: address as string, family: family as number };
    }) as LookupCb);
    expect(scalar).toEqual({ address: "93.184.216.34", family: 4 });

    let allAddrs: { address: string; family: number }[] | undefined;
    capturedLookup!("cdn.example", { all: true }, ((err, addresses) => {
      expect(err).toBeNull();
      allAddrs = addresses as { address: string; family: number }[];
    }) as LookupCb);
    expect(allAddrs).toEqual([{ address: "93.184.216.34", family: 4 }]);

    const resp = await respPromise;
    expect(resp.ok).toBe(true);
    await resp.arrayBuffer(); // drain stream
  });

  test("exceeding maxBytes aborts mid-stream without buffering the full body", async () => {
    const small = Buffer.alloc(1024, 1);
    const chunks = [small, small, small]; // 3 KiB total
    installHttpsMock(chunks);

    const { pinnedHttpsGet } = await import("../../src/images/artifacts");
    const maxBytes = 1500; // trip on the second chunk
    const resp = await pinnedHttpsGet(
      "https://cdn.example/big.png",
      { address: "93.184.216.34", family: 4 },
      undefined,
      { maxBytes },
    );
    expect(resp.body).toBeTruthy();
    const reader = resp.body!.getReader();
    let sawError = false;
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
    } catch {
      sawError = true;
    }
    expect(sawError).toBe(true);
    // Must fail before absorbing all three chunks (3 KiB).
    expect(received).toBeLessThan(chunks.reduce((n, c) => n + c.byteLength, 0));
    expect(received).toBeLessThanOrEqual(maxBytes + small.byteLength);
  });

  test("3xx redirect status rejects without following", async () => {
    let resDestroyed = false;
    const requestMock = mock((
      _options: unknown,
      onResponse?: (res: EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        destroy: () => void;
      }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: () => void;
        };
        res.statusCode = 301;
        res.headers = { location: "https://evil.example/redirect" };
        res.destroy = () => { resDestroyed = true; };
        queueMicrotask(() => onResponse?.(res));
      };
      return req;
    });
    mock.module("node:https", () => ({ default: { request: requestMock }, request: requestMock }));

    const { pinnedHttpsGet } = await import("../../src/images/artifacts");
    await expect(pinnedHttpsGet(
      "https://cdn.example/redirect.png",
      { address: "93.184.216.34", family: 4 },
    )).rejects.toThrow(/301/);
    expect(resDestroyed).toBe(true);
  });

  test("non-2xx destroys the transport immediately without buffering body chunks", async () => {
    // Regression: a 500 that keeps emitting must not resolve a streaming Response
    // whose body nobody will read — destroy on status and reject before any data
    // listener is attached.
    let dataListeners = 0;
    let reqDestroyed = false;
    let resDestroyed = false;
    const requestMock = mock((
      _options: unknown,
      onResponse?: (res: EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        setTimeout: Function;
        resume: Function;
        destroy: Function;
        on: Function;
      }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: Function;
        end: Function;
        destroy: Function;
      };
      req.setTimeout = mock(() => {});
      req.destroy = mock(() => { reqDestroyed = true; });
      req.end = mock(() => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          setTimeout: Function;
          resume: Function;
          destroy: Function;
        };
        res.statusCode = 500;
        res.headers = { "content-type": "text/plain" };
        res.setTimeout = mock(() => {});
        res.resume = mock(() => {});
        res.destroy = mock(() => { resDestroyed = true; });
        const originalOn = res.on.bind(res);
        res.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === "data") dataListeners += 1;
          return originalOn(event, listener);
        }) as typeof res.on;
        queueMicrotask(() => {
          onResponse?.(res);
          // Keep dumping body after headers — must not be buffered by pinnedHttpsGet.
          queueMicrotask(() => {
            for (let i = 0; i < 32; i++) res.emit("data", Buffer.alloc(64 * 1024, 7));
            res.emit("end");
          });
        });
      });
      return req;
    });
    mock.module("node:https", () => ({ default: { request: requestMock }, request: requestMock }));

    const { pinnedHttpsGet } = await import("../../src/images/artifacts");
    await expect(pinnedHttpsGet(
      "https://cdn.example/fail.png",
      { address: "93.184.216.34", family: 4 },
    )).rejects.toThrow(/image download failed: 500/);

    expect(resDestroyed).toBe(true);
    expect(reqDestroyed).toBe(true);
    expect(dataListeners).toBe(0);
  });

  test("idle timeout fires when no AbortSignal is supplied", async () => {
    const requestMock = mock((
      _options: unknown,
      _onResponse?: Function,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number, cb: () => void) => void;
        end: Function;
        destroy: Function;
      };
      req.destroy = mock(() => {});
      req.setTimeout = (_ms, cb) => { queueMicrotask(cb); };
      req.end = mock(() => { /* never respond */ });
      return req;
    });
    mock.module("node:https", () => ({ default: { request: requestMock }, request: requestMock }));

    const { pinnedHttpsGet } = await import("../../src/images/artifacts");
    await expect(pinnedHttpsGet(
      "https://cdn.example/hang.png",
      { address: "93.184.216.34", family: 4 },
      undefined,
      { idleTimeoutMs: 1 },
    )).rejects.toThrow(/timed out/);
  });

  test("forwards idleTimeoutMs to request and response socket timers", async () => {
    let reqIdleMs: number | undefined;
    let resIdleMs: number | undefined;
    const requestMock = mock((
      _options: unknown,
      onResponse?: (res: EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        setTimeout: (ms: number, cb: () => void) => void;
        resume: () => void;
      }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number, cb: () => void) => void;
        end: () => void;
        destroy: () => void;
      };
      req.destroy = () => {};
      req.setTimeout = (ms) => { reqIdleMs = ms; };
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          setTimeout: (ms: number, cb: () => void) => void;
          resume: () => void;
        };
        res.statusCode = 200;
        res.headers = { "content-type": "image/png" };
        res.resume = () => {};
        res.setTimeout = (ms) => { resIdleMs = ms; };
        queueMicrotask(() => {
          onResponse?.(res);
          queueMicrotask(() => res.emit("end"));
        });
      };
      return req;
    });
    mock.module("node:https", () => ({ default: { request: requestMock }, request: requestMock }));

    const { pinnedHttpsGet } = await import("../../src/images/artifacts");
    const resp = await pinnedHttpsGet(
      "https://cdn.example/img.png",
      { address: "93.184.216.34", family: 4 },
      undefined,
      { idleTimeoutMs: 12_345 },
    );
    expect(reqIdleMs).toBe(12_345);
    expect(resIdleMs).toBe(12_345);
    await resp.arrayBuffer();
  });
});
