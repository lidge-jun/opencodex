# L3 compaction and Responses carries — roadmap

Three contributor fixes on the compaction and Responses paths are carried onto current `dev` as
maintainer PRs on `origin`, one PR per source PR with a `Co-authored-by` trailer for its author.
Each carry fixes what review found and stops at merge-ready: exact-head hosted CI green and an
independent review PASS. Merging, closing the original PRs and commenting on them stay with the
maintainer.

## Loop spec

- Loop archetype: satisfy-spec, one PABCD cycle per carry after this docs-only roadmap cycle.
- Trigger: coordinator thread 01a11e2e dispatched lane L3 (#6769, #6746, #6741).
- Goal: three dev-targeted carry PRs, each merge-ready.
- Non-goals: merging, release, comments on or closing contributor PRs, pushing to contributor
  forks, approving fork workflows; #6764's task-selection-after-replay symptom; #6736's Meta
  Anthropic-format opaque-state design; file-size cap raises; other lanes' areas.
- Verifier: focused `bun test` files per carry (listed in each decade doc), `bun run typecheck`,
  `bun run structure:check`, `bun run privacy:scan`, then exact-head hosted CI. No full local
  `bun run test` (coordinator constraint).
- Stop condition: all three PRs merge-ready, or a PR recorded as blocked with its reason.
- Memory artifact: this unit and the session goalplan. The #6741 design analysis is kept in
  gitignored scratch until that fix ships, per the security working-notes rule in `AGENTS.md`;
  its public outcome is recorded here at D.
- Expected terminal outcomes: DONE (three merge-ready PRs); NOOP for a carry already on dev;
  BLOCKED when hosted CI cannot run; NEEDS_HUMAN for merge and closing the originals.
- Escalation: a behavior decision outside a PR's stated scope, a CI failure that blocks every PR,
  or a reviewer FAIL that two repair rounds do not clear.

## Work-phase map (dependency order)

| Work-phase | Doc | Branch | Source PR |
|---|---|---|---|
| wp1 | this unit | — | — |
| wp2 | [010](010_carry_6769_external_task_input.md) | `codex/compaction-responses-carry` | #6769 robin-bially |
| wp3 | [020](020_carry_6746_hosted_search_compaction.md) | `codex/l3-hosted-search-compaction-carry` | #6746 yuanyuanlove |
| wp4 | [030](030_carry_6741_claude_native_reasoning.md) | `codex/l3-claude-native-reasoning-carry` | #6741 rhomat27 |

#6769 and #6746 both change the raw-body portable compaction path in
`src/adapters/openai-responses/`; #6769 is the smaller contract fix and goes first, so #6746 is
re-verified on top of it. #6741 changes the Claude translation and reasoning envelope, which then
flows through the same passthrough sanitizers, so it is verified last. #6769 and #6741 both add
entries to the two test-layout registries; each carry adds its own and the later one rebases.

## Review record

Design: gpt-6-sol architect consultation with eight reflection rounds (final: ALIGNED). Audit:
independent gpt-6-sol reviewer, five rounds; rounds 1-4 returned FAIL and every blocker was
folded into the plan; round 5 returned PASS. #6769's carry gains a whitespace `call_id` alignment
with the parser; #6746's carry lowers the search note to an assistant reference note with field,
list and 64 KiB request caps; #6741's carry gains provenance checks described at its D.
