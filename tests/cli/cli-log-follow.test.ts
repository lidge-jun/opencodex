import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleObserveCommand } from "../../src/cli/observe";
import { decodeRequestLogCursor, selectRequestLogPoll } from "../../src/server/request-log-cursor";
import { parseLogPollResponse, mergeLogDelta } from "../../gui/src/pages/log-poll";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let prior: string | undefined;
let out: ReturnType<typeof spyOn<typeof console, "log">>;
let err: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-log-follow-"));
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "admin-api-token"), "synthetic-admin");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  out.mockRestore(); err.mockRestore();
  if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
  removeTreeWithRetry(home);
});
const output = () => out.mock.calls.map(call => JSON.parse(String(call[0])));
const epoch = "a".repeat(32);

async function scripted(bodies: unknown[], flags: string[] = ["--events"], paths: URL[] = []) {
  const controller = new AbortController();
  let index = 0;
  return handleObserveCommand(["logs", "--follow", ...flags], {
    baseUrl: "http://fixture.test", signal: controller.signal, pollIntervalMs: 1,
    fetchImpl: (async (input, init) => {
      paths.push(new URL(String(input)));
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      if (index === bodies.length) { controller.abort(); return Response.json([]); }
      return Response.json(bodies[index++]);
    }) as typeof fetch,
  });
}

test("actual cursor codec and GUI conformance preserve amendments, duplicates, deletion and empty reset", async () => {
  const a = { requestId: "same", tokens: 1 }, b = { requestId: "same", tokens: 2 };
  const windows = [[], [a, a], [a, a], [b, a], [a], [], []];
  const expectedEvents = [
    { schemaVersion: 1, type: "snapshot", rows: [], limit: 200 },
    { schemaVersion: 1, type: "append", rows: [a, a], limit: 200 },
    { schemaVersion: 1, type: "snapshot", rows: [b, a], limit: 200 },
    { schemaVersion: 1, type: "snapshot", rows: [a], limit: 200 },
    { schemaVersion: 1, type: "snapshot", rows: [], limit: 200 },
  ];
  let index = 0;
  let priorCursor: string | null = null;
  let gui: object[] = [];
  const controller = new AbortController();
  const code = await handleObserveCommand(["logs", "--follow", "--events", "--jsonl"], {
    baseUrl: "http://fixture.test", signal: controller.signal, pollIntervalMs: 1,
    fetchImpl: (async input => {
      const url = new URL(String(input));
      expect(url.searchParams.get("cursor")).toBe(priorCursor);
      if (index === windows.length) { controller.abort(); return Response.json([]); }
      const wire = selectRequestLogPoll(windows[index]!, url.searchParams, priorCursor ? decodeRequestLogCursor(priorCursor) : null, epoch);
      const parsed = parseLogPollResponse<object>(wire);
      gui = priorCursor && parsed.cursor && !parsed.reset ? mergeLogDelta(gui, parsed.rows, 200) : parsed.rows;
      expect(gui).toEqual(windows[index]);
      index++;
      priorCursor = wire.cursor;
      return Response.json(wire);
    }) as typeof fetch,
  });
  expect(code).toBe(130);
  const events = output();
  expect(events.map(({ cursor, ...event }) => event)).toEqual(expectedEvents);
  for (const event of events) expect(decodeRequestLogCursor(event.cursor)).not.toBeNull();
  expect(err).not.toHaveBeenCalled();
});

test("legacy JSONL compares full row occurrences including identical duplicates and same-ID amendments", async () => {
  const a = { id: 1, tokens: 1 }, b = { id: 1, tokens: 2 };
  expect(await scripted([[a, a], { entries: [a, a] }, { requests: [a, a, a] }, { logs: [a, b, a] }, []], ["--jsonl"])).toBe(130);
  expect(output()).toEqual([a, a, a, b]);
});

test("legacy snapshot events reconstruct removals and use null cursor without empty-poll flooding", async () => {
  const row = { id: "x" };
  const paths: URL[] = [];
  expect(await scripted([[], [], [row, row], [row], [], []], ["--events"], paths)).toBe(130);
  expect(output()).toEqual([
    { schemaVersion: 1, type: "snapshot", rows: [], cursor: null, limit: 200 },
    { schemaVersion: 1, type: "snapshot", rows: [row, row], cursor: null, limit: 200 },
    { schemaVersion: 1, type: "snapshot", rows: [row], cursor: null, limit: 200 },
    { schemaVersion: 1, type: "snapshot", rows: [], cursor: null, limit: 200 },
  ]);
  expect(paths.every(path => !path.searchParams.has("cursor"))).toBe(true);
});

