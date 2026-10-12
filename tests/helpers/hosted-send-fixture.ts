import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

// providerFetch supports executor injection; persisted provider configuration does not expose it.
type SyntheticConfig = Omit<OcxConfig, "providers"> & { providers: Record<string, OcxProviderConfig & { fetch?: typeof fetch }> };
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses/core";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../src/lib/request-execution-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { sharedSpendLedger, resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";
import { spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import { expect } from "bun:test";
import { acquireOwnedSpendHome } from "./owned-spend-home";
import { installIsolatedCodexHome } from "./isolated-codex-home";
import { removeTreeWithRetry } from "./remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { chatStream } from "./combo-failover-upstream";

export type HostedKind = "search" | "image" | "video";
/** Isolate hosted inference and restore all state before asserting owner release. */
export async function hostedSendFixture(kind: HostedKind, strategy: "failover" | "jev", run: (f: ReturnType<typeof createFixture>) => Promise<void>, policy?: RequestExecutionBudgetPolicy) {
  const prior = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "hosted-send-"));
  process.env.OPENCODEX_HOME = home;
  const codex = installIsolatedCodexHome("hosted-send-codex-");
  const release = acquireOwnedSpendHome();
  try {
    clearComboSelectionState(); clearComboTargetCooldowns();
    await run(createFixture(kind, strategy, policy));
  } finally {
    let ownership: ReturnType<typeof spendLedgerOwnerSnapshot>["ownership"] | undefined;
    try {
      release(); ownership = spendLedgerOwnerSnapshot().ownership;
      closeRequestHistoryIndex(); await flushResponseState(); clearResponseStateForTests();
    } finally {
      clearComboSelectionState(); clearComboTargetCooldowns(); codex.restore();
      if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
      removeTreeWithRetry(home);
    }
    expect(ownership).toBe("unheld");
  }
}
/** Build synthetic Combo dispatch with observable physical sends and durable spend settlement. */
function createFixture(kind: HostedKind, strategy: "failover" | "jev", policy?: RequestExecutionBudgetPolicy) {
  let inference = 0, judge = 0, charges = 0, refunds = 0;
  const bodies: Record<string, unknown>[] = [];
  const config: SyntheticConfig = { port: 0, defaultProvider: "a", providers: {
    a: { adapter: "openai-chat", baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-key", authMode: "key", liveModels: false,
      models: ["m"], reasoningEfforts: ["low", "high"], transientRetryOn5xx: { attempts: 1 },
      fetch: (async (_input: unknown, init?: RequestInit) => {
        inference++; bodies.push(JSON.parse(String(init?.body))); return chatStream("hosted route final answer");
      }) as unknown as typeof fetch },
    jev: { adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", apiKey: "synthetic-judge-key", liveModels: false,
      fetch: (async () => { judge++; return Response.json({ answers: { route: { choice: "a/m:low" } } }); }) as unknown as typeof fetch },
    xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "synthetic-unused-key", authMode: "key", liveModels: false,
      fetch: (async () => { throw new Error("Synthetic test must not execute a media service"); }) as unknown as typeof fetch },
  }, combos: { auto: { strategy, targets: [{ provider: "a", model: "m" }] } },
    ...(kind === "search" ? { webSearchSidecar: { backend: "exa" as const, exaApiKey: "synthetic-unused-key" } }
      : { images: kind === "image" ? { bridgeEnabled: true } : { videoBridgeEnabled: true } }) };
  const log: RequestLogContext = { model: "", provider: "a", spendInputEstimateTokens: 2, spendOutputCeilingTokens: 1 };
  const tracker = createRequestSpendTracker(log, "hosted-send-root");
  const budget = createRequestExecutionBudget(policy, undefined, {
    charge: options => { charges++; return tracker.charge(options); },
    refund: () => { refunds++; tracker.refund(); },
  });
  const request = (signal?: AbortSignal) => new Request("http://localhost/v1/responses", { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "combo/auto", input: "Synthetic assignment", stream: true,
      ...(kind === "video" ? {} : { tools: [{ type: kind === "search" ? "web_search" : "image_generation" }] }) }) });
  return { config, budget, log, bodies, request,
    async dispatch(signal?: AbortSignal) { const req = request(signal); return handleResponses(req, config, log, { sendBudget: budget, abortSignal: req.signal }); },
    async dispatchChild(signal?: AbortSignal) {
      const booking = budget.reserveDispatch({ sendClass: "initial", targetKey: "a/m", countedExternally: true });
      if (!booking.allowed) throw new Error("fixture initial booking denied");
      const req = request(signal);
      const body = await req.json() as Record<string, unknown>;
      body.model = "a/m";
      const child = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal });
      return handleResponses(child, config, log, { sendBudget: budget, abortSignal: child.signal,
        comboAttempt: true, comboInitialSend: { permit: booking.permit } });
    },
    settle() {
      tracker.settle({ inputTokens: 2, outputTokens: 1 });
      const snapshot = sharedSpendLedger().snapshot("root", "hosted-send-root");
      resetSharedSpendLedgerForTest(); // Prove settlement by replaying the durable journal, not only memory.
      expect(sharedSpendLedger().snapshot("root", "hosted-send-root")).toEqual(snapshot);
      return snapshot;
    },
    get inference() { return inference; }, get judge() { return judge; }, get charges() { return charges; }, get refunds() { return refunds; },
  };
}
