# Independent audit round 1 — dispositions

Auditor: independent adversarial subagent (xai/grok-4.6), read-only.
Verdict: **GAPS(8)**. All eight are folded; nothing is rebutted.

| # | Blocker | Disposition |
| --- | --- | --- |
| 1 | `000_plan.md` still carried the pre-fold contract (29 keys, scalar cancel, `replayed` as success, "nothing was consumed" copy) while `020` claimed it was amended | **Folded.** `000_plan.md` is rewritten as the post-audit contract: D1-D7, a new file map, a new verifier table, a nine-row activation table, and twelve accept criteria. `010`/`020` remain as the consultation record. |
| 2 | File map missed `structure/gui-and-management-api.md` (owns `gui/` per `structure/manifest.json:299`), missed that D3b also changes the hook, and under-counted the keys | **Folded.** Both structure docs are in the map, the hook owns the settled-`code` result, and the key set is fixed at 36 including the unknown-outcome copy. zh-TW translates `couponNextBadge` so `locale-parity.test.ts` needs no allowlist edit. |
| 3 | Criteria were unobservable: criterion 4 was false (the dialog uses `common.*` and a literal `0`), criteria 7-10 lived only in `020`, and the new behaviors had no criteria | **Folded.** Criterion 4 is scoped to grok-specific visible copy with the shared keys and the inherited `aria-hidden` placeholder named as exceptions; criteria 7-12 are in `000_plan.md`. |
| 4 | Verifier table claimed observation it did not have: `lint:i18n` cannot see `src/hooks` or `src/i18n`, and nothing observed docs-site or structure | **Folded.** The table now records `lint:i18n` as partial, adds `bun run lint`, `bun test tests/i18n-locales.test.ts`, `bun run structure:check`, the root PR-ready gates, and marks docs-site prose as human review rather than a gate. |
| 5 | "Refuse a same-id retry" after an abort is the double-spend, not a mitigation: minting a new id while RedeemReset may still be executing against an `open` record spends a second coupon | **Folded, and the rule is inverted.** D5 now keeps the same operation id, blocks a new confirmation while the outcome is unknown, and offers only a re-read plus a same-id retry. The backend residual stays recorded, but the client no longer converts it into a second spend. |
| 6 | The "three in flight" bound existed only in prose, and the StrictMode cost was understated | **Folded.** The bound is a queue inside the hook with its own accept criterion, and D1 states the real cost: 2N reads under StrictMode, no TTL cache, re-read on remount. |
| 7 | `gui/AGENTS.md` PR-ready requires `bun run lint`; the root template requires a GUI screenshot | **Folded.** Both are in criterion 5 and in the new PR gate section. |
| 8 | The WIP could post without `operationId` (`newOperationId()` may return `undefined`), which breaks the whole D3 premise | **Folded.** D4 makes the id mandatory: no id, no POST, with user-visible copy. |

Nits accepted: the "every command was run" line is replaced by a per-row exit
column; the `aria-hidden` `0` placeholder is now named in D7; the `i18n-locales`
path is corrected to `gui/tests/`; the OAuth-surface gate is required to be
computed before the hook call. `parseCoupons` rejecting a whole malformed list
stays as designed — a partially-parsed coupon list is worse than an error badge —
and is now stated rather than implicit.


## Audit round 2 — dispositions

Verdict: **GAPS(2)**, both folded.

1. *Same-id retry after an abort is still a second RedeemReset against an `open`
   record.* Correct. D5 is inverted again: after an abort the dialog issues no
   consume request at all. Its only control is a re-read; a coupon that disappears
   is reported consumed, and a coupon still listed leaves the state unresolved with
   copy that says so.
2. *Criterion 12 had no activation.* Folded: the activation table gains a
   five-account roster with held-open GETs, proving at most three are in flight.

Nit folded: the loop-spec no longer claims every verifier command was run; the
table's exit column carries the truth.

Residual carried into the PR (not closed by this unit): a redemption whose journal
record is still `open` re-executes if anything ever retries it. This unit's client
never retries, so it cannot cause that spend, but the route's `open` -> `execute`
branch stays as merged and is recorded as the follow-up against `src/`.

