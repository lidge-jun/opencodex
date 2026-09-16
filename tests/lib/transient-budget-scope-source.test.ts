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
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

const source = (relative: string): string =>
  readFileSync(repoPath("src", ...relative.split("/")), "utf8");

/** Check balanced option objects and their local allowance declarations, ignoring textual decoys. */
function retryBudgetWiring(text: string): { reporters: number; invalid: string[] } {
  // TypeScript 7's lexical scanner is in-process: no compiler server or fixture files.
  const scanner = createScanner(true, undefined, text);
  const tokens: string[] = [];
  const skipTemplate = (): void => {
    let depth = 0;
    for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
      if (kind === SyntaxKind.TemplateHead) skipTemplate();
      else if (kind === SyntaxKind.OpenBraceToken) depth++;
      else if (kind === SyntaxKind.CloseBraceToken) {
        if (depth) depth--;
        else if (scanner.reScanTemplateToken(false) === SyntaxKind.TemplateTail) return;
      }
    }
  };
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.TemplateHead) { skipTemplate(); tokens.push("#literal"); }
    else if (kind === SyntaxKind.StringLiteral) tokens.push(JSON.stringify(scanner.getTokenValue()));
    else if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) tokens.push("#literal");
    else tokens.push(scanner.getTokenText());
  }
  const close = new Map<number, number>();
  const parent = new Map<number, number>();
  const scopeAt: number[] = [];
  const stack: number[] = [];
  let scope = -1;
  tokens.forEach((token, index) => {
    scopeAt[index] = scope;
    if (["(", "[", "{"].includes(token)) {
      stack.push(index);
      if (token === "{") { parent.set(index, scope); scope = index; }
    } else if ([")", "]", "}"].includes(token)) {
      const start = stack.pop();
      if (start !== undefined) close.set(start, index);
      if (token === "}") scope = parent.get(scope) ?? -1;
    }
  });
  const bindings = new Map<number, Map<string, number>>();
  tokens.forEach((token, index) => {
    if ((token === "const" || token === "let") && tokens[index + 2] === "=") {
      const scope = scopeAt[index]!;
      if (!bindings.has(scope)) bindings.set(scope, new Map());
      bindings.get(scope)!.set(tokens[index + 1]!, index + 3);
    }
  });
  const unwrap = (start: number, end: number): [number, number] => {
    while (tokens[start] === "(" && close.get(start) === end - 1) { start++; end--; }
    return [start, end];
  };
  const shared = (start: number, end: number, scope: number): boolean => {
    [start, end] = unwrap(start, end);
    if (tokens[start] === "remainingTransientSendBudget" && tokens[start + 1] === "("
      && close.get(start + 1) === end - 1) return true;
    if (end - start !== 3 || tokens[start + 1] !== "." || tokens[start + 2] !== "attempts") return false;
    while (scope >= -1) {
      const declaration = bindings.get(scope)?.get(tokens[start]!);
      if (declaration !== undefined) {
        const callEnd = close.get(declaration + 1);
        return tokens[declaration] === "recoverySendAllowance" && tokens[declaration + 1] === "("
          && callEnd !== undefined && [";", ","].includes(tokens[callEnd + 1]!);
      }
      if (scope === -1) break;
      scope = parent.get(scope) ?? -1;
    }
    return false;
  };
  let reporters = 0;
  const invalid: string[] = [];
  for (const [object, end] of close) {
    if (tokens[object] !== "{") continue;
    const properties = new Map<string, [number, number][]>();
    for (let index = object + 1; index < end; index++) {
      if (tokens[index + 1] === ":") {
        const name = tokens[index]!.replace(/^"|"$/g, "");
        const start = index + 2;
        index = start;
        while (index < end && tokens[index] !== ",") index = (close.get(index) ?? index) + 1;
        if (!properties.has(name)) properties.set(name, []);
        properties.get(name)!.push(unwrap(start, index));
      } else if (close.has(index)) index = close.get(index)!;
    }
    if (properties.get("onSendsConsumed")?.some(([start, end]) => end - start === 1 && tokens[start] === "noteTransientSends")) {
      reporters++;
      const attempts = properties.get("attempts") ?? [];
      if (attempts.length !== 1 || !shared(...attempts[0]!, object)) {
        invalid.push(`reporter ${reporters}: unchecked attempts`);
      }
    }
  }
  return { reporters, invalid };
}

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
    // Every reporter must draw either directly from the remainder or from the recovery
    // allowance declared in its own lexical scope. The split between these forms may change:
    // the first terminal repair now draws the final reserve without an explicit recovery label.
    // A whole-tree substring count could pass while one site took a fresh policy allowance.
    const wiring = retryBudgetWiring(core);
    // Generic OAuth401 now shares rebuildAndRefetch instead of duplicating a retry reporter.
    expect(wiring.reporters).toBe(6);
    expect(wiring.invalid).toEqual([]);
    expect(core).toContain("countedExternally: true");
    // The trap that would make the passthrough wiring a silent no-op: transientRetryPolicyFor
    // returns null for Codex forward auth, so gating these sites on it would restore a fresh 3.
    expect(core).not.toContain("transientPolicy ? { attempts: remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS)");

    // The regressed shape: a leg handing itself a fresh full budget.
    expect(core).not.toContain("attempts: continuationTransientPolicy.attempts }");
    expect(core).not.toContain("attempts: refetchTransientPolicy.attempts }");
    expect(core).not.toContain("attempts: transientPolicy.attempts,");
  });

  test("the wiring oracle ignores formatting and decoy text but rejects fresh allowances", () => {
    const options = (attempts: string): string => `retry(fetch, {
      "onSendsConsumed": (noteTransientSends),
      /* a comment between the property and its value is not a different budget */
      attempts: (${attempts}),
    });`;
    const decoy = `// attempts: remainingTransientSendBudget(3), onSendsConsumed: noteTransientSends
      const text = "attempts: remainingTransientSendBudget(3), onSendsConsumed: noteTransientSends";`;
    const valid = `${decoy}
      ${options("remainingTransientSendBudget /* format */ (policy.attempts)")}
      const allowance = recoverySendAllowance(cap, "repair", target);
      ${options("allowance.attempts")}`;
    expect(retryBudgetWiring(valid)).toEqual({ reporters: 2, invalid: [] });
    expect(retryBudgetWiring(valid.replaceAll("\n", "\r\n\t").replaceAll(": (", ":\n (")))
      .toEqual({ reporters: 2, invalid: [] });
    for (const fresh of ["3", "policy.attempts"]) {
      expect(retryBudgetWiring(`${decoy}\n${options(fresh)}`).invalid).toHaveLength(1);
      // An unrelated valid allowance, even with the same name, cannot hide a fresh local one.
      const shadowed = `const allowance = recoverySendAllowance(cap, "repair", target);
        function continuation() { const allowance = { attempts: ${fresh} }; ${options("allowance.attempts")} }`;
      expect(retryBudgetWiring(shadowed).invalid).toHaveLength(1);
    }
    expect(retryBudgetWiring(`const allowance = recoverySendAllowance(cap) || policy;
      ${options("allowance.attempts")}`).invalid).toHaveLength(1);
    expect(retryBudgetWiring("retry(fetch, { onSendsConsumed: noteTransientSends });").invalid)
      .toHaveLength(1);
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
    expect(compact).toContain("{ ...options, sendBudget: handoffBudget }");
    expect(compact).toContain("sendBudget.deriveScope({");
    expect(compact).toContain("}, hop.permit)");
  });

  test("credential hops keep their roster cap AND reserve from the shared budget", () => {
    const core = readResponsesCoreSource();
    // Existing six roster-hop sites plus native main/pool401, generic passthrough OAuth401,
    // translated OAuth401 and static-key401 all admit before credential mutation/body disposal.
    expect(core.match(/reserveCredentialHop\(/g)).toHaveLength(10);
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
