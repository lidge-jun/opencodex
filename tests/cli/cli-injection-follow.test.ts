import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleObserveCommand } from "../../src/cli/observe";
import { getInjectionDebugLogEntries, injectionDebugLog, resetInjectionDebugLogBufferForTests } from "../../src/lib/injection-debug-log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let prior: string | undefined;
let out: ReturnType<typeof spyOn<typeof console, "log">>;
let err: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-injection-follow-")); process.env.OPENCODEX_HOME = home;
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
  resetInjectionDebugLogBufferForTests();
});
afterEach(() => {
  out.mockRestore(); err.mockRestore(); resetInjectionDebugLogBufferForTests();
  if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
  removeTreeWithRetry(home);
});

async function scripted(bodies: unknown[], flags: string[] = ["--jsonl"]) {
  let index = 0;
  const paths: URL[] = [];
  const controller = new AbortController();
  const code = await handleObserveCommand(["injection", "--follow", ...flags], {
    baseUrl: "http://fixture.test", pollIntervalMs: 1, signal: controller.signal,
    fetchImpl: (async (input, init) => {
      paths.push(new URL(String(input)));
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
      if (index === bodies.length) { controller.abort(); return Response.json([]); }
      return Response.json(bodies[index++]);
    }) as typeof fetch,
  });
  return { code, paths };
}

test("actual injection ring supplies latest-N and strict after without inventing gap recovery", async () => {
  injectionDebugLog("one"); injectionDebugLog("two"); injectionDebugLog("three");
  const first = getInjectionDebugLogEntries({ limit: 2 });
  injectionDebugLog("four");
  const second = getInjectionDebugLogEntries({ after: first[1]!.seq, limit: 2 });
  out.mockClear();
  const { code, paths } = await scripted([first, [], second, []], ["--jsonl", "--limit", "2"]);
  expect(code).toBe(130);
  expect(out.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([...first, ...second]);
  expect(first.map(row => row.seq)).toEqual([2, 3]); expect(second.map(row => row.seq)).toEqual([4]);
  expect(paths.map(path => Object.fromEntries(path.searchParams))).toEqual([
    { limit: "2", after: "0" }, { limit: "2", after: "3" }, { limit: "2", after: "3" },
    { limit: "2", after: "4" }, { limit: "2", after: "4" },
  ]);
  expect(paths.every(path => path.pathname === "/api/debug/injection-logs")).toBe(true);
});

test("empty injection polls emit no output and keep after at zero", async () => {
  const { code, paths } = await scripted([[], [], []]);
  expect(code).toBe(130); expect(out).not.toHaveBeenCalled();
  expect(paths.every(path => path.searchParams.get("after") === "0" && path.searchParams.get("limit") === "500")).toBe(true);
});

for (const body of [null, {}, { logs: [] }, [null], [{ seq: 0, at: 1, line: "x" }],
  [{ seq: -1, at: 1, line: "x" }], [{ seq: 1.5, at: 1, line: "x" }],
  [{ seq: Number.MAX_SAFE_INTEGER + 1, at: 1, line: "x" }], [{ seq: 1, at: null, line: "x" }],
  [{ seq: 1, at: "1", line: "x" }], [{ seq: 1, at: 1, line: 1 }],
  [{ seq: 1, at: 1, line: "x" }, { seq: 1, at: 2, line: "y" }],
  [{ seq: 2, at: 1, line: "x" }, { seq: 1, at: 2, line: "y" }]]) {
  test(`malformed injection poll is refused atomically: ${JSON.stringify(body)}`, async () => {
    expect((await scripted([body])).code).toBe(1); expect(out).not.toHaveBeenCalled();
  });
}

test("a stale seq after a good poll stops without a fabricated epoch/reset", async () => {
  expect((await scripted([[{ seq: 5, at: 1, line: "first" }], [{ seq: 1, at: 2, line: "restart" }]])).code).toBe(1);
  expect(out.mock.calls).toHaveLength(1);
});

test("human lines escape controls; JSONL preserves data and strips unknown fields", async () => {
  const row = { seq: 1, at: 10, line: "line\n\u001b[31m", extra: "not-public" };
  expect((await scripted([[row]], [])).code).toBe(130);
  expect(out.mock.calls[0]![0]).toBe("1  10  line\\x0a\\x1b[31m");
  out.mockClear();
  expect((await scripted([[row]])).code).toBe(130);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ seq: 1, at: 10, line: row.line });
});

