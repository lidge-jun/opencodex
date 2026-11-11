import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedServiceTier } from "../../src/lib/response-service-tier";
import { boundedModelIdentity, knownModelIdentity } from "../../src/lib/model-identity";
import {
  addFinalRequestLog, addRequestLog, clearRequestLogsForTests, getRequestLogEntries, inspectResponseLogJson,
  requestLogEntryFromPersistedUsage, type RequestLogContext, type RequestLogEntry,
} from "../../src/server/request-log";
import { requestLogDto } from "../../src/server/management/shared";
import { readUsageEntries, resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { log } from "../helpers/request-log-entry";

// A provider key with no recognizable prefix, so pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";

function withHome<T>(run: () => T): T {
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-identity-bounds-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  try {
    return run();
  } finally {
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
}

describe("response service tier is a closed member", () => {
  test("members are kept (case-folded); anything else is omitted", () => {
    for (const tier of ["auto", "default", "flex", "scale", "priority", "fast", "standard", "ultrafast"]) {
      expect(boundedServiceTier(tier)).toBe(tier);
    }
    expect(boundedServiceTier(" Priority ")).toBe("priority");
    for (const value of [PROVIDER_KEY, "performance", "", "priority " + PROVIDER_KEY, 1, null]) {
      expect(boundedServiceTier(value)).toBeUndefined();
    }
  });

  test("capture from a response payload keeps only members", () => {
    const ctx: RequestLogContext = { model: "m", provider: "openai" };
    inspectResponseLogJson(ctx, JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: PROVIDER_KEY } }));
    expect(ctx.responseServiceTier).toBeUndefined();
    const known: RequestLogContext = { model: "m", provider: "openai" };
    inspectResponseLogJson(known, JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "flex" } }));
    expect(known.responseServiceTier).toBe("flex");
  });

  test("live row, attempts, ledger, hydration and the logs DTO never carry an unknown tier", () => withHome(() => {
    const attempt = { ordinal: 1, provider: "openai", model: "m", adapter: "openai-responses", status: 200, durationMs: 1,
      sendCount: 1, recoveryKinds: [], usageStatus: "unreported" as const,
      tierOutcome: { fastOutcome: "not-requested", confirmation: "unknown", responseServiceTier: PROVIDER_KEY } };
    addRequestLog(log({ requestId: "tier-canary", status: 200, responseServiceTier: PROVIDER_KEY,
      tierOutcome: { fastOutcome: "not-requested", confirmation: "unknown", responseServiceTier: PROVIDER_KEY },
      attempts: [attempt] } as unknown as RequestLogEntry));
    const live = getRequestLogEntries().find(entry => entry.requestId === "tier-canary")!;
    expect(JSON.stringify(live)).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(requestLogDto(live))).not.toContain(PROVIDER_KEY);
    expect(readFileSync(usageLogPath(), "utf8")).not.toContain(PROVIDER_KEY);
    const hydrated = requestLogEntryFromPersistedUsage(readUsageEntries().find(entry => entry.requestId === "tier-canary")!);
    expect(JSON.stringify(hydrated)).not.toContain(PROVIDER_KEY);
  }));

  test("the hydration projection bounds tiers itself, without relying on the disk reader", () => {
    const outcome = { fastOutcome: "not-requested", confirmation: "unknown", responseServiceTier: PROVIDER_KEY };
    const attempt = { ordinal: 1, provider: "openai", model: "m", adapter: "openai-responses", status: 200, durationMs: 1,
      sendCount: 1, recoveryKinds: [], usageStatus: "unreported", tierOutcome: { ...outcome } };
    const raw = { requestId: "raw-tier", timestamp: 1, model: "m", provider: "openai", status: 200, durationMs: 1,
      usageStatus: "unreported", responseServiceTier: PROVIDER_KEY, tierOutcome: { ...outcome }, attempts: [attempt] };
    const hydrated = requestLogEntryFromPersistedUsage(raw as unknown as Parameters<typeof requestLogEntryFromPersistedUsage>[0]);
    expect(JSON.stringify(hydrated)).not.toContain(PROVIDER_KEY);
    expect(hydrated.responseServiceTier).toBeUndefined();
    expect(hydrated.tierOutcome).toEqual({ fastOutcome: "not-requested", confirmation: "unknown" });
    // The caller's row is not edited in place.
    expect(attempt.tierOutcome.responseServiceTier).toBe(PROVIDER_KEY);
    const known = requestLogEntryFromPersistedUsage({ ...raw, responseServiceTier: "Priority", attempts: [] } as unknown as Parameters<typeof requestLogEntryFromPersistedUsage>[0]);
    expect(known.responseServiceTier).toBe("priority");
  });
});

