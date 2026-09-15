import { readResponsesCoreSource } from "../helpers/responses-core-source";
  test("the gated-model 400 ladder is charged, and keeps its own bound", () => {
    const core = readResponsesCoreSource();
    // Every rung reserves and charges, so the ladder is visible to later legs instead of
    // spending the request's allowance invisibly -- that part was the real defect.
    expect(core).toContain("targetKey: ladderTargetKey,");
    expect(core).toContain("if (rung.allowed) rung.permit.use();");
    // A same-account replay must reserve under the SAME target key the other legs use. Folding
    // the account id in made every rung read as a target change and spent the one cross-account
    // slot a genuine move needs.
    expect(core).toContain("const ladderTargetKey = `${route.providerName}|${route.modelId}`;");
    expect(core).not.toContain("|${retryAuthCtx.accountId}`;");
    // The ladder keeps its own bound and a budget refusal does NOT end it. #2097 pins this
    // recovery at eight same-account dispatches; clamping it to what the request has left would
    // cut a working path to four, which is the flat-ceiling mistake 040 warns about.
    expect(core).toContain("const maxRetrySends = retrySameConfirmedAccount ? 7 : 1;");
    expect(core).not.toContain("Math.min(retrySameConfirmedAccount ? 7 : 1, sharedSendsLeft)");
  });import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

const source = (relative: string): string =>
  readFileSync(repoPath("src", ...relative.split("/")), "utf8");

/**
 * `transientRetryOn5xx.attempts` is ONE request-wide total-send budget, not a per-leg
 * allowance. A Responses request can reach upstream on several legs — the initial send, a
 * 429/account-rotation refetch, and the terminal-guard continuation — and each leg calls
 * `fetchWithTransientRetry` separately. The budget only holds if every leg draws from the
 * shared request-scoped counter.
 *
 * The continuation leg shipped on the raw policy value instead, so a request that reached it
 * received a fresh full `attempts` allowance: with `attempts: 3` an initial send that had
 * already spent its budget could still emit three more upstream sends. Runtime coverage in
 * `tests/providers/upstream-transient-retry.test.ts` proves the helper reports and honors a remainder;
 * it cannot prove that every call site asks for one, because a site that forgets simply
 * passes a larger number. This asserts the wiring at the source, which is the only place the
 * omission is visible.
 */
