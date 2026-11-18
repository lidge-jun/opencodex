import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { markEgressTransparentExecutor } from "../../src/lib/provider-egress";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { createPhysicalSendReporter, createRequestExecutionBudget, deriveRequestExecutionBudget, isRequestExecutionBudget, requestHasCapturedSpendCeiling } from "../../src/lib/request-execution-budget";
import { configureSharedSpendLedger, createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY, sharedSpendLedger, sharedSpendPolicy, spendPolicyFromConfig, type SpendJournal, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";
import { SendBudgetExhaustedError, providerErrorDestinationLabel, fetchWithTransientRetry, type TransientSendBudget } from "../../src/lib/upstream-retry";
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

function unobservedHolder(kind: "legacy" | "observerless" | "foreign"): TransientSendBudget {
  if (kind === "legacy") return { used: 0 };
  const original = createRequestExecutionBudget();
  if (kind === "observerless") return original;
  const foreign = { ...original, get used() { return original.used; }, set used(value: number) { original.used = value; } };
  delete foreign.hasCapturedSpendCeiling;
  return foreign;
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

for (const limited of [false, true]) test(`an early optional-tool query captures policy without starting accounting (limited=${limited})`, () => {
  const identityPolicy = (enabled: boolean): SpendReservationPolicy => ({
    ...DEFAULT_SPEND_RESERVATION_POLICY, identity: enabled ? { maxTokens: 1_000_000 } : {},
  });
  const ledger = createSpendReservationLedger({ journal: memoryJournal(), salt: "early-optional-policy", policy: identityPolicy(limited) });
  const tracker = createRequestSpendTracker({ provider: "a", model: "m" }, undefined, ledger);
  const parent = createRequestExecutionBudget(undefined, undefined, tracker);
  const child = deriveRequestExecutionBudget(parent, parent.policy);
  const target = { poolId: "a", identityId: "selected-fixture-key" };
  for (const budget of [parent, child]) {
    expect(budget.hasCapturedSpendCeiling?.(target)).toBe(limited);
    expect(budget.spendPolicyStarted).toBe(false);
    expect(budget.spendAdmissionPolicy).toBeUndefined();
    expect(budget.physicalStarted).toBe(0);
    expect(budget.used).toBe(0);
    expect(ledger.snapshot("identity", target.identityId)).toBeUndefined();
  }
  ledger.reconfigure(identityPolicy(!limited));
  expect(child.hasCapturedSpendCeiling?.(target)).toBe(limited);
  // Only the real accounting admission chooses its mode, using the original policy.
  parent.startRequest?.(target);
  expect(parent.spendPolicyStarted).toBe(true);
  expect(parent.spendEnforced).toBe(limited);
  expect(parent.hasCapturedSpendCeiling?.(target)).toBe(limited);
  expect(parent.physicalStarted).toBe(0);
  expect(parent.used).toBe(0);
});

for (const limited of [false, true]) test(`optional-tool ceiling query retains captured identity policy without changing accounting (limited=${limited})`, () => {
  const previousPolicy = sharedSpendPolicy();
  const identityPolicy = (enabled: boolean): SpendReservationPolicy => ({
    ...DEFAULT_SPEND_RESERVATION_POLICY, identity: enabled ? { maxTokens: 1_000_000 } : {},
  });
  const ledger = createSpendReservationLedger({ journal: memoryJournal(), salt: "first-send-identity-policy", policy: identityPolicy(limited) });
  const log: RequestLogContext = { model: "m", provider: "a", spendPoolId: "a", spendOutputCeilingTokens: 64 };
  const tracker = createRequestSpendTracker(log, undefined, ledger);
  const parent = createRequestExecutionBudget(undefined, undefined, tracker);
  const booking = parent.reserveDispatch({ sendClass: "initial", targetKey: "a/m", countedExternally: true });
  if (!booking.allowed) throw new Error("fixture reservation refused");
  const translatorBudget = createTranslatorBudget();
  try {
    // A captured unlimited answer is authoritative even when shared configuration now limits it.
    configureSharedSpendLedger(spendPolicyFromConfig(limited ? {} : { identity: { maxTokens: 1 } }));
    const child = deriveRequestExecutionBudget(parent, parent.policy);
    const owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"), logCtx: log,
      options: { translatorBudget, sendBudget: child, comboInitialSend: { permit: booking.permit } } });
    if (owner instanceof Response) throw new Error("unexpected workflow refusal");
    const frozenAccountingPolicy = parent.spendAdmissionPolicy;
    expect(frozenAccountingPolicy).toEqual({ root: {}, identity: {}, pool: {} });
    expect(parent.spendEnforced).toBe(false); // The parent did not yet have an account.
    ledger.reconfigure(identityPolicy(!limited));
    const target = { poolId: "a", identityId: "selected-fixture-key" };
    expect(owner.hasCapturedSpendCeiling(target)).toBe(limited);
    for (const budget of [parent, child, owner.adapterDispatchBudget!]) {
      expect(budget.hasCapturedSpendCeiling?.(target)).toBe(limited);
      expect(budget.hasCapturedSpendCeiling?.({ poolId: "a" })).toBe(false);
      budget.startRequest?.(target);
      expect(budget.spendAdmissionPolicy).toBe(frozenAccountingPolicy);
      expect(budget.spendEnforced).toBe(false);
      expect(budget.physicalLimit).toBeUndefined();
      expect(budget.used).toBe(1);
    }
  } finally { booking.permit.release(); translatorBudget.dispose(); configureSharedSpendLedger(previousPolicy); }
  expect(parent.used).toBe(0);
});

