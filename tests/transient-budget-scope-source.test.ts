import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (relative: string): string =>
  readFileSync(join(import.meta.dir, "..", "src", ...relative.split("/")), "utf8");

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
 * `tests/upstream-transient-retry.test.ts` proves the helper reports and honors a remainder;
 * it cannot prove that every call site asks for one, because a site that forgets simply
 * passes a larger number. This asserts the wiring at the source, which is the only place the
 * omission is visible.
 */
describe("transient send budget stays request-scoped", () => {
  test("every transient-retry call site draws from the shared counter", () => {
    const core = source("server/responses/core.ts");

    // One owner per request, declared before any leg can send.
    expect(core.match(/let transientSendsUsed = 0;/g)).toHaveLength(1);
    expect(core.match(/const remainingTransientSendBudget = \(budget: number\): number =>/g)).toHaveLength(1);

    // Initial send, 429/rotation refetch, and terminal-guard continuation: three legs, three
    // reports into the same counter.
    expect(core.match(/onSendsConsumed: noteTransientSends/g)).toHaveLength(3);

    // The refetch and continuation legs must ask for the REMAINDER. Only the initial send may
    // pass a policy value directly, because nothing has been spent yet.
    expect(core.match(/attempts: remainingTransientSendBudget\(/g)).toHaveLength(2);
    expect(core).toContain("attempts: remainingTransientSendBudget(refetchTransientPolicy.attempts)");
    expect(core).toContain("attempts: remainingTransientSendBudget(continuationTransientPolicy.attempts)");

    // The regressed shape: a leg handing itself a fresh full budget.
    expect(core).not.toContain("attempts: continuationTransientPolicy.attempts }");
    expect(core).not.toContain("attempts: refetchTransientPolicy.attempts }");
  });

  test("the helper still exposes the seam those call sites depend on", () => {
    const retry = source("lib/upstream-retry.ts");
    expect(retry).toContain("onSendsConsumed?: (sends: number) => void;");
    // Reported in `finally` so every exit path — return, throw, abort — feeds the counter.
    expect(retry).toMatch(/} finally \{\n\s*opts\.onSendsConsumed\?\.\(sent\);/);
  });
});
