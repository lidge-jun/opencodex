# 260929 dev after 2.70.0: Claude contract hardening and PR carries

Loop objective: harden the Sonnet 5.5 rollout and land a small, reviewed set of open PRs on `dev`
(owner request 2026-09-29, admin merge authorized). Base: `dev` `a118fcc64c` (2.71.0 line).
Research: two gpt-6-sol read-only leaves (hardening audit, PR/issue triage) and live probes.

## Live evidence (2026-09-29, api.anthropic.com, OAuth, one field changed per request)

| Model | temperature 0.2 | top_p 0.9 | top_k 5 | tool_choice any | thinking disabled | between_tools |
|---|---:|---:|---:|---:|---:|---:|
| claude-sonnet-5-5 | 400 | 400 | 400 | 400 | 400 | 200 (xhigh effort: 400) |
| claude-sonnet-5 | 400 | 400 | 400 | 200 | 200 | — |
| claude-fable-5-1 | 400 | 400 | 400 | 400 | 400 | 400 |
| claude-fable-5 | 400 | 400 | 400 | 200 | 400 | — |
| claude-opus-5-5 | 400 | 400 | 400 | 400 | 400 | 400 |
| claude-opus-5 | 400 | 400 | 400 | 200 | 200 | 400 |
| claude-opus-4-8, 4-7 | 400 | 400 | 400 | 200 | 200 | — |
| claude-opus-4-6, sonnet-4-6, haiku-4-5 | 200 | 200 | 200 | 200 | 200 | 400 (haiku) |

`temperature: 1` (the default) returns 200 on Sonnet 5.5, Opus 5.5, Fable 5.1 and Opus 5.

## Units

| wp | Unit | Method | Why now |
|---|---|---|---|
| wp2 | Claude request-contract hardening | own PR | Sampling rejection covers every adaptive family, not only Sonnet 5.5; Fable 5.1 rejects forced tool choice; sidecars send `disabled` to Opus 5.5 / Fable, which reject it |
| wp3 | #6194 reject forged `ss` owner tuples (luvs01) | merge | approved, CLEAN, exact-head CI green; port-reclaim trust boundary |
| wp4 | #6195 preserve drift-heal ownership veto (luvs01) | merge | approved, CLEAN, CI green; foreign service-home write |
| wp5 | #6193 bound GLM checkpoint-envelope scanning (luvs01) | merge after disposing one CodeRabbit thread | approved, CLEAN, CI green |
| wp6 | #6089 Usage blank scroll (fflake33) | carry with Co-authored-by | maintainer-approved UI fix held in draft by the author checklist |

Not landed: #6214 (removes Kiro preemptive rows; Kiro now publishes Opus 5.5 and the owner chose
preemptive rows, so it needs an owner decision), #6209 (draft, needs a real Windows run), #6119 (open
maintainer objection), Cursor/Devin effort-suffixed price lookup (logs record the base selector, so no
observed unpriced rows), Messages-native passthrough rewriting (caller-owned contract,
structure/data-planes/protocol-paths.md), dotted Bedrock ids (no direct Bedrock adapter reaches
`anthropic.ts`).

## wp2 diff

`src/adapters/anthropic-model-contract.ts`:
- `rejectsSamplingParameters`: Sonnet >= 5.0, Opus >= 4.7, every Fable. The adapter already drops
  temperature/top_p whenever it sends thinking; this closes the no-reasoning path.
- `rejectsForcedToolChoice`: add Fable >= 5.1.
- `sidecarThinkingOff`: `between_tools` for Sonnet >= 5.5; omit the field for Opus 5.5 and Fable
  (both reject `disabled` and `between_tools`); `disabled` otherwise. Sidecars spread the result.
Tests: extend `tests/adapters/anthropic/anthropic-sonnet-5-5-contract.test.ts` with the family table;
update any existing test that expects temperature on an adaptive family. Structure docs updated.
Verify: focused anthropic, web-search, vision tests; typecheck; structure; privacy; live re-probe.

## wp3-wp5

Per PR: fetch head, merge onto current `dev` in a `/private/tmp` checkout, run the PR's focused tests
plus typecheck and the file-size ratchet on the combined tree, check open review threads, then
`gh pr merge --squash --admin` (author credit stays with the PR).

## wp6

Cherry-pick #6089's commits onto a fresh branch from `dev`, add `Co-authored-by` for fflake33, run the
Usage tests, `bun run lint:gui` and `bun run build:gui`, open a PR carrying its screenshot link, admin
merge, then close #6089 with a pointer to the carry.

## Audit (020, gpt-6-sol, NEAR-PASS) folded

1. Sidecar budget for families that reject both `disabled` and `between_tools`: live probe at
   max_tokens 1024 returned `end_turn` with 430-630 characters of text for Opus 5.5, Fable 5.1 and
   Fable 5, both with thinking omitted and with `output_config.effort: "low"`. The sidecar sends
   `output_config: {effort: "low"}` and no `thinking` for those families.
2. The sampling rule keys on the family-first parse; legacy `claude-3-7-sonnet` does not parse and
   keeps its sampling fields, and `claude-opus-4-20250514` parses as Opus 4.0 (keeps them).
3. `tests/adapters/anthropic/anthropic-reasoning.test.ts` expects Fable 5 to keep `temperature`; it is
   updated to the live contract. New wire cases cover each rejecting family and Fable 5.1 forced choice.
4. wp3/wp4 run the combined-tree checks on current `dev` before each admin merge.
5. wp5 disposes the open CodeRabbit thread (the old regex was already `/i`) before merging.
6. wp6 opens a template PR with the screenshot link, trailer
   `Co-authored-by: Jian Gong <fflake33@icloud.com>`, waits for its exact-head CI, and adds typecheck,
   structure and privacy checks to the GUI verification.
