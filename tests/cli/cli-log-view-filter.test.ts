import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLogFilterCommand, type LogViewFilterDeps } from "../../src/cli/log-view-filter";
import { selectRequestLogPoll } from "../../src/server/request-log-cursor";
import { requestLogDto } from "../../src/server/management/shared";
import { parseProtocolTraceV1 } from "../../src/protocols/dto";
import { filterLogs, DEFAULT_LOG_FILTER_STATE, type LogFilterState, type FilterableLogEntry } from "../../gui/src/pages/logs-filter";
import { hashLogConversationQuery } from "../../gui/src/log-conversation-id";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string, previousHome: string | undefined;
let out: ReturnType<typeof spyOn<typeof console, "log">>;
let err: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-log-view-"));
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "admin-api-token"), "synthetic-admin");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  out.mockRestore(); err.mockRestore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
const NOW = 100_000_000;
const format = (row: Record<string, unknown>) => String(row.id ?? row.requestId);
const output = () => JSON.parse(String(out.mock.calls.at(-1)![0]));
const ids = () => output().logs.map((row: { id: string }) => row.id);
async function run(body: unknown, args: string[] = [], deps: LogViewFilterDeps = {}) {
  return handleLogFilterCommand(["--json", ...args], {
    baseUrl: "http://fixture.test", now: () => NOW,
    fetchImpl: (async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/api/logs");
      expect([...new URL(String(input)).searchParams.keys()]).toEqual(["limit"]);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      return Response.json(body);
    }) as typeof fetch, ...deps,
  }, format);
}

for (const flags of [
  ["--follow"], ["--events"], ["-f"], ["--url=https://example.test"], ["--headers", "private"],
  ["--json"], ["--jsonl"], ["--intercepted-only", "--intercepted-only"], ["--unknown"],
  ["--model"], ["--model=a", "--model", "b"], ["--provider="], ["--surface=desktop"],
  ["--status=200"], ["--time-window=2h"], ["--protocol-mode=invalid"],
  ["--scan-limit=0"], ["--scan-limit=2001"], ["--limit=1.5"], ["--limit=2001"],
  ["--min-tok-per-sec=-1"], ["--max-tok-per-sec=Infinity"], ["--min-tok-per-sec=NaN"],
  ["--min-tok-per-sec= "], ["--min-tok-per-sec=2", "--max-tok-per-sec=2"],
  ["--min-tok-per-sec=3", "--max-tok-per-sec=2"],
  ["--conversation=x", "--conversationId=y"], ["--conversation= "],
  ["--conversation=\tx"], ["--conversation=x\n"], ["--conversation=x\u007f"],
  ["--conversation", "x".repeat(4097)],
]) {
  test(`invalid selectors fail before discovery: ${JSON.stringify(flags[0]?.slice(0, 55))}`, async () => {
    let discoveries = 0, requests = 0;
    expect(await run([], flags, {
      baseUrl: undefined,
      findLiveProxy: async () => { discoveries++; return undefined; },
      fetchImpl: (async () => { requests++; return Response.json([]); }) as typeof fetch,
    })).toBe(2);
    expect(discoveries).toBe(0); expect(requests).toBe(0); expect(out).not.toHaveBeenCalled();
  });
}

type Fixture = FilterableLogEntry & { id: string };
const trace = (mode: string) => ({ v: 1, inbound: "responses", mode,
  requestPath: mode === "blocked" ? [] : ["responses"], responsePath: mode === "blocked" ? [] : ["responses"], reasonCodes: [], contractVersion: "1" });