describe("model identity fields share one bound", () => {
  test("the grammar is [A-Za-z0-9._:/@-] up to 128 characters", () => {
    expect(boundedModelIdentity("anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
    expect(boundedModelIdentity("accounts/fireworks/models/llama-v3p1:latest@2026")).toBe("accounts/fireworks/models/llama-v3p1:latest@2026");
    expect(boundedModelIdentity("m".repeat(128))).toBe("m".repeat(128));
    for (const value of ["m".repeat(129), "model+" + PROVIDER_KEY, "model " + PROVIDER_KEY, "sk-proj-" + PROVIDER_KEY, "", 5]) {
      expect(boundedModelIdentity(value)).toBeUndefined();
    }
  });

  test("served and resolved models are kept only as model ids the route already knows, on every surface", () => withHome(() => {
    // A prefixless key fits the identifier grammar, so only the known-model rule can refuse it.
    expect(boundedModelIdentity(PROVIDER_KEY)).toBe(PROVIDER_KEY);
    expect(knownModelIdentity(PROVIDER_KEY, ["m", "gpt-5.5"])).toBeUndefined();
    expect(knownModelIdentity("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(knownModelIdentity("m", ["m"])).toBe("m");
    addRequestLog(log({ requestId: "identity-canary", status: 200, servedModel: "gpt-5.6-sol", resolvedModel: PROVIDER_KEY }));
    addRequestLog(log({ requestId: "identity-unknown", status: 200, servedModel: "gpt-served", resolvedModel: "gpt-resolved" }));
    const ctx: RequestLogContext = { model: "m", provider: "openai", wireModel: "m-wire", servedModel: PROVIDER_KEY, resolvedModel: "m-wire" };
    const rows: RequestLogEntry[] = [];
    addFinalRequestLog("identity-final", Date.now(), ctx, 200, { closeReason: "terminal" }, row => rows.push(row));
    addRequestLog(rows[0]!);
    // The response-body capture path applies the same rule before anything is recorded.
    const observed: RequestLogContext = { model: "m", provider: "openai" };
    inspectResponseLogJson(observed, JSON.stringify({ model: PROVIDER_KEY }));
    expect(observed.servedModel).toBeUndefined();
    inspectResponseLogJson(observed, JSON.stringify({ model: "gpt-5.6-sol" }));
    expect(observed.servedModel).toBe("gpt-5.6-sol");
    for (const id of ["identity-canary", "identity-unknown", "identity-final"]) {
      const live = getRequestLogEntries().find(entry => entry.requestId === id)!;
      expect(live).toBeDefined();
      expect(JSON.stringify(live)).not.toContain(PROVIDER_KEY);
      expect(JSON.stringify(requestLogDto(live))).not.toContain(PROVIDER_KEY);
    }
    const canary = getRequestLogEntries().find(entry => entry.requestId === "identity-canary")!;
    expect(canary.servedModel).toBe("gpt-5.6-sol");
    expect(canary.resolvedModel).toBeUndefined();
    const unknown = getRequestLogEntries().find(entry => entry.requestId === "identity-unknown")!;
    expect([unknown.servedModel, unknown.resolvedModel]).toEqual([undefined, undefined]);
    const final = getRequestLogEntries().find(entry => entry.requestId === "identity-final")!;
    expect([final.servedModel, final.resolvedModel]).toEqual([undefined, "m-wire"]);
    expect(readFileSync(usageLogPath(), "utf8")).not.toContain(PROVIDER_KEY);
    const persisted = readUsageEntries();
    expect(persisted.length).toBeGreaterThanOrEqual(3);
    for (const entry of persisted) expect(JSON.stringify(requestLogEntryFromPersistedUsage(entry))).not.toContain(PROVIDER_KEY);
    // Hydration applies the rule itself to a row that did not come through the disk reader.
    const hydrated = requestLogEntryFromPersistedUsage({ ...persisted[0]!, servedModel: PROVIDER_KEY, resolvedModel: PROVIDER_KEY });
    expect(JSON.stringify(hydrated)).not.toContain(PROVIDER_KEY);
  }));
});
