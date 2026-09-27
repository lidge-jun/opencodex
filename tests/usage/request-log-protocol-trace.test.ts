/**
 * The observed protocol trace on request-log rows (PF-02): computed at finalize, carried
 * through the persisted usage row, re-validated on read, and filterable by `protocolMode`.
 */
import { describe, expect, test } from "bun:test";
import type { ProtocolTraceV1 } from "../../src/protocols/dto";
import { markProtocolBlocked, markProtocolEntry } from "../../src/protocols/trace";
import {
  addFinalRequestLog,
  beginRequestAttempt,
  filterRequestLogs,
  filteredRequestLogCount,
  queryRequestLogs,
  requestLogEntryFromPersistedUsage,
  type RequestLogContext,
  type RequestLogEntry,
} from "../../src/server/request-log";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../src/usage/log";

function finalize(logCtx: RequestLogContext, status = 200): RequestLogEntry {
  let captured: RequestLogEntry | undefined;
  addFinalRequestLog("req-trace", Date.now() - 10, logCtx, status, { closeReason: "terminal" }, entry => {
    captured = entry;
  });
  if (!captured) throw new Error("no row finalized");
  return captured;
}

const baseRow: PersistedUsageEntry = {
  requestId: "ocx-row",
  timestamp: 1_700_000_000_000,
  provider: "p",
  model: "m",
  status: 200,
  durationMs: 5,
  usageStatus: "reported",
};

const bridgeTrace: ProtocolTraceV1 = {
  v: 1,
  inbound: "chat",
  mode: "legacy-bridge",
  upstream: "messages",
  requestPath: ["chat", "responses-internal", "ir", "messages"],
  responsePath: ["messages", "ir", "responses-internal", "chat"],
  reasonCodes: ["cross-wire-ir", "not-migrated"],
  featureEffects: [{ feature: "request.seed", disposition: "unsupported" }],
  attempts: [{ ordinal: 1, upstream: "messages", mode: "legacy-bridge", requestPath: ["chat", "responses-internal", "ir", "messages"] }],
  contractVersion: "2026-09-24.1",
};

describe("addFinalRequestLog protocol trace", () => {
  test("a Chat bridge row carries the lane-derived trace", () => {
    const attempt = beginRequestAttempt(1, "p", "m", "anthropic");
    const logCtx: RequestLogContext = { model: "m", provider: "p", inboundProtocol: "chat", attempts: [attempt] };
    markProtocolEntry(logCtx, { inbound: "chat", lane: "bridge", reasonCodes: ["cross-wire-ir"], features: ["request.seed"] });
    const row = finalize(logCtx);
    expect(row.protocolTrace).toMatchObject({
      mode: "legacy-bridge",
      requestPath: ["chat", "responses-internal", "ir", "messages"],
      featureEffects: [{ feature: "request.seed", disposition: "unsupported" }],
    });
  });

  test("a blocked Messages row carries a blocked trace; an unmarked non-Responses row carries none", () => {
    const blocked: RequestLogContext = { model: "unknown", provider: "unknown", inboundProtocol: "messages" };
    markProtocolBlocked(blocked, { inbound: "messages", reasonCodes: ["surface-disabled"] });
    expect(finalize(blocked, 403).protocolTrace).toMatchObject({ mode: "blocked", reasonCodes: ["surface-disabled"] });

    const unmarked: RequestLogContext = { model: "m", provider: "p", attempts: [beginRequestAttempt(1, "p", "m", "openai-chat")] };
    expect(finalize(unmarked).protocolTrace).toBeUndefined();
  });
});