for (const flags of [["--jsonl"], ["--follow", "--json"], ["--follow", "--limit", "0"],
  ["--follow", "--limit", "2001"], ["--follow", "--limit", "1.5"], ["--follow", "--after", "1"]]) {
  test(`injection grammar rejects before transport: ${flags.join(" ")}`, async () => {
    let calls = 0;
    expect(await handleObserveCommand(["injection", ...flags], { fetchImpl: (async () => { calls++; return Response.json([]); }) as typeof fetch })).toBe(2);
    expect(calls).toBe(0); expect(out).not.toHaveBeenCalled();
  });
}

test("one-shot JSON remains unchanged and uses no after parameter", async () => {
  const body = [{ seq: 1, at: 1, line: "x", old: "preserved" }];
  expect(await handleObserveCommand(["injection", "--json", "--limit", "7"], { baseUrl: "http://fixture.test",
    fetchImpl: (async input => { expect(String(input)).toBe("http://fixture.test/api/debug/injection-logs?limit=7"); return Response.json(body); }) as typeof fetch })).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(body);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const stage of ["headers", "body", "wait"] as const) {
    test(`${signal} during ${stage} stops output/polls and removes listeners`, async () => {
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      let calls = 0, cancelled = false;
      const code = await handleObserveCommand(["injection", "--follow", "--jsonl"], {
        baseUrl: "http://fixture.test", pollIntervalMs: 1,
        fetchImpl: (async (_input, init) => {
          calls++;
          if (stage === "headers") return new Promise<Response>((_, reject) => {
            init!.signal!.addEventListener("abort", () => { cancelled = true; reject(new Error("CANARY")); }, { once: true });
            process.emit(signal);
          });
          if (stage === "body") return new Response(new ReadableStream({
            pull() { process.emit(signal); }, cancel() { cancelled = true; },
          }));
          // The print callback schedules a signal after synchronous printing, during the wait.
          out.mockImplementation(() => { queueMicrotask(() => process.emit(signal)); });
          return Response.json([{ seq: 1, at: 1, line: "x" }]);
        }) as typeof fetch,
      });
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
      expect(calls).toBe(1);
      expect(out.mock.calls.length).toBe(stage === "wait" ? 1 : 0);
      if (stage !== "wait") expect(cancelled).toBe(true);
      expect(err).not.toHaveBeenCalled();
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    });
  }
}

test("external cancellation discards a late header response and cancels its body", async () => {
  const controller = new AbortController();
  let respond!: (response: Response) => void;
  let cancelled = false;
  expect(await handleObserveCommand(["injection", "--follow"], { baseUrl: "http://fixture.test", signal: controller.signal,
    fetchImpl: (() => {
      const promise = new Promise<Response>(resolve => { respond = resolve; });
      controller.abort(); return promise;
    }) as typeof fetch })).toBe(130);
  respond(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve();
  expect(cancelled).toBe(true); expect(out).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled();
});

test("injection redirect never reaches its destination", async () => {
  let calls = 0;
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { calls++; return Response.json([]); } });
  const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`${target.url}stolen`, 307) });
  try {
    expect(await handleObserveCommand(["injection", "--follow"], { baseUrl: source.url.origin })).toBe(1);
    expect(calls).toBe(0); expect(out).not.toHaveBeenCalled();
  } finally { await source.stop(true); await target.stop(true); }
});