const rows: Fixture[] = [
  { id: "a", model: " Alias ", provider: " Primary ", status: 200, timestamp: NOW - 900_000,
    resolvedModel: " Target ", displayMetrics: { tokPerSecond: { kind: "value", value: 10 } }, protocolTrace: trace("native") },
  { id: "b", surface: "claude-desktop", model: "different", servedModel: "TARGET", status: 299, timestamp: NOW,
    attempts: [{ provider: "PRIMARY", model: "Retry" }], shadowCallRewrittenFrom: "", displayMetrics: { tokPerSecond: { kind: "value", value: 20 } }, protocolTrace: trace("translated") },
  { id: "c", surface: "claude", status: 400, timestamp: NOW - 900_001, attempts: [{ model: "target" }, null],
    displayMetrics: { tokPerSecond: { kind: "unavailable" } }, protocolTrace: { mode: "native" } },
  { id: "d", surface: "grok", status: 599, timestamp: NOW - 3_600_000, protocolTrace: trace("legacy-bridge") },
  { id: "e", status: 600, timestamp: NOW - 86_400_000, protocolTrace: trace("blocked") },
  { id: "f", status: 300, timestamp: NOW - 86_400_001 },
  { id: "g", status: 200.5, timestamp: "bad", shadowCallRewrittenFrom: false },
  { id: "h", status: "200", timestamp: null },
];
const cases: Array<[string[], Partial<LogFilterState>, string[]]> = [
  [["--surface=codex"], { surface: "codex" }, ["a", "e", "f", "g", "h"]],
  [["--surface=claude"], { surface: "claude" }, ["b", "c"]],
  [["--surface=grok"], { surface: "grok" }, ["d"]],
  [["--model", " tArGeT "], { model: "target" }, ["a", "b", "c"]],
  [["--model=retry"], { model: "retry" }, ["b"]],
  [["--model=tar"], { model: "tar" }, []],
  [["--provider=primary"], { provider: "primary" }, ["a", "b"]],
  [["--status=success"], { status: "success" }, ["a", "b"]],
  [["--status=errors"], { status: "errors" }, ["c", "d"]],
  [["--time-window=15m"], { timeWindow: "15m" }, ["a", "b"]],
  [["--time-window=1h"], { timeWindow: "1h" }, ["a", "b", "c", "d"]],
  [["--time-window=24h"], { timeWindow: "24h" }, ["a", "b", "c", "d", "e"]],
  [["--min-tok-per-sec=10", "--max-tok-per-sec=20"], { minTokPerSec: 10, maxTokPerSec: 20 }, ["a"]],
  [["--min-tok-per-sec=20"], { minTokPerSec: 20 }, ["b"]],
  [["--intercepted-only"], { interceptedOnly: true }, ["b"]],
  [["--protocol-mode=native"], { protocolMode: "native" }, ["a"]],
  [["--protocol-mode=translated"], { protocolMode: "translated" }, ["b"]],
  [["--protocol-mode=legacy-bridge"], { protocolMode: "legacy-bridge" }, ["d"]],
  [["--protocol-mode=blocked"], { protocolMode: "blocked" }, ["e"]],
  [["--protocol-mode=none"], { protocolMode: "none" }, ["c", "f", "g", "h"]],
  [["--model=target", "--surface=claude", "--status=success", "--intercepted-only"],
    { model: "target", surface: "claude", status: "success", interceptedOnly: true }, ["b"]],
];
for (const [flags, filters, expected] of cases) {
  test(`independent selections and GUI conformance: ${flags.join(" ")}`, async () => {
    expect(await run(rows, flags)).toBe(0);
    expect(ids()).toEqual(expected);
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, ...filters }, NOW).map(row => row.id)).toEqual(expected);
  });
}

test("actual management DTO carries the observed speed and protocol trace", async () => {
  const dto = requestLogDto({ requestId: "real-dto", timestamp: NOW, model: "synthetic-model", provider: "synthetic-provider",
    status: 200, durationMs: 2000, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 40 },
    protocolTrace: { v: 1, inbound: "responses", mode: "native", requestPath: ["responses"], responsePath: ["responses"], reasonCodes: [], contractVersion: "1" } });
  expect(dto.displayMetrics).toMatchObject({ tokPerSecond: { kind: "value", value: 20 } });
  expect(parseProtocolTraceV1(dto.protocolTrace)?.mode).toBe("native");
  expect(await run([dto], ["--min-tok-per-sec=20", "--max-tok-per-sec=21", "--protocol-mode=native"])).toBe(0);
  expect(output().logs).toEqual([dto]);
});

