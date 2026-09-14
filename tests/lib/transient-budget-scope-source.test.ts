import { describe, expect, test } from "bun:test";
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
    const core = source("server/responses/core.ts");

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