test("cursor-only changes update request state but emit no invented row", async () => {
  const params = new URLSearchParams({ limit: "200" });
  const first = selectRequestLogPoll([], params, null, epoch);
  const next = selectRequestLogPoll([], params, null, "b".repeat(32));
  const paths: URL[] = [];
  expect(await scripted([first, next], ["--events"], paths)).toBe(130);
  expect(output()).toHaveLength(1);
  expect(paths[2]!.searchParams.get("cursor")).toBe(next.cursor);
});

for (const body of [null, {}, { logs: null }, [null], { logs: [], cursor: "bad", reset: false },
  { logs: [], cursor: Buffer.from(JSON.stringify({ v: 2, n: 0 })).toString("base64url"), reset: false },
  { logs: [], reset: false }, { logs: [], cursor: "x" }, { entries: [1] }]) {
  test(`malformed window is nonzero without an invented empty snapshot: ${JSON.stringify(body)}`, async () => {
    expect(await scripted([body])).toBe(1);
    expect(out).not.toHaveBeenCalled();
  });
}

test("malformed response following a valid window emits no replacement event", async () => {
  expect(await scripted([[{ id: 1 }], { surprise: [] }])).toBe(1);
  expect(output()).toHaveLength(1);
  expect(output()[0].rows).toEqual([{ id: 1 }]);
});

for (const flags of [["--events"], ["--follow", "--events", "--json"], ["--follow", "--json"],
  ["--follow", "--limit", "0"], ["--follow", "--limit", "2001"], ["--follow", "--limit", "1.5"]]) {
  test(`invalid stream grammar fails before network: ${flags.join(" ")}`, async () => {
    let requests = 0;
    expect(await handleObserveCommand(["logs", ...flags], { fetchImpl: (async () => { requests++; return Response.json([]); }) as typeof fetch })).toBe(2);
    expect(requests).toBe(0); expect(out).not.toHaveBeenCalled();
  });
}

test("query filters stay server-side and row rendering is terminal safe", async () => {
  const paths: URL[] = [];
  expect(await scripted([[{ timestamp: "t", status: 200, provider: "x\u001b[31m", model: "m", requestId: "r" }]],
    ["--provider", "x", "--model", "m", "--status", "2xx", "--conversation", "c", "--account", "a", "--limit", "1"], paths)).toBe(130);
  expect(Object.fromEntries(paths[0]!.searchParams)).toEqual({ provider: "x", model: "m", status: "2xx", conversationId: "c", account: "a", limit: "1" });
  expect(out.mock.calls[0]![0]).toBe("t  200  x\\x1b[31m/m  id=r");
});

test("oversized row count fails instead of silently truncating", async () => {
  expect(await scripted([[{ id: 1 }, { id: 2 }]], ["--limit", "1", "--events"])).toBe(1);
  expect(out).not.toHaveBeenCalled();
});

test("runtime identity drift refuses the later poll without retargeting", async () => {
  let discoveries = 0, calls = 0;
  const code = await handleObserveCommand(["logs", "--follow", "--events"], {
    pollIntervalMs: 1,
    findLiveProxy: async () => ({ port: 10100, pid: ++discoveries === 1 ? 123 : 124, source: "runtime" }),
    fetchImpl: (async () => { calls++; return Response.json([]); }) as typeof fetch,
  });
  expect(code).toBe(1); expect(calls).toBe(1);
  expect(err.mock.calls.flat().join("\n")).toContain("runtime changed");
});

test("redirect destination receives zero requests", async () => {
  let received = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { received++; return Response.json([]); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`${target.url}stolen`, 302) });
  try {
    expect(await handleObserveCommand(["logs", "--follow"], { baseUrl: source.url.origin })).toBe(1);
    expect(received).toBe(0); expect(out).not.toHaveBeenCalled();
  } finally { await source.stop(true); await target.stop(true); }
});

for (const stage of ["headers", "body"] as const) {
  test(`total deadline bounds stalled ${stage} without raw errors`, async () => {
    let cancelled = false;
    const code = await handleObserveCommand(["logs", "--follow"], {
      baseUrl: "http://fixture.test", requestTimeoutMs: 15,
      fetchImpl: (async (_input, init) => {
        if (stage === "headers") return new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener("abort", () => { cancelled = true; reject(new Error("CANARY")); }, { once: true });
        });
        return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }));
      }) as typeof fetch,
    });
    expect(code).toBe(1); expect(cancelled).toBe(true);
    expect(out).not.toHaveBeenCalled(); expect(err.mock.calls.flat().join("\n")).not.toContain("CANARY");
  });
}