describe("transient send budget stays request-scoped", () => {
  test("every transient-retry call site draws from the shared counter", () => {
    const core = readResponsesCoreSource();

    // One holder per LOGICAL request, read before any leg can send and inherited by combo
    // children through the options spread rather than recreated per child turn.
    expect(core.match(/const sendBudget = options\.sendBudget \?\? createRequestExecutionBudget\(\);/g))
      .toHaveLength(1);
    // Genuine ingress mints it; a child arrives with the parent's and must not replace it.
    expect(core).toContain("sendBudget: options.sendBudget ?? createRequestExecutionBudget(),");
    // The regressed shape: a counter local to one call frame, which a combo child restarts.
    expect(core).not.toContain("let transientSendsUsed = 0;");
    expect(core.match(/const remainingTransientSendBudget = \(budget: number\): number =>/g)).toHaveLength(1);
    // Zero has to mean zero. The Math.max(1, ...) floor funded one more send on every recovery
    // leg, which is most of how a bounded per-leg allowance composed into an unbounded
    // per-request count (#4546 REQ-B04).
    expect(core).not.toContain("Math.max(1, budget - sendBudget.used)");

    // Seven legs report into the same counter: the adapter initial send, the 429/rotation
    // refetch, the terminal-guard continuation, and the four Codex passthrough sends (initial,
    // rebuild refetch, OAuth 401 replay, rate-limit 429 replay). The passthrough four were added
    // for #4546: the owner used to be declared BELOW that branch, which put it in the temporal
    // dead zone there, so each of those legs silently took the helper's fresh default of 3.
    expect(core.match(/onSendsConsumed: noteTransientSends/g)).toHaveLength(7);

    // EVERY leg asks for the remainder now, including the adapter initial send. That one used
    // to pass the raw policy on the argument that nothing had been spent yet -- true for a first
    // turn, false for a combo child, which inherits the parent's holder and then took a fresh
    // full allowance on its own first send. Five sites spell it directly; the two rebuild legs
    // go through recoverySendAllowance, which spends the base allowance first and only then
    // draws the single shared final-recovery reserve.
    expect(core.match(/attempts: remainingTransientSendBudget\(/g)).toHaveLength(5);
    expect(core).toContain("attempts: remainingTransientSendBudget(transientPolicy.attempts)");
    expect(core).toContain("attempts: remainingTransientSendBudget(continuationTransientPolicy.attempts)");
    // The reserve path: an account move and a validated rebuild share ONE final send, so a
    // request cannot take both and reach five.
    expect(core.match(/recoverySendAllowance\(/g)).toHaveLength(2);
    expect(core).toContain("countedExternally: true");
    // The passthrough legs have no adapter policy to draw from, so they name the helper's own
    // ceiling rather than re-spelling the number.
    expect(core).toContain("attempts: remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS)");
    // The trap that would make the passthrough wiring a silent no-op: transientRetryPolicyFor
    // returns null for Codex forward auth, so gating these sites on it would restore a fresh 3.
    expect(core).not.toContain("transientPolicy ? { attempts: remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS)");

    // The regressed shape: a leg handing itself a fresh full budget.
    expect(core).not.toContain("attempts: continuationTransientPolicy.attempts }");
    expect(core).not.toContain("attempts: refetchTransientPolicy.attempts }");
    expect(core).not.toContain("attempts: transientPolicy.attempts,");
  });

  test("the helper still exposes the seam those call sites depend on", () => {
    const retry = source("lib/upstream-retry.ts");
    expect(retry).toContain("onSendsConsumed?: (sends: number) => void;");
    // Reported in `finally` so every exit path — return, throw, abort — feeds the counter.
    expect(retry).toMatch(/} finally \{\n\s*opts\.onSendsConsumed\?\.\(sent\);/);
    // A spent budget must refuse rather than round itself up to one more send.
    expect(retry).not.toContain("Math.max(1, opts.attempts ?? RESET_RETRY_MAX_ATTEMPTS)");
    expect(retry).not.toContain("Math.max(1, opts.attempts ?? TRANSIENT_RETRY_MAX_ATTEMPTS)");
    expect(retry).not.toContain("Math.max(1, budget - sent)");
    expect(retry).toContain("class SendBudgetExhaustedError extends Error");
  });
});

/**
 * The dispatch paths that were not merely uncounted but UNCOUNTABLE (#4546).
 *
 * Three holes survived the earlier slices, and each is invisible at runtime until a real account
 * pool is hot: `fetchWithResetRetry` had no reporting seam at all, so every leg without a
 * transient policy sent off the books; the compact endpoint's routed fallback called
 * `handleResponses` with no budget, so a native attempt's spend was forgotten the moment it fell
 * through; and the credential hops enforced their own per-roster caps against a counter that knew
 * nothing about the rest of the request. The wiring is what these assert -- the arithmetic is
 * pinned in `request-execution-budget.test.ts`.
 */
describe("every dispatch path reports into the shared budget", () => {
  test("the reset-only helper counts its own physical sends", () => {
    const retry = source("lib/upstream-retry.ts");
    // The seam moved onto ResetRetryOptions. On TransientRetryOptions it could not be reached by
    // the non-policy adapter send or by any rebuildAndRefetch leg with a null transient policy.
    const resetOptions = retry.slice(
      retry.indexOf("export interface ResetRetryOptions {"),
      retry.indexOf("export interface TransientRetryOptions"),
    );
    expect(resetOptions).toContain("onSendsConsumed?: (sends: number) => void;");
    // One report per physical send, before the await, so a rejected send still counts.
    expect(retry).toContain("opts.onSendsConsumed?.(1);");
    // ...and the transient layer, which already counts the same sends through countedFetch,
    // suppresses the inner reporter. Forwarding it would count every inner send twice.
    expect(retry).toContain("onSendsConsumed: undefined,");
    expect(retry).not.toContain("fetchWithResetRetry(countedFetch, { ...opts, attempts: remaining() })");
  });

  test("compact holds ONE budget for the native attempt, the handoff child and the routed turn", () => {
    const compact = source("server/responses/compact.ts");
    // Declared once, at function scope. Inside the native branch it was out of reach of the
    // routed fallback below, which is reached by a 404 native compact and by a quota failure.
    expect(compact.match(/const sendBudget: RequestExecutionBudget = options\.sendBudget \?\? createRequestExecutionBudget\(\);/g))
      .toHaveLength(1);
    // The routed compaction turn inherits it instead of letting handleResponsesInner mint a
    // fresh four.
    expect(compact).toContain("turnAdmissionLease, sendBudget,");
    // The handoff child already inherited; both paths must keep doing so.
    expect(compact).toContain("{ ...options, sendBudget }");
  });

  test("credential hops keep their roster cap AND reserve from the shared budget", () => {
    const core = readResponsesCoreSource();
    // Six hop sites: the native passthrough 429, the shared sidecar hook's generic and
    // Anthropic arms, the runTurn preflight 429, the adapter recovery loop, and the
    // continuation loop. The last two were the arms that actually iterate the roster, so
    // leaving them out meant the claim held everywhere except where it mattered most.
    expect(core.match(/reserveCredentialHop\(/g)).toHaveLength(6);
    // The per-roster caps are NOT replaced. The effective allowance is the intersection, so
    // removing either half is a behaviour change that has to be argued for.
    expect(core).toContain("genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST");
    expect(core).toContain("genericFailovers >= GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST");
    expect(core).toContain("anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST");
    // A refused hop hands the reservation back rather than spending a send it never made.
    expect(core.match(/hop\.permit\?\.release\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    // The passthrough hop's replay spends the hop's own reservation; a second one would be
    // refused as final-recovery-spent and would answer 502 instead of the real 429.
    expect(core).toContain("pendingHopPermit = hop.permit;");
  });

  test("the gated-model 400 ladder is charged, and keeps its own bound", () => {
    const core = readResponsesCoreSource();
    // Every rung reserves and charges, so the ladder is visible to later legs instead of
    // spending the request's allowance invisibly -- that was the real defect.
    expect(core).toContain("targetKey: ladderTargetKey,");
    expect(core).toContain("if (rung.allowed) rung.permit.use();");
    // A same-account replay reserves under the SAME target key the other legs use. Folding the
    // account id in made every rung read as a target change and spent the one cross-account slot
    // a genuine move needs.
    expect(core).toContain("const ladderTargetKey = `${route.providerName}|${route.modelId}`;");
    // The ladder keeps its own bound and a budget refusal does NOT end it. #2097 pins this
    // recovery at eight same-account dispatches; clamping it to what the request has left cut a
    // working path to four, which is the flat-ceiling mistake 040_send_budget.md warns about.
    expect(core).toContain("const maxRetrySends = retrySameConfirmedAccount ? 7 : 1;");
    expect(core).not.toContain("Math.min(retrySameConfirmedAccount ? 7 : 1, sharedSendsLeft)");
  });
});
