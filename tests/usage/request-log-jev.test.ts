import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addFinalRequestLog,
  clearRequestLogsForTests,
  getRequestLogEntries,
  hydrateRequestLogsFromDisk,
} from "../../src/server/request-log";
import { readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("JEV decision telemetry survives finalization, disk persistence and hydration", () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-jev-log-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
  try {
    addFinalRequestLog("jev-final", 1, {
      model: "gpt-6-astra",
      provider: "openai",
      requestedModel: "jev-auto",
      comboId: "jev-auto",
      jevDecision: {
        version: 1,
        comboId: "jev-auto",
        selected: { provider: "openai", model: "gpt-6-astra", effort: "high" },
        gate: "apply",
        latencyMs: 24,
        confidence: 0.8,
        chosenProbability: 0.7,
        usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    }, 200);

    const expected = {
      version: 1,
      comboId: "jev-auto",
      selected: { provider: "openai", model: "gpt-6-astra", effort: "high" },
      gate: "apply",
      latencyMs: 24,
      confidence: 0.8,
      chosenProbability: 0.7,
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
    } as const;
    expect(readUsageEntries()[0]?.jevDecision).toEqual(expected);
    clearRequestLogsForTests();
    expect(hydrateRequestLogsFromDisk()).toBe(1);
    expect(getRequestLogEntries()[0]?.jevDecision).toEqual(expected);
  } finally {
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});
