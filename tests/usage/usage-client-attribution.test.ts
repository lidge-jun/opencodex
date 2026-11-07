import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyUsageClient, normalizeRecordedClient } from "../../src/usage/client";
import { normalizePersistedUsageRow, readUsageEntries, resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { createUsageSummaryAccumulator } from "../../src/usage/summary";
import { parseUsageSource } from "../../src/usage/source-filter";
import { createSourceFacetAccumulator } from "../../src/usage/source-facets";
import { addFinalRequestLog, addRequestLog, clearRequestLogsForTests, getRequestLogEntries, requestLogEntryFromPersistedUsage, type RequestLogEntry } from "../../src/server/request-log";
import { log } from "../helpers/request-log-entry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("usage client attribution", () => {
  test("classifies supported clients from bounded request headers", () => {
    expect(classifyUsageClient(new Headers({ originator: "codex_cli_rs" }))).toBe("codex_cli");
    expect(classifyUsageClient(new Headers({ originator: "codex-tui" }))).toBe("codex_cli");
    expect(classifyUsageClient(new Headers({ originator: "Codex Desktop" }))).toBe("codex_desktop");
    expect(classifyUsageClient(new Headers({ originator: "codex_desktop", "user-agent": "codex_cli_rs/0.154.0" }))).toBe("codex_desktop");
    expect(classifyUsageClient(new Headers({ "user-agent": "codex_cli_rs/0.154.0" }))).toBe("codex_cli");
    expect(classifyUsageClient(new Headers({ originator: "codex_vscode" }))).toBe("codex_ide");
    expect(classifyUsageClient(new Headers({ "user-agent": "claude-code/2.1.207" }))).toBe("claude_code");
    expect(classifyUsageClient(new Headers({ "user-agent": "claude-cli/2.1.282 (external, cli)" }))).toBe("claude_code");
    expect(classifyUsageClient(new Headers({ "user-agent": "claude-cli/2.1.282 (external, claude-desktop)" }))).toBe("claude_desktop");
    expect(classifyUsageClient(new Headers({ originator: "opencode" }))).toBe("opencode");
    expect(classifyUsageClient(new Headers({ "user-agent": "opencode/1.2.3 runtime/bun" }))).toBe("opencode");
  });

  test("does not infer an app from unknown, malformed, conflicting or oversized headers", () => {
    expect(classifyUsageClient(new Headers())).toBe("unknown");
    expect(classifyUsageClient(new Headers({ "user-agent": "claude-code/" }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ "user-agent": "claude-cli/2.1.282 (external, arbitrary-token)" }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ originator: "codex_cli_rs", "user-agent": "claude-code/1.0" }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ originator: "codex_cli_rs", "user-agent": "opencode/1.2.3" }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ originator: "x".repeat(1025) }))).toBe("unknown");
    expect(classifyUsageClient(new Headers({ "user-agent": "private-header-marker" }))).toBe("unknown");
  });

  test("preserves missing old attribution while bounding present persisted values", () => {
    expect(normalizeRecordedClient(undefined)).toBeUndefined();
    expect(normalizeRecordedClient("codex_cli")).toBe("codex_cli");
    expect(normalizeRecordedClient("unknown")).toBe("unknown");
    expect(normalizeRecordedClient("private-header-marker")).toBe("unknown");
    expect(normalizeRecordedClient(null)).toBe("unknown");
  });

  test("ledger normalization distinguishes legacy rows from new and invalid client values", () => {
    const base = { requestId: "fixture", timestamp: 1, provider: "openai", model: "gpt-test",
      status: 200, durationMs: 1, usageStatus: "unreported" };
    expect(normalizePersistedUsageRow(base)).not.toHaveProperty("client");
    expect(normalizePersistedUsageRow({ ...base, client: "codex_cli" })).toHaveProperty("client", "codex_cli");
    expect(normalizePersistedUsageRow({ ...base, client: "private-header-marker" })).toHaveProperty("client", "unknown");
  });

  test("live, disk and rehydrated logs retain only closed client labels", () => {
    const previous = process.env.OPENCODEX_HOME;
    const testDir = mkdtempSync(join(tmpdir(), "ocx-client-attribution-"));
    process.env.OPENCODEX_HOME = testDir;
    clearRequestLogsForTests();
    try {
      const raw = Object.assign(log({ requestId: "invalid-client" }), { client: "private-header-marker" });
      addRequestLog(raw as unknown as RequestLogEntry);
      const finalized: RequestLogEntry[] = [];
      addFinalRequestLog("valid-client", 1, { model: "gpt-test", provider: "openai", client: "codex_cli" },
        200, { closeReason: "non_stream" }, row => finalized.push(row));
      expect(getRequestLogEntries()[0]?.client).toBe("unknown");
      expect(readUsageEntries()[0]?.client).toBe("unknown");
      expect(requestLogEntryFromPersistedUsage(readUsageEntries()[0]!)?.client).toBe("unknown");
      expect(finalized[0]?.client).toBe("codex_cli");
      expect(readFileSync(usageLogPath(), "utf8")).not.toContain("private-header-marker");
    } finally {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(testDir);
    }
  });

  test("app and device selections intersect and retain a range-aware legacy count", () => {
    const now = Date.now();
    const base = { timestamp: now, provider: "openai", model: "gpt-test", status: 200,
      durationMs: 10, usageStatus: "unreported" as const };
    const rows = [
      { ...base, requestId: "legacy-now" },
      { ...base, requestId: "legacy-old", timestamp: now - 10 * 86400_000 },
      { ...base, requestId: "codex", client: "codex_cli" as const, apiKeyId: "Key-A" },
      { ...base, requestId: "unclassified", client: "unknown" as const },
      { ...base, requestId: "claude", client: "claude_code" as const },
    ];
    const accumulator = createUsageSummaryAccumulator({ filter: {
      sourceFilter: { client: "codex", device: { kind: "no-key" } },
    } });
    for (const row of rows) accumulator.add(row);
    const week = accumulator.summarize("7d", now);
    expect(week.summary.requests).toBe(1);
    expect(week.legacyUnclassifiedRequests).toBe(1);
    expect(accumulator.summarize("30d", now).legacyUnclassifiedRequests).toBe(2);
    const clone = accumulator.clone();
    clone.add({ ...base, requestId: "legacy-appended" });
    expect(clone.summarize("7d", now).legacyUnclassifiedRequests).toBe(2);
    expect(accumulator.summarize("7d", now).legacyUnclassifiedRequests).toBe(1);

    const keyed = createUsageSummaryAccumulator({ filter: {
      sourceFilter: { client: "codex", device: { kind: "key", id: "Key-A" } },
    } });
    for (const row of rows) keyed.add(row);
    expect(keyed.summarize("7d", now).summary.requests).toBe(1);
    const wrongCase = createUsageSummaryAccumulator({ filter: {
      sourceFilter: { client: "codex", device: { kind: "key", id: "key-a" } },
    } });
    for (const row of rows) wrongCase.add(row);
    expect(wrongCase.summarize("7d", now).summary.requests).toBe(0);
  });

  test("custom windows and caller mutation do not change the captured source filter", () => {
    const now = Date.now();
    const filter = { client: "codex" as const, device: { kind: "no-key" as const } };
    const accumulator = createUsageSummaryAccumulator({ filter: { sourceFilter: filter }, window: { since: now - 500, until: now } });
    const base = { timestamp: now - 250, provider: "openai", model: "gpt-test", status: 200,
      durationMs: 10, usageStatus: "unreported" as const };
    Object.assign(filter.device, { kind: "all" });
    accumulator.add({ ...base, requestId: "inside" });
    accumulator.add({ ...base, requestId: "outside", timestamp: now - 1000 });
    accumulator.add({ ...base, requestId: "keyed", client: "codex_cli", apiKeyId: "key" });
    const report = accumulator.summarize("30d", now);
    expect(report.summary.requests).toBe(1);
    expect(report.legacyUnclassifiedRequests).toBe(1);
    expect(report.sourceFilter).toEqual({ client: "codex", device: { kind: "no-key" } });
    Object.assign(report.sourceFilter!.device, { kind: "all" });
    accumulator.add({ ...base, requestId: "another-key", client: "codex_cli", apiKeyId: "key" });
    expect(accumulator.summarize("30d", now).summary.requests).toBe(1);
  });

  test("source-filtered snapshot bounds do not reveal unmatched rows", () => {
    const now = Date.now();
    const base = { provider: "openai", model: "gpt-test", status: 200, durationMs: 1, usageStatus: "unreported" as const };
    const accumulator = createUsageSummaryAccumulator({ filter: { sourceFilter: {
      client: "codex", device: { kind: "key", id: "Key-A" },
    } } });
    accumulator.add({ ...base, requestId: "other-old", timestamp: now - 100_000, client: "codex_cli", apiKeyId: "Key-B" });
    expect(accumulator.snapshotWindow).toEqual({ start: null, end: null });
    accumulator.add({ ...base, requestId: "own", timestamp: now, client: "codex_cli", apiKeyId: "Key-A" });
    accumulator.add({ ...base, requestId: "other-new", timestamp: now + 100_000, client: "codex_cli", apiKeyId: "Key-B" });
    expect(accumulator.snapshotWindow).toEqual({ start: now, end: now });
    expect(accumulator.clone().snapshotWindow).toEqual({ start: now, end: now });
  });

  test("all apps includes unknown rows without classifying old Claude rows as Codex", () => {
    const now = Date.now();
    const base = { timestamp: now, provider: "mock", model: "gpt-test", status: 200,
      durationMs: 10, usageStatus: "unreported" as const };
    const rows = [{ ...base, requestId: "old-codex" },
      { ...base, requestId: "old-claude", surface: "claude" as const },
      { ...base, requestId: "new-unknown", client: "unknown" as const }];
    for (const [client, expected] of [["all", 3], ["codex", 1], ["unknown", 2]] as const) {
      const accumulator = createUsageSummaryAccumulator({ filter: { sourceFilter: { client, device: { kind: "all" } } } });
      for (const row of rows) accumulator.add(row);
      expect(accumulator.summarize("7d", now).summary.requests).toBe(expected);
    }
  });

  test("source query parser rejects conflicting, duplicate and incomplete dimensions", () => {
    expect(parseUsageSource(new URLSearchParams("apiKeyId=legacy-key"))).toEqual({ kind: "legacy" });
    expect(parseUsageSource(new URLSearchParams("client=codex&device=key&apiKeyId=Key-A"))).toEqual({
      kind: "filtered", filter: { client: "codex", device: { kind: "key", id: "Key-A" } },
    });
    for (const query of ["client=codex", "device=all", "client=bad&device=all", "client=codex&device=key",
      "client=codex&device=key&apiKeyId=%20key", "client=codex&device=all&apiKeyId=key",
      "client=codex&device=all&surface=claude", "client=codex&device=all&surface=all&surface=all",
      "client=codex&device=all&failures=1", "client=codex&device=all&jev=1"]) {
      expect(parseUsageSource(new URLSearchParams(query))).toEqual({ kind: "invalid" });
    }
  });

  test("unconfigured keys use an immutable full configured-key snapshot", () => {
    const now = Date.now();
    const configuredApiKeyIds = ["active", "ordinary"];
    const accumulator = createUsageSummaryAccumulator({ filter: {
      sourceFilter: { client: "all", device: { kind: "unconfigured" } }, configuredApiKeyIds,
    } });
    configuredApiKeyIds.push("former");
    const base = { timestamp: now, provider: "openai", model: "gpt-test", status: 200,
      durationMs: 1, usageStatus: "unreported" as const };
    accumulator.add({ ...base, requestId: "former", admissionKind: "configured", apiKeyId: "former" });
    accumulator.add({ ...base, requestId: "active", admissionKind: "configured", apiKeyId: "active" });
    accumulator.add({ ...base, requestId: "ordinary", admissionKind: "configured", apiKeyId: "ordinary" });
    accumulator.add({ ...base, requestId: "legacy", apiKeyId: "legacy" });
    accumulator.add({ ...base, requestId: "local", admissionKind: "loopback" });
    expect(accumulator.summarize("30d", now).summary.requests).toBe(1);
    expect(accumulator.clone().summarize("30d", now).summary.requests).toBe(1);
    expect(parseUsageSource(new URLSearchParams("client=all&device=unconfigured"))).toEqual({
      kind: "filtered", filter: { client: "all", device: { kind: "unconfigured" } },
    });
  });

  test("unconfigured key snapshots reject excessive identities without truncating them", () => {
    const sourceFilter = { client: "all" as const, device: { kind: "unconfigured" as const } };
    expect(() => createUsageSummaryAccumulator({ filter: { sourceFilter, configuredApiKeyIds: ["x".repeat(257)] } })).toThrow();
    expect(() => createUsageSummaryAccumulator({ filter: { sourceFilter, configuredApiKeyIds: Array.from({ length: 1025 }, (_, i) => `id-${i}`) } })).toThrow();
    const ids = Array.from({ length: 257 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(253)}`);
    const allowed = createUsageSummaryAccumulator({ filter: { sourceFilter, configuredApiKeyIds: ids.slice(0, 256) } });
    expect(allowed.estimatedBytes).toBeGreaterThan(256 * 256 * 2);
    expect(() => createUsageSummaryAccumulator({ filter: { sourceFilter, configuredApiKeyIds: ids } })).toThrow();
  });

  test("source facets count matching rows in both dimensions without retaining arbitrary key IDs", () => {
    const now = Date.now();
    const filter = { client: "codex" as const, device: { kind: "all" as const } };
    const facets = createSourceFacetAccumulator(filter, ["active"], { since: now - 1000, until: now });
    const base = { timestamp: now - 1, provider: "openai", model: "test", status: 200,
      durationMs: 1, usageStatus: "unreported" as const };
    facets.add({ ...base, requestId: "legacy" });
    facets.add({ ...base, requestId: "active", client: "codex_cli", admissionKind: "configured", apiKeyId: "active" });
    facets.add({ ...base, requestId: "former", client: "codex_desktop", admissionKind: "configured", apiKeyId: "former" });
    facets.add({ ...base, requestId: "claude", client: "claude_code", admissionKind: "configured", apiKeyId: "active" });
    facets.add({ ...base, requestId: "future", timestamp: now + 1, client: "codex_cli" });
    const result = facets.snapshot();
    expect(result.apps.all).toBe(4);
    expect(result.apps.codex).toBe(3);
    expect(result.apps.claude_code).toBe(1);
    expect(result.devices).toEqual([
      { device: { kind: "all" }, requests: 3 }, { device: { kind: "no-key" }, requests: 1 },
      { device: { kind: "key", id: "active" }, requests: 1 }, { device: { kind: "unconfigured" }, requests: 1 },
    ]);
    expect(result.legacyUnclassifiedRequests).toBe(1);
    expect(JSON.stringify(result)).not.toContain("former");
    const claudeSelected = createSourceFacetAccumulator({ client: "claude_code", device: { kind: "all" } }, ["active"], { since: now - 1000, until: now });
    claudeSelected.add({ ...base, requestId: "legacy" });
    expect(claudeSelected.snapshot().legacyUnclassifiedRequests).toBe(1);
  });

  test("an unselectable configured key does not hide other devices or become unconfigured", () => {
    const now = Date.now();
    const facets = createSourceFacetAccumulator({ client: "all", device: { kind: "all" } }, ["valid", "odd "], { since: now - 1, until: now });
    const base = { timestamp: now, provider: "openai", model: "test", status: 200, durationMs: 1,
      usageStatus: "unreported" as const, admissionKind: "configured" as const };
    facets.add({ ...base, requestId: "good", apiKeyId: "valid" });
    facets.add({ ...base, requestId: "odd", apiKeyId: "odd " });
    const result = facets.snapshot();
    expect(result.unavailableConfiguredKeys).toBe(1);
    expect(result.devices).toContainEqual({ device: { kind: "key", id: "valid" }, requests: 1 });
    expect(result.devices).toContainEqual({ device: { kind: "unconfigured" }, requests: 0 });
    expect(result.devices.some(row => row.device.kind === "key" && row.device.id === "odd ")).toBe(false);
    expect(result.apps.all).toBe(2);
  });
});
