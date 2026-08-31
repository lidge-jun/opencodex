# 260831 — priority-70+ train: entitlement floor, roster TTL, Windows spill drain

Frozen scope taken at 2026-08-31T01:1x KST from the open bug backlog. Three
targets, dependency-ordered. Each implementation phase consumes exactly one
decade doc as one full PABCD cycle.

| wp | target | doc | priority |
| --- | --- | --- | --- |
| wp0 | this roadmap | `000`-`009` | — |
| wp1 | #3022 entitlement client_version floor + empty-vs-negative roster | `010` | 78/80 |
| wp2 | #3023 roster TTL expiry drops entitled rows | `020` | 71/80 |
| wp3 | #3011 Windows ACL spill stall (PR #3018 audit) | `030` | 71/80 |

Three more work phases were born from audit blockers rather than from the frozen scan,
so they are recorded here as audit-derived additions rather than as part of the original
three-target scope:

| wp | target | doc | origin |
| --- | --- | --- | --- |
| wp4 | entitlement diagnostic transport | `040` | split out of wp2 by audit round 1 (`004`, blocker 4) |
| wp5 | tri-state entitlement authority | `050` | split out of wp1 by audit round 2 (`005`, blocker 1) |
| wp6 | #3023 ensure-freshness implementation | `060` | wp2 closed as a planning cycle; its implementation is wp6 |

## Why this order

wp1 is the stack base: it changes what `resolveCodexModelEntitlements` records
for an account. wp2 changes *when* the management surfaces re-read that record.
Landing wp2 first would leave the shared entry point refreshing a value that is
still wrong, so the fix would look effective on a warm cache and fail on a cold
one.

wp3 is independent of both — it touches `src/responses/spill-store.ts` and
`src/responses/state.ts`, no catalog code — so it does not stack on wp1/wp2 and
can land in parallel.

## Evidence provenance

Three read-only `gpt-5.6-sol` high-effort research lanes were dispatched at wp0.
Their file:line findings are recorded in `001`-`003`. Every claim below that is
load-bearing was re-verified directly in the tree by the main session before
being written here.

## Verification constraint (user-imposed)

Local full test suites are forbidden for this train. Focused
`bun test <file>` runs locally; every suite, typecheck, and privacy scan runs on
`ssh lidge` (Linux x86_64, bun + git + gh present). Every completion claim
carries a receipt: command, exit code, pass/fail counts. Each regression test is
driven red against pre-fix code and that red result recorded.

## Delivery

Stacked PRs per `DEV-STACK-01`, pushed `--no-verify` (the pre-push hook runs the
forbidden local suite). Merge into `dev` is authorized for this goal.