test("body byte cap cancels and explains how to reduce the window", async () => {
  let cancelled = false;
  expect(await handleObserveCommand(["logs", "--follow"], {
    baseUrl: "http://fixture.test",
    fetchImpl: (async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }))) as typeof fetch,
  })).toBe(1);
  expect(cancelled).toBe(true); expect(out).not.toHaveBeenCalled();
  expect(err.mock.calls.flat().join("\n")).toContain("Reduce --limit");
});

for (const body of [new Uint8Array([0xff]), "not JSON"]) {
  test(`invalid body encoding fails safely: ${typeof body}`, async () => {
    expect(await handleObserveCommand(["logs", "--follow"], { baseUrl: "http://fixture.test",
      fetchImpl: (async () => new Response(body)) as typeof fetch })).toBe(1);
    expect(out).not.toHaveBeenCalled();
  });
}

test("preabort does no discovery, fetch or output and removes signal listeners", async () => {
  const controller = new AbortController(); controller.abort();
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let calls = 0;
  expect(await handleObserveCommand(["logs", "--follow"], { signal: controller.signal,
    findLiveProxy: async () => { calls++; return null; } })).toBe(130);
  expect(calls).toBe(0); expect(out).not.toHaveBeenCalled();
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

test("explicit empty reset emits a snapshot even when last window was empty", async () => {
  const params = new URLSearchParams({ limit: "200" });
  const first = selectRequestLogPoll([], params, null, epoch);
  const reset = selectRequestLogPoll([], params, decodeRequestLogCursor(first.cursor), "b".repeat(32));
  expect(await scripted([first, reset])).toBe(130);
  expect(output().map(event => ({ type: event.type, rows: event.rows }))).toEqual([
    { type: "snapshot", rows: [] }, { type: "snapshot", rows: [] },
  ]);
});

test("the retained comparison window respects limit across eviction and a returning occurrence", async () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  expect(await scripted([[a, b], [b, c], [a, b]], ["--jsonl", "--limit", "2"])).toBe(130);
  expect(output()).toEqual([a, b, c, a]);
});

test("the exact 32 MiB JSON response boundary is accepted", async () => {
  const controller = new AbortController();
  let calls = 0;
  expect(await handleObserveCommand(["logs", "--follow", "--events"], {
    baseUrl: "http://fixture.test", signal: controller.signal, pollIntervalMs: 1,
    fetchImpl: (async () => {
      if (calls++) { controller.abort(); return Response.json([]); }
      return new Response("[]".padEnd(32 * 1024 * 1024, " "));
    }) as typeof fetch,
  })).toBe(130);
  expect(output()).toEqual([{ schemaVersion: 1, type: "snapshot", rows: [], cursor: null, limit: 200 }]);
});

for (const [args, signal, code] of [
  [["logs", "--follow", "--events"], "SIGINT", 130],
  [["observe", "logs", "--follow", "--events"], "SIGTERM", 143],
] as const) {
  test(`public dispatch preserves ${signal} numeric exit for ${args[0]}`, async () => {
    const { dispatchCommand } = await import("../../src/cli/dispatch");
    const { parseCliHead } = await import("../../src/cli/root");
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      expect(new URL(request.url).pathname).toBe("/api/logs");
      requests++;
      process.emit(signal);
      return Response.json([]);
    } });
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    try {
      const argv = [...args];
      // The observed runner only owns args and discovery. Any other access fails the fixture.
      const deps = new Proxy({ args: argv, command: argv[0], findLiveProxy: async () => ({ pid: 123, hostname: "127.0.0.1", port: server.port!, source: "runtime" as const }) }, {
        get(target, key) { if (key in target) return Reflect.get(target, key); throw new Error("Unexpected dispatcher dependency"); },
      }) as unknown as import("../../src/cli/dispatch").CliDispatchDeps;
      expect(await dispatchCommand(parseCliHead(argv), deps)).toBe(code);
      expect(requests).toBe(1); expect(out).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled();
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    } finally { await server.stop(true); }
  });
}

test("a validated suffix emits a new occurrence even when its full row equals a retained occurrence", async () => {
  const row = { id: "same", requestId: "same", tokens: 1 };
  const params = new URLSearchParams({ limit: "200" });
  const first = selectRequestLogPoll([row], params, null, epoch);
  const suffix = selectRequestLogPoll([row, row], params, decodeRequestLogCursor(first.cursor), epoch);
  expect(suffix.reset).toBe(false); expect(suffix.logs).toEqual([row]);
  expect(await scripted([first, suffix], ["--jsonl"])).toBe(130);
  expect(output()).toEqual([row, row]);
  out.mockClear();
  expect(await scripted([first, suffix], ["--events"])).toBe(130);
  expect(output().map(event => ({ type: event.type, rows: event.rows }))).toEqual([
    { type: "snapshot", rows: [row] }, { type: "append", rows: [row] },
  ]);
});
