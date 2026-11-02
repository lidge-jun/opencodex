import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedServiceTier } from "../../src/lib/response-service-tier";
import { boundedModelIdentity } from "../../src/lib/model-identity";
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

  test("served and resolved models are validated independently on every surface", () => withHome(() => {
    const bad = "model+" + PROVIDER_KEY;
    addRequestLog(log({ requestId: "identity-canary", status: 200, servedModel: "gpt-served", resolvedModel: bad }));
    const ctx: RequestLogContext = { model: "m", provider: "openai", servedModel: bad, resolvedModel: "gpt-resolved" };
    const rows: RequestLogEntry[] = [];
    addFinalRequestLog("identity-final", Date.now(), ctx, 200, { closeReason: "terminal" }, row => rows.push(row));
    addRequestLog(rows[0]!);
    for (const id of ["identity-canary", "identity-final"]) {
      const live = getRequestLogEntries().find(entry => entry.requestId === id)!;
      expect(JSON.stringify(live)).not.toContain(PROVIDER_KEY);
      expect(JSON.stringify(requestLogDto(live))).not.toContain(PROVIDER_KEY);
    }
    expect(getRequestLogEntries().find(entry => entry.requestId === "identity-canary")!.servedModel).toBe("gpt-served");
    expect(getRequestLogEntries().find(entry => entry.requestId === "identity-final")!.resolvedModel).toBe("gpt-resolved");
    expect(readFileSync(usageLogPath(), "utf8")).not.toContain(PROVIDER_KEY);
    for (const entry of readUsageEntries()) expect(JSON.stringify(requestLogEntryFromPersistedUsage(entry))).not.toContain(PROVIDER_KEY);
  }));
});
