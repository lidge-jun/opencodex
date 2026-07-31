# 001 — D summary: ultra reasoning spec port

**Terminal outcome: DONE** (single work-phase, PABCD cycle closed 2026-07-09, session `cli`).

## What shipped (uncommitted working-tree changes, 13 files, ~+135/-32)

- `src/reasoning-effort.ts` — `ultra` appended to `CODEX_REASONING_LEVELS` above `max`
  (upstream enum rank, openai_models.rs:40-51); `mapReasoningEffort` applies the upstream
  boundary (`client.rs:174-179` Ultra=>Max) BEFORE alias and clamp resolution, plus a belt
  conversion after clamp. Ultra can never influence a provider wire value.
- `src/responses/parser.ts` — ingest normalizes `reasoning.effort:"ultra"` -> `"max"`;
  previously ultra was silently dropped, disabling reasoning entirely (G1). Deviation from
  plan wording: `REASONING_EFFORTS` set left unchanged — normalization makes a set entry
  unreachable (single-boundary decision from A fold-back).
- `src/codex/catalog.ts` — routed default ladder stays `low..max` (`ROUTED_REASONING_LEVELS`
  filters ultra; opt-in per model via `reasoningEfforts` config); description lookup sources
  the full ladder; `ensureMaxReasoningLevel` -> `ensureGpt56ReasoningLevels` appends `max`+`ultra`
  for `gpt-5.6-sol/terra/luna` on template AND no-template paths.
- Tests: +8 cases (sanitize/clamp/boundary/alias-inertness/canonical-description/fallback-path/
  parser ingest x2), 1 expectation updated. Docs: README en/ko/zh, docs-site x3,
  docs/codex-app-model-catalog.md ladder section (SOT-SYNC-01).

## Evidence

- `bun x tsc --noEmit` exit 0; full `bun test` **1651 pass / 0 fail / 7302 expects / exit 0**.
- A-gate reviewer (gpt-5.5): FAIL -> 3 blockers folded back (single boundary, description
  lookup source, docs scope). C-gate diff reviewer (gpt-5.5): FAIL -> 2 blockers fixed
  (ultra alias bypass; coverage gap). Both re-verified green.
- Upstream survey (gpt-5.5 explorer, origin/main a09a7c41d) recorded in 000_plan.md.

## LOOP-PESSIMIST-01 (what died / residual risk)

- Died: "wireMap.ultra as a legitimate provider alias" — contradicted the upstream invariant
  twice (A and C reviewers); ultra-keyed aliases are now deliberately inert.
- Died: "sol has its own patch series" — upstream `sol` is only the GPT-5.6 family codename
  (model-provider-info/src/lib.rs:43) and a realtime voice; ultra is the substantive series.
- Residual: whether OpenAI's REAL backend catalog advertises `ultra` for gpt-5.6-sol is
  unverified (no live catalog access; ocx synthesizes these entries from the gpt-5.5 template).
  If upstream later ships a different ladder for 5.6, `ensureGpt56ReasoningLevels` is the single
  place to amend. Evidence that would prove this wrong: a captured real `/models` response for
  gpt-5.6-* without ultra, or with a different order.
- Residual: proactive multi-agent derivation is client-owned; if a Codex build older than
  df1199fdd is pointed at ocx, selecting ultra sends raw "ultra" — parser normalization covers
  it (test-asserted), but no live end-to-end run with such a build was performed.