for (const kind of ["legacy", "observerless", "foreign"] as const) for (const scope of ["root", "identity", "pool"] as const) for (const limited of [false, true]) {
  test(`${kind} holders share a lazy frozen ${scope} ceiling query without accounting (limited=${limited})`, () => {
    const previousPolicy = sharedSpendPolicy();
    const policy = (enabled: boolean) => spendPolicyFromConfig(enabled ? { [scope]: { maxTokens: 100_000 } } : {});
    const translatorBudget = createTranslatorBudget();
    const rootId = `${kind}-optional-${scope}-${limited}`;
    const req = new Request("http://localhost/v1/responses", { headers: { "x-codex-parent-thread-id": rootId } });
    const logs: RequestLogContext[] = [];
    const createOwner = (holder: TransientSendBudget) => {
      const log: RequestLogContext = { model: "m", provider: "" }; logs.push(log);
      const owner = createResponsesSendBudget({ req, logCtx: log, options: { translatorBudget, sendBudget: holder } });
      if (owner instanceof Response) throw new Error("unexpected workflow refusal");
      return owner;
    };
    const holder = unobservedHolder(kind); holder.used = 2;
    const target = { identityId: "selected-legacy-identity", poolId: "selected-legacy-pool" };
    try {
      configureSharedSpendLedger(policy(!limited));
      const child = isRequestExecutionBudget(holder) ? deriveRequestExecutionBudget(holder, holder.policy) : holder;
      const first = createOwner(holder), inherited = createOwner(child);
      // Construction does not capture a policy for optional work that may never be present.
      configureSharedSpendLedger(policy(limited));
      if (scope === "identity") expect(first.hasCapturedSpendCeiling({ poolId: target.poolId })).toBe(false);
      expect(first.hasCapturedSpendCeiling(target)).toBe(limited);
      configureSharedSpendLedger(policy(!limited));
      const laterChild = isRequestExecutionBudget(holder) ? deriveRequestExecutionBudget(holder, holder.policy) : holder;
      const later = createOwner(laterChild);
      for (const owner of [first, inherited, later]) {
        expect(owner.hasCapturedSpendCeiling(target)).toBe(limited);
        if (kind === "legacy") {
          expect(owner.adapterSendBudget).toBeUndefined();
          expect(owner.adapterDispatchBudget).toBeUndefined();
        } else {
          const view = owner.adapterDispatchBudget!;
          const derivedView = deriveRequestExecutionBudget(view, view.policy);
          for (const budget of [owner.adapterSendBudget!, view, owner.refundableAdapterDispatchBudget!, derivedView]) {
            expect(requestHasCapturedSpendCeiling(budget, { ...target, rootId })).toBe(limited);
            expect(budget.spendEnforced).toBe(false);
            expect(budget.spendPolicyStarted).toBe(false);
            expect(budget.spendAdmissionPolicy).toBeUndefined();
            expect(budget.physicalStarted).toBe(0);
            expect(budget.physicalLimit).toBeUndefined();
            expect(budget.used).toBe(2);
          }
        }
        expect(owner.sendsUsed).toBe(2);
        expect(owner.remainingTransientSendBudget(3)).toBe(1);
      }
      expect(createOwner(unobservedHolder(kind)).hasCapturedSpendCeiling(target)).toBe(!limited);
      expect(holder.used).toBe(2);
      if (kind === "legacy") expect(holder).toEqual({ used: 2 });
      expect(logs.every(log => log.spendTracker === undefined && log.accountLogLabel === undefined)).toBe(true);
      expect(sharedSpendLedger().snapshot("root", rootId)).toBeUndefined();
      expect(sharedSpendLedger().snapshot("identity", target.identityId)).toBeUndefined();
      expect(sharedSpendLedger().snapshot("pool", target.poolId)).toBeUndefined();
    } finally { configureSharedSpendLedger(previousPolicy); translatorBudget.dispose(); }
  });
}

