# 260711 — Cherry-pick PR #93 + #94 onto dev (union integration)

PABCD: session `cli` (terminal key), HITL loop, orchestrate CLI armed this time.
Work class: C3 (server request path, cross-provider contract; focused audit via
dispatched reviewer).

## Context

Both open PRs (Wibias) share base df29afd8 == current `dev` HEAD. Review verdict
(prior turn): #93 is the superset/structurally safer fix (parser-level
`agent_message` handling); #94's unique delta is the sanitizer-level container
normalization. They textually conflict with each other (identical responses.ts
hunk + near-identical test block at the same append point).

Commits:

- pr-93: `fb6bd707` (parser agent_message boundaries + parser test),
  `64da27d3` (sanitize-before-parse in responses.ts + compat test)
- pr-94: `f29002de` (SAME content as 64da27d3, different sha — SKIP),
  `749d3978` (sanitizer normalization: plaintext agent_message -> user message,
  recursion counting, + extra test assertion)

## Plan

1. On `dev`: `git cherry-pick fb6bd707 64da27d3` — expected clean (base match).
2. `git cherry-pick 749d3978` — AUDIT AMENDMENT (blocker 1): expected CLEAN.
   Reviewer verified 64da27d3 and f29002de produce identical blobs (same stable
   patch-id ff961126...) and `git merge-tree 64da27d3 f29002de 749d3978` merges
   without conflict; 749d3978 only edits the existing test block's comment and
   adds one assertion. The UNION rule below applies ONLY as fallback if a real
   conflict appears: keep both mechanisms in responses.ts; keep exactly one
   describe block (94's variant with the container-normalization assertion).
3. Verify: `bun test tests/multi-agent-compat.test.ts tests/responses-parser-agent-message.test.ts`
   (name may differ — use the file added by fb6bd707), then wider
   `bun test tests/` relevant subset + `bun run typecheck`.
4. AUDIT AMENDMENT (blocker 3, rollback procedure):
   - Preflight: `git status --porcelain -- src/responses/parser.ts src/server/responses.ts tests/multi-agent-compat.test.ts tests/responses-parser-agent-message.test.ts` must be EMPTY before picking.
   - Mid-sequence failure: `git cherry-pick --abort` (returns to last completed pick).
   - Full rollback after completion: `git reset --keep df29afd8` — dirty-preserving
     (aborts rather than clobbering uncommitted changes). NEVER `reset --hard`.

## Scope boundary

- IN: cherry-pick commits touching `src/responses/parser.ts`,
  `src/server/responses.ts`, `tests/multi-agent-compat.test.ts`, new parser test.
- OUT: the uncommitted user worktree changes (gui/, docs-site/, src/cli/v2.ts,
  src/codex/features.ts, src/server/management-api.ts, structure/, tests/codex-v2-gate.test.ts,
  devlog/) — MUST stay uncommitted and untouched. Cherry-pick commits only its
  own paths; no `git add -A`.
- OUT: pushing, PR closing/commenting upstream (user decides after).

## Accept criteria

- 3 commits on dev (2 from #93, 1 from #94-delta), no duplicate test blocks.
- Both mechanisms present: parser `agent_message` branch AND sanitizer
  normalization; pre-parse sanitize hook present exactly once.
- Tests: multi-agent-compat suite + new parser boundary test pass; typecheck 0.
- Known-red preexisting env tests (Cursor MCP live stdio x3, pool-health,
  Windows service) are NOT counted as regressions (per #94's report).

## Risk notes (from review)

- #94 normalization mutates native wire (agent_message -> message). Accepted:
  only fires when payload was plaintext-parked (routed-parent mint), and #93's
  parser branch covers routed paths regardless.
- Mixed-payload agent_message (genuine Fernet remains): parser drops ciphertext
  parts via inputContentParts — acceptable, routed providers cannot decrypt.

## Audit residual (blocker 2, deferred with rationale)

- [High] The regression tests call sanitize-then-parse directly and do NOT
  exercise the production wiring order inside `handleResponses` — if the
  pre-parse hook were later removed or moved after parse, these tests would
  still pass. DISPOSITION: deferred as a follow-up unit, not folded into this
  cherry-pick. Rationale: this unit intentionally preserves upstream PR content
  verbatim for attribution; a handleResponses-path integration test (needs
  config/route mocking) is an independent work-phase. Recorded here + in the D
  report so it is not lost (LOOP-UNIT-CHAIN-01 candidate).
