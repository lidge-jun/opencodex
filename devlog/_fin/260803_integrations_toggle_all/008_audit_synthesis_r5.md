# Audit round 5 — synthesis

Verdict: **FAIL**, 5 blocking, all High. Fifth round, fresh reviewer, and the
first one whose findings are all fixable inside this unit without changing a
design decision.

## The re-scope is confirmed

The question I put to the reviewer directly — is this scope-shrinking to escape
a failing audit loop? — came back answered:

> The re-scope itself is defensible. Dropping Grok's snapshot does not introduce
> undisclosed loss if "enable" explicitly means regenerating opencodex-owned
> state from the current catalog. The blockers below are route and contract
> defects, not a reason to restore the snapshot design.

It also confirmed, with evidence, three things the previous rounds had left
open: Claude Code's flag semantics are sound, the corrected config-isolation
statement is now accurate, and the ownership check is read-only and
implementable by wrapping `assertServiceEnvironmentMatchesInstall`.

And it named the honest cost of dropping Grok's snapshot: a catalog that changed
while disabled, or an outside-fence alias collision, produces a *different*
managed block on re-enable. Not hidden data loss — the dialog says we regenerate
— but a real difference, and now recorded rather than glossed.

## The one finding that is about code, not documents

**#1, and it is a genuine defect in my mapping.** `injectGrokConfig` under a
non-loopback bind does not decline and leave the file alone. It calls
`stripGrokConfig` FIRST, removes any previously generated block, and only then
returns `ok: true, changed: true, skippedReason: "non-loopback"`
(`src/grok/inject.ts:352-362`). Verified directly.

I mapped that to a 409 refusal, and `030` says refusals change nothing. So an
enable under a non-loopback bind would have deleted the user's fence and told
them the request was declined. That is precisely the class of lie round 1 #2
established must never happen — I removed the `partial` machinery on the
grounds that neither client can half-apply, and here is the case that can.

The comment above that code explains why the strip is correct: a regenerated
block cannot carry the admission token a non-loopback bind needs without either
writing the user's secret into their file or opening grok's credential
fallthrough. Removing a now-invalid loopback block is the safe thing. It is just
not a no-op, and the route must say so.

## The other four are my editing debris

#2, #4 and #5 are all the same failure mode I was warned about in round 3 #9 and
committed to sweeping for: amendments that add corrected text without removing
what they replace.

- `030` declares the route module NEW while `011` also creates it and `012`
  modifies it; and it defines `NativeStatus` **twice**, the second copy
  restoring the `snapshotCount` field I had just removed.
- `040` still says "four more switches" in its title, orders four in its IN
  list, sends Codex and Desktop into confirmation in its pseudocode, and demands
  three dialogs and four round trips in verification.
- `002` still presents three dialogs and Desktop/Codex refusals as this unit's
  work.

My round-4 sweep grepped for `010`/`020`/`compound snapshot`/`absPath` and
found the references I already knew about. It did not grep for `four`, for
`snapshotCount`, or for the phase-ownership of a file — the claims that
actually drifted. A sweep is only as good as the terms it looks for.

#2 is different in kind: the coordinator claim that replacing
`integration-routes.ts`'s flight map "preserves the same busy-409 behavior" is
false. The existing map JOINS an identical in-flight operation rather than
refusing it (`integration-routes.ts:146`), and has a ten-minute terminal expiry.
A plain mutex refuses the second caller. That is a behavior change I asserted
away instead of declaring.

## Disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | High | `non_loopback` can mutate but is mapped as a refusal | **Accept** — becomes an enable outcome with `changed: true` |
| 2 | High | Coordinator does not preserve the flight contract | **Accept with variation** — see below |
| 3 | High | `disableBlocked` needs a real non-mutating inspector; GET is advisory | **Accept** |
| 4 | High | Route ownership and `NativeStatus` contradict themselves | **Accept** |
| 5 | High | `040`/`002` still carry four-client contracts | **Accept** |

### Variation on #2

The reviewer offers: preserve the join semantics, or declare the change. I am
**dropping the coordinator from this unit entirely.**

It was introduced to protect shared journal bookkeeping between native and file
clients. After the re-scope neither native toggle writes a journal row, so there
is no shared bookkeeping left to protect — the only remaining overlap is
`config:ocx`, which one small per-client guard covers. Rewriting the file
clients' flight map to inherit a contract they already implement correctly is
risk with no payoff.

Grok gets a per-client guard; Claude Code serializes on config. The coordinator
moves to the sibling unit, which has real cross-client bookkeeping to coordinate.

## Process rule, second attempt

Round 3 gave me "sweep the claims, not the headings" and I under-applied it.
Concretely, before the next re-audit: grep each doc for the OTHER phases' client
names, for every type name it defines, and for cardinality words (`four`,
`three`, `both`). Then read every hit.