test("conversation digest and preimage use the existing owner, including alias spelling", async () => {
  const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e";
  const logs = [{ id: "digest", conversationId: digest }, { id: "direct", conversationId: "hello" }, { id: "other" }];
  expect(await run(logs, ["--conversation= hello "])).toBe(0);
  expect(ids()).toEqual(["digest", "direct"]);
  expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, conversationId: "hello", conversationQueryHash: await hashLogConversationQuery("hello") }, NOW).map(row => row.id)).toEqual(["digest", "direct"]);
  expect(await run(logs, ["--conversationId", digest])).toBe(0);
  expect(ids()).toEqual(["digest"]);
});

test("modern scope counts ignore server totals and unknown metadata, preserving recent ordered duplicates", async () => {
  const logs = [{ id: "old", model: "match" }, { id: "unmatched" }, { id: "new", model: "match" }, { id: "new", model: "match" }];
  const wire = selectRequestLogPoll(logs, new URLSearchParams({ limit: "4" }), null, "a".repeat(32));
  expect(await run({ ...wire, total: 9999, privateMetadata: "not-in-view" }, ["--scan-limit=4", "--limit=2", "--model=MATCH"])).toBe(0);
  expect(ids()).toEqual(["new", "new"]);
  expect(output().window).toEqual({ scanLimit: 4, loaded: 4, matched: 3, returned: 2, limit: 2 });
  expect(output().cursor).toBe(wire.cursor);
  expect(output().filters.model).toBe("match");
  expect(output()).not.toHaveProperty("total"); expect(output()).not.toHaveProperty("privateMetadata");
});
for (const body of [[], { logs: [] }, { entries: [] }, { requests: [] }]) {
  test(`valid empty legacy envelope ${JSON.stringify(body)}`, async () => {
    expect(await run(body)).toBe(0);
    expect(output().window).toEqual({ scanLimit: 2000, loaded: 0, matched: 0, returned: 0, limit: 200 });
    expect(output().cursor).toBeNull();
  });
}
for (const body of [null, {}, { logs: null }, [null], [[]], [1], { logs: [], reset: false },
  { logs: [], cursor: "invalid", reset: true }, { logs: [{ id: 1 }, { id: 2 }] }]) {
  test(`malformed or excess window is failure, never empty success: ${JSON.stringify(body)}`, async () => {
    expect(await run(body, ["--scan-limit=1"])).toBe(1);
    expect(out).not.toHaveBeenCalled();
  });
}