for (const kind of ["legacy", "observerless", "foreign"] as const) test(`${kind} optional-work queries cannot invent a workflow root`, () => {
  const previousPolicy = sharedSpendPolicy(), translatorBudget = createTranslatorBudget();
  try {
    configureSharedSpendLedger(spendPolicyFromConfig({ root: { maxTokens: 1 } }));
    const owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"),
      logCtx: { provider: "a", model: "m" }, options: { translatorBudget, sendBudget: unobservedHolder(kind) } });
    if (owner instanceof Response) throw new Error("unexpected workflow refusal");
    expect(owner.hasCapturedSpendCeiling({ rootId: "untrusted-target-root", poolId: "a" })).toBe(false);
    expect(owner.sendsUsed).toBe(0);
  } finally { configureSharedSpendLedger(previousPolicy); translatorBudget.dispose(); }
});

for (const queried of [false, true]) for (const enforced of [false, true]) {
  test(`observer query authority is distinct from its answer (query=${queried}, enforced=${enforced})`, () => {
    const previousPolicy = sharedSpendPolicy(), translatorBudget = createTranslatorBudget();
    const effects: string[] = [];
    const parent = createRequestExecutionBudget(undefined, undefined, {
      enforced,
      ...(queried ? { hasCapturedSpendCeiling: () => false } : {}),
      startRequest: () => { effects.push("start"); },
      charge: () => { effects.push("charge"); return true; },
      refund: () => { effects.push("refund"); },
    });
    try {
      configureSharedSpendLedger(spendPolicyFromConfig(enforced ? {} : { identity: { maxTokens: 1 } }));
      const owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"), logCtx: { model: "m", provider: "a" },
        options: { translatorBudget, sendBudget: parent } });
      if (owner instanceof Response) throw new Error("unexpected workflow refusal");
      const target = { identityId: "authoritative-query-account", poolId: "a" };
      expect(owner.hasCapturedSpendCeiling(target)).toBe(!queried);
      for (const budget of [parent, deriveRequestExecutionBudget(parent, parent.policy), owner.adapterDispatchBudget!]) {
        expect(requestHasCapturedSpendCeiling(budget, target)).toBe(!queried);
        expect(budget.spendEnforced).toBe(enforced);
        expect(budget.spendPolicyStarted).toBe(false);
        expect(budget.spendAdmissionPolicy).toBeUndefined();
        expect(budget.physicalStarted).toBe(0);
        expect(budget.physicalLimit).toBeUndefined();
        expect(budget.used).toBe(0);
      }
      expect(effects).toEqual([]);
    } finally { configureSharedSpendLedger(previousPolicy); translatorBudget.dispose(); }
  });
}

