import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  createRequestExecutionBudget,
  deriveRequestExecutionBudget,
  type RequestExecutionBudget,
  type SendClass,
} from "../../src/lib/request-execution-budget";
import { authorizeResendForRecovery, type ResendDecision } from "../../src/lib/request-resend-gate";
import type { RequestFailureStage } from "../../src/lib/request-failure-model";
import {
  fetchWithResetRetry,
  isNonReplayableResponse,
  refetchAfterProtocolSafeReset,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
} from "../../src/lib/upstream-retry";
import { ambiguousResendAllowanceFor } from "../../src/server/responses/reset-replay";
import { resetReplayPolicyFor } from "../../src/providers/key-failover";
import { repoPath } from "../helpers/repo-root";
import type { OcxProviderConfig } from "../../src/types";

/*
 * Holds INV-RESEND-02 from structure/overview.md across a COMPOSITION of legs.
 *
 * tests/lib/ambiguous-resend-gate.test.ts asks the gate one question at a time and
 * tests/lib/execution-budget-permits.test.ts asks the budget one claim at a time. Neither can
 * see what this file is about: a request that reaches upstream through five layers, where
 * every layer is correct on its own and the request as a whole still duplicates a turn.
 */

type ProviderRow = Pick<OcxProviderConfig, "retryOnReset">;

/** The bare opt-in, and whatever one of it means to the operator today. */
const OPTED_IN: ProviderRow = { retryOnReset: {} };
const GRANT = resetReplayPolicyFor(OPTED_IN)?.replacements ?? 0;
/**
 * A row an operator tuned above the bare opt-in. Derived rather than written as a number: what
 * matters is that it grants MORE than the row this request started on, not that it grants two.
 */
const MORE_PERMISSIVE: ProviderRow = { retryOnReset: { replacements: GRANT + 1 } };

function reset(): Error {
  const err = new Error("The socket connection was closed unexpectedly.");
  (err as Error & { code: string }).code = "ECONNRESET";
  return err;
}

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}
afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

/**
 * One logical request, watched through the two numbers that have to be watched apart.
 *
 * `physicalSends` is every send that left this proxy. `ambiguousSends` is the subset that carried a
 * turn the origin may already have run -- the number an operator consents to when they set
 * `retryOnReset`, and the only one that counts duplicate inferences. A composition can hold the
 * first bound and break the second: four sends is within budget whether one of them replaces a
 * possibly-executed turn or three of them do.
 */
function oneLogicalRequest() {
  const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
  const counts = { physical: 0, ambiguous: 0 };

  /** Every leg asks the gate, and the gate is what tells us the send duplicates a turn. */
  const authorize = (stage: RequestFailureStage, row: ProviderRow): ResendDecision => {
    const decision = authorizeResendForRecovery(
      stage,
      "connection-reset",
      // The allowance a leg builds from the provider row it is CURRENTLY running against,
      // which rotation, refresh, transport resolution and a combo target each reassign.
      ambiguousResendAllowanceFor(row, () => true, limit => budget.claimAmbiguousResend?.(limit) === true),
    );
    if (decision.allowed && decision.spentOperatorAllowance) counts.ambiguous += 1;
    return decision;
  };

  const dispatcher = (outcomes: Array<Response | Error>) => {
    let index = 0;
    return async (): Promise<Response> => {
      counts.physical += 1;
      const next = outcomes[index] ?? outcomes[outcomes.length - 1];
      index += 1;
      if (next instanceof Error) throw next;
      return next ?? new Response("answer");
    };
  };

  /**
   * What src/server/responses/request-send-budget.ts hands a recovery leg: the base allowance
   * while it lasts, then the single final-recovery reserve, and nothing after that.
   */
  const recoveryAttempts = (sendClass: SendClass, targetKey: string): number => {
    const base = budget.remainingBaseSends(TRANSIENT_RETRY_MAX_ATTEMPTS);
    if (base > 0) return base;
    const decision = budget.reserveDispatch({ sendClass, targetKey, countedExternally: true });
    return decision.allowed ? 1 : 0;
  };

  return {
    budget,
    get physicalSends(): number { return counts.physical; },
    get ambiguousSends(): number { return counts.ambiguous; },
    recoveryAttempts,
    /** A leg that fails before any response head, through the real reset ladder. */
    preHeader: (outcomes: Array<Response | Error>, row: ProviderRow, attempts?: number): Promise<Response> =>
      fetchWithResetRetry(dispatcher(outcomes), {
        attempts: attempts ?? budget.remainingBaseSends(TRANSIENT_RETRY_MAX_ATTEMPTS),
        onSendsConsumed: sends => { budget.used += sends; },
        claimAmbiguousResend: () => authorize("pre-header", row).allowed,
      }),
    /** A stream that died after the head while carrying only control events. */
    postHeader: (outcomes: Array<Response | Error>, row: ProviderRow): Promise<Response | null> => {
      const send = dispatcher(outcomes);
      return refetchAfterProtocolSafeReset(
        async () => { const response = await send(); budget.used += 1; return response; },
        reset(),
        {
          attempts: budget.remainingBaseSends(TRANSIENT_RETRY_MAX_ATTEMPTS),
          authorize: () => authorize("protocol-prelude", row).allowed,
        },
      );
    },
  };
}

