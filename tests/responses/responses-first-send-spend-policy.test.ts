import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { createPhysicalSendReporter, createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY, type SpendJournal, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";
import { SendBudgetExhaustedError, fetchWithTransientRetry } from "../../src/lib/upstream-retry";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { responsesSuccess } from "../helpers/combo-failover-upstream";

/**
 * A Combo child decides once per request whether its prepaid first send is settled by the
 * physical-dispatch receipt (spend enforcement inactive) or by the shared physical-send
 * reporter (enforcement active). These pin what that decision relies on.
 */
let home: string, prior: string | undefined, codex: IsolatedCodexHome, release: () => void;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "first-send-spend-policy-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("first-send-spend-policy-codex-");
  release = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns();
});
afterEach(async () => {
  release();
  for (const server of servers.splice(0)) await server.stop(true);
  closeRequestHistoryIndex(); await flushResponseState(); clearResponseStateForTests();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  if (prior === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prior;
  codex.restore(); removeTreeWithRetry(home);
});

const memoryJournal = (): SpendJournal => {
  const lines: string[] = [];
  return { read: () => [...lines], append: line => { lines.push(line); }, rewrite: next => { lines.splice(0, lines.length, ...next); } };
};
const policyWith = (poolMaxTokens: number | undefined): SpendReservationPolicy => ({
  ...DEFAULT_SPEND_RESERVATION_POLICY, pool: poolMaxTokens === undefined ? {} : { maxTokens: poolMaxTokens },
});
/** A real tracker over an injected ledger, so enforcement follows the ledger's live policy. */
function trackerFixture(enforced: boolean) {
  const ledger = createSpendReservationLedger({ journal: memoryJournal(), salt: "first-send-policy", policy: policyWith(enforced ? 1_000_000 : undefined) });
  const log: RequestLogContext = { model: "m", provider: "a", spendPoolId: "a", usageLogInputTokens: 10, spendOutputCeilingTokens: 0 };
  const tracker = createRequestSpendTracker(log, undefined, ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  return { ledger, log, tracker, budget };
}

for (const enforced of [false, true]) test(`receipt-versus-reporter choice is fixed by the Combo booking (enforced=${enforced})`, () => {
  const f = trackerFixture(enforced);
  const translatorBudget = createTranslatorBudget();
  try {
    expect(f.tracker.policyStarted).toBe(false);
    const booking = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "a/m", countedExternally: true });
    if (!booking.allowed) throw new Error("fixture reservation refused");
    // The booking itself starts the spend policy; a child holding its permit never sees it unstarted.
    expect(f.tracker.policyStarted).toBe(true);
    const owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"), logCtx: f.log,
      options: { translatorBudget, sendBudget: f.budget, comboInitialSend: { permit: booking.permit } } });
    if (owner instanceof Response) throw new Error("unexpected workflow refusal");
    expect(owner.adapterSendBudget?.spendEnforced).toBe(enforced);
    // Neither a later ceiling change nor a later account/pool label can flip this request's mode,
    // so the once-per-request receiptMode in the dispatch owners cannot disagree with dispatch.
    f.ledger.reconfigure(policyWith(enforced ? undefined : 1_000_000));
    f.log.spendPoolId = "other-pool"; f.log.accountLogLabel = "other-account";
    expect(owner.adapterSendBudget?.spendEnforced).toBe(enforced);
    expect(f.budget.spendEnforced).toBe(enforced);
    booking.permit.release();
  } finally { translatorBudget.dispose(); }
});

/** Combo -> Responses passthrough upstream, observing whether the policy had started at the wire. */
for (const enforced of [false, true]) test(`passthrough Combo send starts spend policy from its booking before the wire (enforced=${enforced})`, async () => {
  const f = trackerFixture(enforced);
  const startedAtWire: boolean[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await req.json();
    startedAtWire.push(f.tracker.policyStarted);
    return Response.json(responsesSuccess("fixture answer", "m"));
  } });
  servers.push(server);
  const config: OcxConfig = { port: 0, defaultProvider: "a", providers: { a: {
    adapter: "openai-responses", baseUrl: new URL("/v1", server.url).href, allowPrivateNetwork: true,
    apiKey: "fixture-inference-key", authMode: "key", liveModels: false, models: ["m"], transientRetryOn5xx: { attempts: 1 } } },
    combos: { auto: { strategy: "failover", targets: [{ provider: "a", model: "m" }] } } };
  f.log.model = ""; f.log.provider = "";
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/auto", input: "Synthetic spend policy task.", stream: false }) });
  expect(f.tracker.policyStarted).toBe(false);
  const response = await handleResponses(req, config, f.log, { sendBudget: f.budget, abortSignal: req.signal });
  expect(response.status).toBe(200); await response.text();
  expect(startedAtWire).toEqual([true]);
  expect(f.tracker.spendAdmissionPolicy).toBeDefined();
  expect(f.budget.spendEnforced).toBe(enforced);
  expect(f.budget.used).toBe(1);
}, 10_000);

test("enforced spend counts a local refusal after beforeSend as one started send", async () => {
  // Same accounting #6763's native Chat path has: `beforeSend` claims the send, and the retry
  // helper reports it in `finally` whatever the send did, including a local refusal.
  const f = trackerFixture(true);
  const booking = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "a/m", countedExternally: true });
  if (!booking.allowed) throw new Error("fixture reservation refused");
  const report = createPhysicalSendReporter(f.budget, () => ({ poolId: "a" }), booking.permit);
  await expect(fetchWithTransientRetry(async () => { throw new SendBudgetExhaustedError("fixture"); },
    { attempts: 1, onSendsConsumed: report })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(f.budget.physicalStarted).toBe(1);
  expect(f.budget.used).toBe(1);
  booking.permit.release(); // The booking was consumed by the started send: nothing to refund.
  expect(f.budget.used).toBe(1);
});