for (const pinnedWire of [false, true]) for (const lane of ["main", "search", "named"] as const) for (const limited of ["first", "second", "neither"] as const) {
  test(`hosted Advisor follows captured target policy after key rotation (pinnedWire=${pinnedWire}, lane=${lane}, limited=${limited})`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("rotation fixture forbids uninjected network calls"); }) as typeof fetch;
    const firstKey = "fixture-advisor-first", secondKey = "fixture-advisor-second";
    const providerName = pinnedWire ? "commandcode" : "anth";
    const baseUrl = pinnedWire ? "https://api.commandcode.ai/provider/v1" : "https://api.anthropic.com";
    const labels = [firstKey, secondKey].map((reference, index) => apiKeyAccountLogLabel(providerName, { reference, entryId: String(index) })!);
    const queried: string[] = [];
    const budget = createRequestExecutionBudget(undefined, undefined, {
      hasCapturedSpendCeiling(target) {
        expect(target?.poolId).toBe(providerName);
        expect(target?.identityId).toBeDefined();
        queried.push(target!.identityId!);
        return target!.identityId === labels[limited === "first" ? 0 : limited === "second" ? 1 : -1];
      },
      charge: () => true, refund: () => {},
    });
    const wires: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const model = "claude-sonnet-4-6";
    const fetch = markEgressTransparentExecutor((async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}${pinnedWire ? "" : "/v1"}/messages`);
      const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
      wires.push({ body, headers });
      if (wires.length === 1) return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture refusal" } }, { status: 429 });
      const frames = [
        { type: "message_start", message: { id: "msg_rotation", type: "message", role: "assistant", model,
          content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        ...(lane === "named" && limited !== "neither" ? [
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_rotated_read", name: "Read", input: {} } },
          { type: "content_block_stop", index: 1 },
        ] : []),
        { type: "message_delta", delta: { stop_reason: lane === "named" && limited !== "neither" ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch);
    const config = { port: 0, defaultProvider: providerName,
      webSearchSidecar: { enabled: lane === "search", backend: "exa", exaApiKey: "fixture-never-executed" },
      providers: { [providerName]: { adapter: pinnedWire ? "openai-chat" : "anthropic", baseUrl, authMode: "key", proxy: "direct",
        // Command Code defaults to patient same-key retries; exercise its key replacement here.
        ...(pinnedWire ? { forwardAdvisorTool: true, retryOn429: { enabled: false } } : {}),
        apiKey: firstKey, apiKeyPool: [{ id: "0", key: firstKey }, { id: "1", key: secondKey }], liveModels: false, models: [model], fetch } },
    } as unknown as OcxConfig;
    saveConfig(config);
    const log: RequestLogContext = { provider: "", model: "" };
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${providerName}/${model}`, stream: true,
          input: [{ role: "assistant", content: "Earlier answer." }, { role: "user", content: "Continue." }],
          tools: [{ type: "function", name: "Read", parameters: { type: "object", properties: {} } },
            ...(lane === "search" ? [{ type: "web_search" }] : [])],
          ...(lane === "named" ? { tool_choice: { type: "function", name: "advisor" } } : {}) }),
      }), config, log, { inboundWire: "anthropic", sendBudget: budget,
        anthropicServerTools: [{ type: "advisor_20260301", name: "advisor", model, max_uses: 2 }],
        anthropicServerReplay: new Map([["text:Earlier answer.", [
          { type: "server_tool_use", id: "srvtoolu_rotation", name: "advisor", input: {} },
          { type: "advisor_tool_result", tool_use_id: "srvtoolu_rotation", content: { type: "advisor_result", text: "prior advice" } },
        ]]]),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain("ok");
      expect(wires.map(wire => wire.headers.get("x-api-key"))).toEqual([firstKey, secondKey]);
      for (const [index, wire] of wires.entries()) {
        const allowed = limited === "neither" || (limited === "second" && index === 0);
        expect((wire.body.tools as Record<string, unknown>[]).some(tool => tool.type === "advisor_20260301")).toBe(allowed);
        expect((wire.headers.get("anthropic-beta") ?? "").includes("advisor-tool-2026-03-01")).toBe(allowed);
        if (!allowed) expect(JSON.stringify(wire.body)).not.toContain("srvtoolu_rotation");
        expect(JSON.stringify(wire.body)).toContain("Earlier answer.");
        if (lane === "named") expect(wire.body.tool_choice).toEqual(allowed ? { type: "tool", name: "advisor" } : { type: "auto" });
      }
      if (limited === "second") expect(queried).toContain(labels[1]!);
      if (lane === "named" && limited !== "neither") expect(body).toContain('"name":"Read"');
      // Optional hosted work never changes this externally supplied owner's accounting mode.
      expect(budget.spendEnforced).toBe(false);
      expect(budget.spendAdmissionPolicy).toBeUndefined();
      expect(log.spendTracker).toBeUndefined();
    } finally { globalThis.fetch = originalFetch; }
  });
}