describe("one resend budget across composed recovery legs", () => {
  test("the whole chain spends the grant once, whatever each leg was separately entitled to", async () => {
    silenceWarn();
    const request = oneLogicalRequest();

    // 1. The first send dies before any head. The operator's replacement is spent here, and
    //    the replacement answers.
    const first = await request.preHeader([reset(), new Response("first answer")], OPTED_IN);
    expect(await first.text()).toBe("first answer");
    expect(request.physicalSends).toBe(2);
    expect(request.ambiguousSends).toBe(GRANT);

    // 2. That stream then dies after the head with only control events on it -- the other side
    //    of the same question. Nothing was observed, so this stage would be entitled to a
    //    replacement of its own; the request has none left, and no send leaves.
    const secondChance = await request.postHeader([new Response("second answer")], OPTED_IN);
    expect(secondChance).toBeNull();
    expect(request.physicalSends).toBe(2);

    // 3. A combo candidate derives its own scope, with its own reserve and target ledgers. The
    //    grant is not one of them, at either row's ceiling.
    const comboChild = deriveRequestExecutionBudget(request.budget, CODEX_TEXT_GUARDED_BUDGET_POLICY);
    expect(comboChild.claimAmbiguousResend?.(GRANT)).toBe(false);
    expect(comboChild.claimAmbiguousResend?.(MORE_PERMISSIVE.retryOnReset?.replacements ?? 0)).toBe(false);

    // 4. A credential refresh replays the turn on a new token and resets before the head. The
    //    leg settles as the refusal rather than sending again, and the client is handed a
    //    response no retry policy will replay.
    const afterRefresh = await request.preHeader([reset(), new Response("duplicate")], OPTED_IN);
    expect(isNonReplayableResponse(afterRefresh)).toBe(true);
    expect(request.physicalSends).toBe(3);

    // 5. The 429 leg finds the base allowance gone. The grant is never consulted, which is the
    //    ordering that keeps a spent send budget from draining it.
    expect(request.budget.remainingBaseSends(TRANSIENT_RETRY_MAX_ATTEMPTS)).toBe(0);

    // 6. The last send this request is entitled to is the single final-recovery reserve, and
    //    the account it moves to is a row the operator tuned HIGHER. A ceiling read from the
    //    asking leg let that row buy a second duplicate inference on the way out; the ceiling
    //    is the smallest any leg presented, so it buys nothing.
    const attempts = request.recoveryAttempts("account-failover", "other-account");
    expect(attempts).toBe(1);
    const lastSend = await request.preHeader([reset(), new Response("duplicate")], MORE_PERMISSIVE, attempts);
    expect(isNonReplayableResponse(lastSend)).toBe(true);

    expect(request.ambiguousSends).toBe(GRANT);
    expect(request.physicalSends).toBe(CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTotalModelSends);
    // The two numbers describe the same sends, so the request's own ledger has to agree with
    // what the transport actually dispatched. A leg that books a send it never made, or makes
    // one it never booked, shows up here rather than as a ceiling that quietly stopped firing.
    expect(request.budget.used).toBe(request.physicalSends);
  });

  test("a later leg on a more permissive row cannot raise this request's ceiling", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const strict = resetReplayPolicyFor(OPTED_IN)?.replacements ?? 0;
    const permissive = resetReplayPolicyFor(MORE_PERMISSIVE)?.replacements ?? 0;
    expect(permissive).toBeGreaterThan(strict);

    // A leg that cannot state a grant refuses on its own terms and does not narrow the
    // request either: a malformed ceiling must not cancel what an opted-in row really gave.
    expect(budget.claimAmbiguousResend?.(0)).toBe(false);

    for (let spent = 0; spent < strict; spent += 1) {
      expect(budget.claimAmbiguousResend?.(strict)).toBe(true);
    }
    // route.provider is reassigned by rotation, refresh and transport resolution, so the row a
    // leg reads its ceiling from is not necessarily the row the request started on.
    expect(budget.claimAmbiguousResend?.(permissive)).toBe(false);
  });

  test("a request that starts permissive is still held to the strictest row that asks", () => {
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const strict = resetReplayPolicyFor(OPTED_IN)?.replacements ?? 0;
    const permissive = resetReplayPolicyFor(MORE_PERMISSIVE)?.replacements ?? 0;

    for (let spent = 0; spent < strict; spent += 1) {
      expect(budget.claimAmbiguousResend?.(permissive)).toBe(true);
    }
    // The permissive row had more to give, and the strict row is what this request is held to
    // from the moment it asks -- the direction the pre-existing ordering already failed closed.
    expect(budget.claimAmbiguousResend?.(strict)).toBe(false);
    expect(budget.claimAmbiguousResend?.(permissive)).toBe(false);
  });

  test("a scope derived from a budget this factory did not build shares the request's grant", () => {
    // The bridge exists because `isRequestExecutionBudget` is a shape test: a hand-built view
    // reaches derivation, and refusing it would turn a routing request into a 500. What it may
    // not do is hand that request a second grant -- `claimAmbiguousResend` is public on the
    // parent, so unlike a pending booking there is nothing private stopping it being asked.
    const owner = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const view: RequestExecutionBudget = {
      get used(): number { return owner.used; },
      set used(next: number) { owner.used = next; },
      logicalRequestId: owner.logicalRequestId,
      policyVersion: owner.policyVersion,
      policy: owner.policy,
      get reserveSpent(): boolean { return owner.reserveSpent; },
      get alternateTargetSends(): number { return owner.alternateTargetSends; },
      get targetTransitions(): number { return owner.targetTransitions; },
      get lastTargetKey(): string | undefined { return owner.lastTargetKey; },
      remainingBaseSends: (cap: number): number => owner.remainingBaseSends(cap),
      claimAmbiguousResend: (limit: number): boolean => owner.claimAmbiguousResend?.(limit) === true,
      reserveDispatch: intent => owner.reserveDispatch(intent),
    };

    const first = deriveRequestExecutionBudget(view, CODEX_TEXT_GUARDED_BUDGET_POLICY);
    const second = deriveRequestExecutionBudget(view, CODEX_TEXT_GUARDED_BUDGET_POLICY);
    expect(first.claimAmbiguousResend?.(GRANT)).toBe(true);
    expect(second.claimAmbiguousResend?.(GRANT)).toBe(false);
    expect(view.claimAmbiguousResend?.(GRANT)).toBe(false);
    expect(owner.claimAmbiguousResend?.(GRANT)).toBe(false);
  });

  test("a parent that grants nothing cannot be bridged into a grant", () => {
    const stub: RequestExecutionBudget = {
      used: 0,
      logicalRequestId: "stub",
      policyVersion: "stub",
      policy: CODEX_TEXT_GUARDED_BUDGET_POLICY,
      reserveSpent: false,
      alternateTargetSends: 0,
      targetTransitions: 0,
      lastTargetKey: undefined,
      remainingBaseSends: () => 0,
      reserveDispatch: () => ({ allowed: false, reason: "total-exhausted" }),
    };
    // Fail closed: a budget that predates the grant has no operator override to share, and an
    // unknown upstream state is not made replayable by the scope that asked.
    expect(deriveRequestExecutionBudget(stub, CODEX_TEXT_GUARDED_BUDGET_POLICY).claimAmbiguousResend?.(GRANT))
      .toBe(false);
  });

  test("every post-header replacement in the tree is authorized before it sends", async () => {
    // `authorize` is optional on the helper, so this is the property that keeps a call site from
    // becoming a resend of a possibly-executed turn that no gate ever weighed. Scanned rather
    // than listed: the hazard is the call site nobody remembered to add to a list.
    const srcDir = repoPath("src");
    const unauthorized: string[] = [];
    let callSites = 0;
    for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: srcDir })) {
      const source = readFileSync(join(srcDir, relative), "utf8");
      for (const match of source.matchAll(/refetchAfterProtocolSafeReset\(/g)) {
        const start = match.index ?? 0;
        // The declaration itself is not a call site, and the import names it without one.
        if (/\bfunction\s+$/.test(source.slice(Math.max(0, start - 24), start))) continue;
        callSites += 1;
        // The options object is the last argument of the call, so the window has to cover the
        // whole call expression; these are long ones.
        if (!source.slice(start, start + 8000).includes("authorize:")) {
          unauthorized.push(relative + ":" + (source.slice(0, start).split("\n").length));
        }
      }
    }
    expect(unauthorized).toEqual([]);
    // The scan is only evidence while it still finds the call it was written for.
    expect(callSites).toBeGreaterThan(0);
  });
});