describe("persisted protocol trace", () => {
  test("round-trips through the usage row and hydrates back", () => {
    const normalized = normalizeUsageEntryForTest({ ...baseRow, protocolTrace: bridgeTrace });
    expect(normalized.protocolTrace).toEqual(bridgeTrace);
    const hydrated = requestLogEntryFromPersistedUsage(JSON.parse(JSON.stringify(normalized)) as PersistedUsageEntry);
    expect(hydrated.protocolTrace).toEqual(bridgeTrace);
  });

  test("an old row without a trace hydrates with none", () => {
    expect(normalizeUsageEntryForTest(baseRow)).not.toHaveProperty("protocolTrace");
    expect(requestLogEntryFromPersistedUsage(baseRow)).not.toHaveProperty("protocolTrace");
  });

  test("a hand-edited trace that fails validation is dropped, not forwarded", () => {
    const corrupt = { ...baseRow, protocolTrace: { ...bridgeTrace, reasonCodes: ["free text"] } } as unknown as PersistedUsageEntry;
    expect(normalizeUsageEntryForTest(corrupt)).not.toHaveProperty("protocolTrace");
    expect(requestLogEntryFromPersistedUsage(corrupt)).not.toHaveProperty("protocolTrace");
    const future = { ...baseRow, protocolTrace: { ...bridgeTrace, v: 2 } } as unknown as PersistedUsageEntry;
    expect(requestLogEntryFromPersistedUsage(future)).not.toHaveProperty("protocolTrace");
  });
});

describe("protocolMode filter", () => {
  const row = (requestId: string, protocolTrace?: ProtocolTraceV1): RequestLogEntry => ({
    requestId,
    timestamp: 1,
    model: "m",
    provider: "p",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    ...(protocolTrace ? { protocolTrace } : {}),
  });
  const logs = [
    row("bridge", bridgeTrace),
    row("native", { ...bridgeTrace, mode: "native", requestPath: ["chat", "chat"], responsePath: ["chat", "chat"] }),
    row("blocked", { ...bridgeTrace, mode: "blocked", requestPath: [], responsePath: [] }),
    row("old"),
  ];
  const ids = (query: string) => filterRequestLogs(logs, new URLSearchParams(query)).map(entry => entry.requestId);

  test("selects by final mode, and none selects rows without a trace", () => {
    expect(ids("protocolMode=legacy-bridge")).toEqual(["bridge"]);
    expect(ids("protocolMode=native")).toEqual(["native"]);
    expect(ids("protocolMode=blocked")).toEqual(["blocked"]);
    expect(ids("protocolMode=translated")).toEqual([]);
    expect(ids("protocolMode=none")).toEqual(["old"]);
    expect(filteredRequestLogCount(logs, new URLSearchParams("protocolMode=native&limit=1"))).toBe(1);
  });

  test("an unrecognised mode matches nothing instead of being ignored", () => {
    expect(ids("protocolMode=verified")).toEqual([]);
    expect(ids("")).toEqual(["bridge", "native", "blocked", "old"]);
  });

  test("combined filters retain protocol mode through tail, count and pagination", () => {
    const native = { ...bridgeTrace, mode: "native" as const, requestPath: ["chat", "chat"] as ProtocolTraceV1["requestPath"], responsePath: ["chat", "chat"] as ProtocolTraceV1["responsePath"] };
    const matching = (requestId: string, status = 200) => ({
      ...row(requestId, native), accountLogLabel: "account-a", status,
    });
    const entries = [
      matching("first"),
      matching("middle", 204),
      matching("error", 500),
      { ...matching("other-provider"), provider: "q" },
      { ...matching("other-mode"), protocolTrace: bridgeTrace },
      matching("last"),
    ];
    const params = new URLSearchParams("provider=p&model=m&account=account-a&status=2xx&protocolMode=native&tail=2&limit=1&offset=1");
    const result = queryRequestLogs(entries, params);
    expect(result.total).toBe(2);
    expect(result.logs.map(entry => entry.requestId)).toEqual(["middle"]);
    expect(filterRequestLogs(entries, params).map(entry => entry.requestId)).toEqual(["middle"]);
    expect(filteredRequestLogCount(entries, params)).toBe(2);
  });
});