test("human empty scope is explicit and human rows use the terminal-safe renderer", async () => {
  const deps = { baseUrl: "http://fixture.test", fetchImpl: (async () => Response.json([{ id: "x\u001b[31m" }])) as typeof fetch };
  expect(await handleLogFilterCommand(["--model=missing"], deps, format)).toBe(0);
  expect(String(out.mock.calls[0]![0])).toContain("0 returned / 0 matched / 1 scanned");
  expect(String(out.mock.calls[1]![0])).toContain("No matching logs");
  out.mockClear();
  expect(await handleLogFilterCommand([], deps, format)).toBe(0);
  expect(out.mock.calls[1]![0]).toBe("x\\x1b[31m");
});
test("JSONL prints only selected rows with duplicates", async () => {
  const logs = [{ id: "a" }, { id: "b", model: "yes" }, { id: "b", model: "yes" }];
  expect(await handleLogFilterCommand(["--jsonl", "--model=yes"], {
    baseUrl: "http://fixture.test", fetchImpl: (async () => Response.json(logs)) as typeof fetch,
  }, format)).toBe(0);
  expect(out.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual(logs.slice(1));
});

test("defaults scan 2000 and return the most recent 200; maximum output remains available", async () => {
  const logs = Array.from({ length: 2000 }, (_, id) => ({ id }));
  expect(await run(logs)).toBe(0);
  expect(output().window).toEqual({ scanLimit: 2000, loaded: 2000, matched: 2000, returned: 200, limit: 200 });
  expect(output().logs[0].id).toBe(1800);
  expect(await run(logs, ["--limit=2000"])).toBe(0);
  expect(output().logs).toEqual(logs);
});

test("unavailable/malformed observed metrics do not use raw token estimates", async () => {
  const logs = [
    { id: "zero", displayMetrics: { tokPerSecond: { kind: "value", value: 0 } } },
    { id: "raw", tokPerSecond: 1, usage: { outputTokens: 100 }, durationMs: 1000 },
    { id: "null", displayMetrics: null },
    { id: "string", displayMetrics: { tokPerSecond: { kind: "value", value: "1" } } },
    { id: "unavailable", displayMetrics: { tokPerSecond: { kind: "unavailable", value: 1 } } },
  ];
  expect(await run(logs, ["--min-tok-per-sec=0", "--max-tok-per-sec=1"])).toBe(0);
  expect(ids()).toEqual(["zero"]);
});

test("exact byte ceiling succeeds without relaxing the next-byte rejection", async () => {
  const valid = "[]" + " ".repeat(32 * 1024 * 1024 - 2);
  expect(await run([], [], { fetchImpl: (async () => new Response(valid)) as typeof fetch })).toBe(0);
  expect(output().logs).toEqual([]);
});

test("discovery interruption and SIGTERM keep nonzero signal exits with no late result", async () => {
  const controller = new AbortController();
  let requests = 0;
  expect(await run([], [], {
    baseUrl: undefined, signal: controller.signal,
    findLiveProxy: async () => { controller.abort(); return undefined; },
    fetchImpl: (async () => { requests++; return Response.json([]); }) as typeof fetch,
  })).toBe(130);
  expect(requests).toBe(0);
  expect(await run([], [], { fetchImpl: (async () => { process.emit("SIGTERM"); return Response.json([]); }) as typeof fetch })).toBe(143);
  expect(out).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled();
});

test("pre-abort and header/body cancellation suppress late output and release signal listeners", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const pre = new AbortController(); pre.abort();
  let requests = 0;
  expect(await run([], [], { signal: pre.signal, fetchImpl: (async () => { requests++; return Response.json([]); }) as typeof fetch })).toBe(130);
  expect(requests).toBe(0);
  for (const bodyPhase of [false, true]) {
    const controller = new AbortController();
    expect(await run([], [], { signal: controller.signal, fetchImpl: (async () => {
      if (!bodyPhase) { controller.abort(); return Response.json([]); }
      return new Response(new ReadableStream({ pull() { controller.abort(); } }));
    }) as typeof fetch })).toBe(130);
  }
  expect(out).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled();
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});
test("bounded timeout and malformed transport errors retain snapshot recovery wording", async () => {
  for (const fetchImpl of [
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    (async () => new Response(new ReadableStream())) as typeof fetch,
    (async () => new Response("broken-json")) as typeof fetch,
    (async () => new Response(new Uint8Array([0xff]))) as typeof fetch,
    (async () => new Response("private response", { status: 403 })) as typeof fetch,
  ]) {
    expect(await run([], [], { requestTimeoutMs: 5, fetchImpl })).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls.at(-1)![0])).toContain("retry the command");
    expect(String(err.mock.calls.at(-1)![0])).not.toContain("private response");
  }
});
test("oversized body points to scan-limit and does not claim empty data", async () => {
  expect(await run([], [], { fetchImpl: (async () => new Response(" ".repeat(32 * 1024 * 1024 + 1))) as typeof fetch })).toBe(1);
  expect(out).not.toHaveBeenCalled();
  expect(String(err.mock.calls.at(-1)![0])).toContain("Reduce --scan-limit");
});
test("real loopback redirect never reaches its destination", async () => {
  let destinationRequests = 0;
  const destination = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { destinationRequests++; return Response.json([]); } });
  const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.redirect(destination.url); } });
  try {
    expect(await handleLogFilterCommand(["--json"], { baseUrl: source.url.origin }, format)).toBe(1);
    expect(destinationRequests).toBe(0); expect(out).not.toHaveBeenCalled();
  } finally { await source.stop(true); await destination.stop(true); }
});