for (const kind of ["legacy", "observerless", "derived"] as const) for (const scope of [undefined, "root", "identity", "pool"] as const) {
  test(`a ${kind} holder withholds only spend-limited hosted work at the injected wire (scope=${scope ?? "none"})`, async () => {
    const previousPolicy = sharedSpendPolicy();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("legacy-holder fixture forbids uninjected network calls"); }) as typeof fetch;
    const wires: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const model = "claude-opus-5-5";
    const parent = unobservedHolder(kind === "derived" ? "observerless" : kind);
    const holder = kind === "derived" && isRequestExecutionBudget(parent) ? deriveRequestExecutionBudget(parent, parent.policy) : parent;
    const config = {
      port: 0, defaultProvider: "anth", spend: scope ? { [scope]: { maxTokens: 1 } } : {},
      webSearchSidecar: { enabled: false },
      providers: { anth: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key",
        apiKey: "fixture-legacy-holder-key", liveModels: false, models: [model],
        fetch: async (_input: unknown, init?: RequestInit) => {
          wires.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
          const frames = [
            { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model,
              content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ];
          return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } });
        } } },
    } as unknown as OcxConfig;
    configureSharedSpendLedger(spendPolicyFromConfig(config.spend));
    const log: RequestLogContext = { provider: "", model: "" };
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": `${kind}-wire-${scope ?? "none"}` },
        body: JSON.stringify({ model: `anth/${model}`, stream: true, input: "Synthetic optional-tool check.",
          tools: [{ type: "function", name: "Read", parameters: { type: "object", properties: {} } }] }),
      }), config, log, {
        inboundWire: "anthropic", sendBudget: holder,
        anthropicServerTools: [{ type: "advisor_20260301", name: "advisor", model: "claude-opus-4-8", max_uses: 2 }],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("ok");
      expect(wires).toHaveLength(1);
      const types = (wires[0]!.body.tools as Record<string, unknown>[]).map(tool => tool.type ?? "function");
      expect(types).toEqual(scope ? ["function"] : ["function", "advisor_20260301"]);
      expect((wires[0]!.headers.get("anthropic-beta") ?? "").includes("advisor-tool-2026-03-01")).toBe(scope === undefined);
      // This compatibility holder retains its original receipt/accounting behavior.
      expect(holder.used).toBe(1);
      expect(parent.used).toBe(1);
      expect(log.spendTracker).toBeUndefined();
    } finally { globalThis.fetch = originalFetch; configureSharedSpendLedger(previousPolicy); }
  });
}

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
  await expect(fetchWithTransientRetry(async () => { throw new SendBudgetExhaustedError(providerErrorDestinationLabel("fixture")); },
    { attempts: 1, onSendsConsumed: report })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(f.budget.physicalStarted).toBe(1);
  expect(f.budget.used).toBe(1);
  booking.permit.release(); // The booking was consumed by the started send: nothing to refund.
  expect(f.budget.used).toBe(1);
});
