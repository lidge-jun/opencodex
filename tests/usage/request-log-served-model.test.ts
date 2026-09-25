import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFinalRequestLog,
  addRequestLog,
  applyResponseLogMetadata,
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogContext,
} from "../../src/server/request-log";
import {
  appendUsageEntry, normalizeUsageEntryForTest, resetUsageReadCacheForTests, usageLogPath,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { log } from "../helpers/request-log-entry";

test("upstream served model persists only when it is a plausible bounded identifier", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-served-model-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  try {
    const valid = "vendor/model.v2:@+-_";
    // Credential-shaped but inside the identifier alphabet; built at runtime so no token-like literal is committed.
    const credentialShaped = ["eyJ" + "a".repeat(12), "b".repeat(12), "c".repeat(8)].join(".");
    const invalid = ["m".repeat(201), "model\ninjected", "model with space", "model\twith-tab", credentialShaped];
    for (const [index, model] of [valid, ...invalid].entries()) {
      const context: RequestLogContext = {
        model: "route-model",
        provider: "openai",
        resolvedModel: "route-model",
        preserveResolvedModelFromRoute: true,
      };
      applyResponseLogMetadata(context, { response: { model } });
      addFinalRequestLog(`response-${index}`, 1, context, 200);
    }

    // Both public ingress paths also reject a bad value even if a caller skips response inspection.
    addRequestLog(log({ requestId: "direct-request", servedModel: invalid[0], resolvedModel: invalid[0] }));
    addRequestLog(log({ requestId: "direct-request-credential", servedModel: credentialShaped, resolvedModel: credentialShaped }));
    appendUsageEntry({
      requestId: "direct-usage", timestamp: 1, provider: "openai", model: "route-model",
      status: 200, durationMs: 10, usageStatus: "unreported",
      servedModel: invalid[1], resolvedModel: invalid[1],
    });
    appendUsageEntry({
      requestId: "direct-usage-credential", timestamp: 2, provider: "openai", model: "route-model",
      status: 200, durationMs: 10, usageStatus: "unreported",
      servedModel: credentialShaped, resolvedModel: credentialShaped,
    });

    const rows = readFileSync(usageLogPath(home), "utf8").trimEnd().split("\n")
      .map(line => JSON.parse(line) as { requestId: string; servedModel?: string; resolvedModel?: string });
    expect(rows[0]).toMatchObject({ requestId: "response-0", servedModel: valid, resolvedModel: "route-model" });
    expect(getRequestLogEntries()[0]).toMatchObject({ servedModel: valid, resolvedModel: "route-model" });
    for (const row of rows.slice(1)) {
      expect(row).not.toHaveProperty("servedModel");
      expect(row.resolvedModel).toBe(row.requestId.startsWith("response-") ? "route-model" : undefined);
    }
    for (const row of getRequestLogEntries().slice(1)) {
      expect(row).not.toHaveProperty("servedModel");
    }
  } finally {
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

function anthropicContext(): RequestLogContext {
  return {
    model: "claude-opus-5-5",
    provider: "anthropic",
    resolvedModel: "claude-opus-5-5",
    wireModel: "claude-opus-5-5",
    preserveResolvedModelFromRoute: true,
    responseModelEcho: "anthropic/claude-opus-5-5",
  };
}

test("the client selector echoed in response.model is not recorded as the served model", () => {
  const echoed = anthropicContext();
  applyResponseLogMetadata(echoed, { response: { model: "anthropic/claude-opus-5-5" } });
  expect(echoed.servedModel).toBeUndefined();
  expect(echoed.resolvedModel).toBe("claude-opus-5-5");

  // A model the upstream really answered with is still an observation.
  const rerouted = anthropicContext();
  applyResponseLogMetadata(rerouted, { response: { model: "claude-opus-5-1" } });
  expect(rerouted.servedModel).toBe("claude-opus-5-1");

  // A combo parent inherits a child's echo of the combo selector.
  const combo: RequestLogContext = {
    model: "mycombo", provider: "combo", requestedModel: "mycombo", wireModel: "claude-opus-5-5",
  };
  applyResponseLogMetadata(combo, { model: "mycombo" });
  expect(combo.servedModel).toBeUndefined();
  expect(combo.resolvedModel).toBeUndefined();
});

test("rows persisted with a selector echo lose it on read", () => {
  const row = (fields: Partial<PersistedUsageEntry>): PersistedUsageEntry => ({
    requestId: "legacy", timestamp: 1, provider: "anthropic", model: "claude-opus-5-5",
    status: 200, durationMs: 10, usageStatus: "unreported", ...fields,
  });
  const namespaced = normalizeUsageEntryForTest(row({
    wireModel: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", servedModel: "anthropic/claude-opus-5-5",
    requestedModel: "anthropic/claude-opus-5-5",
  }));
  expect(namespaced).not.toHaveProperty("servedModel");
  expect(namespaced.resolvedModel).toBe("claude-opus-5-5");

  // Before the wire model was recorded, the echo also leaked into resolvedModel.
  const beforeWireModel = normalizeUsageEntryForTest(row({
    resolvedModel: "anthropic/claude-opus-5-5", servedModel: "anthropic/claude-opus-5-5",
  }));
  expect(beforeWireModel).not.toHaveProperty("servedModel");
  expect(beforeWireModel).not.toHaveProperty("resolvedModel");

  const combo = normalizeUsageEntryForTest(row({
    provider: "combo", model: "mycombo", requestedModel: "mycombo", servedModel: "mycombo", wireModel: "claude-opus-5-5",
  }));
  expect(combo).not.toHaveProperty("servedModel");

  const genuine = normalizeUsageEntryForTest(row({ wireModel: "claude-opus-5-5", servedModel: "claude-opus-5-1" }));
  expect(genuine.servedModel).toBe("claude-opus-5-1");
});
