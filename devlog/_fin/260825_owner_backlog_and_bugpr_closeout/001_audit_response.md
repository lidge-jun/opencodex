# 001 — Audit response (round 1)

Independent auditor verdict: **fail**, 5 blocking findings. Findings are accepted
unless an explicit rebuttal is recorded.

## B1 — The admin merge train left dev red. ACCEPTED, FIXED.

The auditor was right and the failure was real. Reproduced locally at `e42778adc`:
`bun test tests/subagent-model-fallback.test.ts tests/subagent-fallback-handle-responses.test.ts`
→ 86 pass / **2 fail**, both throwing `CodexPoolAuthenticationError` at
`src/codex/auth-context.ts:464`.

Root cause is a semantic conflict invisible to either PR alone. #2550 made
`gpt-5.6-*` account-gated and fails closed when the entitlement snapshot has no
roster (`auth-context.ts:463`). Two preview cases added by #2515 bind on
`gpt-5.6-sol` without installing a roster mock, while the neighbouring cases #2550
itself touched do install one (lines 732, 793). Each PR was green alone; only the
union is red.

Fixed in #2570 (merged `6b08567fa`). Post-fix CI run `32865619167`: all four test
shards, gates, api-usage, storage-policy and all three keyring jobs **success**;
14745 pass / 1 fail. The one remaining failure is
`tests/cursor-desktop-exec.test.ts` "computer-use non-zero exit", which passes
locally 12/12 — the known desktop-exec flake, unrelated to this change.

**Process correction for the rest of the loop:** focused suites are necessary but not
sufficient. Two PRs touching one subsystem get a combined run on the merge result
before the second lands, and dev CI is checked after each landing.

## B2 — #2472 INVALID/WONTFIX is unsupported. ACCEPTED, RECLASSIFIED.

Doc 070 proved only that the envelope FIELDS are host-owned, which does not establish
that OpenCodex cannot emit an empty successful turn. Counter-evidence:
`src/adapters/cursor/protobuf-events.ts:1055` can return `[]`,
`finalizeTurnEvents` emits `done` without semantic output (`:1365`), and
`emptyCompletionRetry` is off by default (`src/config.ts:869`).

Reclassified **INVALID/WONTFIX → IMPLEMENT (protocol gap)**. wp11 owns closing the
zero-output producer path. "Not reproduced" is a note, not a verdict.

## B3 — Security/auth material in tracked devlog. ACCEPTED, MOVED.

`AGENTS.md:95-128` is unambiguous and the plan violated it: unreleased credential and
replay analysis in `030` §#2497, and unimplemented rotator design in `050`. Both are
pre-disclosure — #2497 is unmerged auth work and #2568's rotator does not exist yet.

Resolution: both sections are reduced to a public pointer (issue/PR number plus the
already-public gate name) and the analysis moves to `.tmp/` for the duration. The
redaction lands before this unit is pushed.

## B4 — WP13 is not a credible single phase. ACCEPTED, RESTRUCTURED.

The honest reading is stronger than the plan's: #1478's owner disposition says it
needs its own cycle, #820 says explicitly it is roadmap work "not an issue a backlog
pass should touch", #1049 is deliberately deferred. Four L/HIGH programs are not one
work-phase, and closing them by adjudication would be the completion-shrinking
GOAL-COMPLETE-GATE-01 exists to stop.

Split into wp13a/wp13b/wp13c/wp13d, one issue per PABCD cycle. If a cycle proves the
work exceeds this loop's bound, that phase reports `NEEDS_HUMAN` or
`BUDGET_EXHAUSTED` — not a blanket DONE. #1048 goes first as the closest to closable.

## B5 — WP12 is narrower than its issues. ACCEPTED, WIDENED.

#2463-#2465 require persisted schema/baseline, convergence, management API, CLI, docs
and GUI; doc 080 framed them as `Models.tsx` work. wp12 acceptance now names each
non-GUI surface, so a GUI-only implementation cannot satisfy it.

## Non-blocking and missed hazards adopted

- **N2 stale heads.** #2563 is now `bc37d3d7`, non-draft, current-base; #2503 is 59
  behind / 2 ahead. Doc 010's SHAs are stale; re-verify at exact head before acting.
- **H2 shared-core serialization.** #2563, #2497, #2488, #2558 and the later
  architecture work all touch `src/server/responses/core.ts`; #2488 also touches
  `src/lab/`. Serialize them, rebase each at exact head, and make
  `tests/core-lab-boundary.test.ts` a required gate (`AGENTS.md:37-53`).
- **H3 #2465 before #2464.** Adopted as a hard order: a non-empty preset allowlist
  makes #2464 structurally inert for preset providers and avoids blocklist growth.
- **H4 WP7 surface enumeration.** wp7 must enumerate every `hasKeyPoolFailover` call
  site (Responses core, compact Responses, native Chat) or it can generalize the
  rotator while leaving live OAuth 429 paths unfixed. Presence-driven default-on is
  flagged as an explicit consent question for the user.
- **H5 Google rebase order.** #2512/#2513 both rebase over merged #2532's
  `google.ts`: rebase → full adapter CI → rebase second over that result → combined
  Google suites.

## New item admitted this round (LOOP-UNIT-CHAIN-01)

The user reported a further defect: a Codex model configured with a 922k context
window is reported as 258k inside a subagent. Admitted as wp15 with its own
investigation; it is a catalog/context-resolution defect, not part of any existing
phase.

## Verification environment (user directive, this round)

Pushes use `--no-verify`; the pre-push hook duplicates repository CI and blocks the
loop for minutes per push. Long or device-specific verification runs asynchronously on
`ssh lidge` / `ssh macmini`, with a real install on `macmini` when a released build
must be exercised. CI is the final gate, repaired at the end rather than per step.

