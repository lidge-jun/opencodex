import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { JevStatsPanel } from "../src/components/jev-stats-panel";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let testWindow: Window;
let root: Root | null;

const response = {
  range: "30d",
  comboId: "jev-auto",
  since: 0,
  generatedAt: 1,
  summary: {
    decisions: 3,
    appliedDecisions: 2,
    failOpenDecisions: 1,
    successfulRequests: 3,
    requestsWithModelFallback: 1,
    modelAttempts: 4,
    measuredModelAttempts: 3,
    modelInputTokens: 1_000,
    modelOutputTokens: 200,
    modelReasoningTokens: 40,
    modelCacheReadTokens: 300,
    modelCacheWriteTokens: 20,
    modelTotalTokens: 1_200,
    decisionUsageReported: 2,
    decisionInputTokens: 30,
    decisionOutputTokens: 5,
    decisionTotalTokens: 35,
    averageLatencyMs: 120,
    averageConfidence: 0.8,
    averageChosenProbability: 0.6,
  },
  gates: [{ gate: "apply", decisions: 2 }, { gate: "timeout", decisions: 1 }],
  models: [{
    provider: "openai",
    model: "gpt-6-astra",
    overflow: false,
    picks: 2,
    appliedPicks: 2,
    failOpenPicks: 0,
    attempts: 3,
    measuredAttempts: 3,
    inputTokens: 1_000,
    outputTokens: 200,
    reasoningTokens: 40,
    cacheReadTokens: 300,
    cacheWriteTokens: 20,
    totalTokens: 1_200,
    efforts: [{ effort: "high", picks: 2 }],
  }, {
    provider: "",
    model: "",
    overflow: true,
    picks: 1,
    appliedPicks: 1,
    failOpenPicks: 0,
    attempts: 1,
    measuredAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    efforts: [{ effort: "medium", picks: 1 }],
  }],
  historyTruncated: false,
  truncatedPrefixBytes: 0,
  entriesTruncated: false,
  entriesDropped: 0,
  snapshotWindowStart: 0,
  snapshotWindowEnd: 1,
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#models/combos" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  clearClientResourceStoresForTests();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(rounds = 4) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
}

test("JEV stats shows picks, model tokens and separately labelled decision tokens", async () => {
  const requests: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      requests.push(String(input));
      const url = new URL(String(input), "http://localhost");
      return Response.json({ ...response, range: url.searchParams.get("range") });
    },
  });
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <JevStatsPanel apiBase="" comboId="jev-auto" active />
      </LanguageProvider>,
    );
  });
  await flush();

  expect(requests[0]).toContain("/api/usage?jev=1&comboId=jev-auto&range=30d");
  expect(host.textContent).toContain("Decisions");
  expect(host.textContent).toContain("Model tokens");
  expect(host.textContent).toContain("JEV decision tokens");
  expect(host.textContent).toContain("gpt-6-astra");
  expect(host.textContent).toContain("Other models");
  expect(host.textContent).toContain("high × 2");
  expect(host.textContent).toContain("1200");
  expect(host.textContent).toContain("1 model fallback");

  const sevenDays = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "7d")!;
  await act(async () => { sevenDays.click(); });
  await flush();
  expect(requests.some(url => url.includes("range=7d"))).toBeTrue();
});

test("JEV stats renders the fail-open summary in Simplified Chinese", async () => {
  localStorage.setItem("ocx-lang", "zh");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json(response),
  });
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <JevStatsPanel apiBase="" comboId="jev-auto" active />
      </LanguageProvider>,
    );
  });
  await flush();

  expect(host.textContent).toContain("已应用 2 · 故障开放 1");
  expect(host.textContent).not.toContain("Fail-open");
});
