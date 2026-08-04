# 000 — Plan: codex-rs research + devlog _plan → _fin sweep

- Date: 2026-07-23 (Asia/Seoul)
- Session: `019f8e04-4172-7260-982d-891794bdbd98`
- Goalplan: `.codexclaw/goalplans/document-the-2026-07-23-codex-rs-pull-realtime-s/`
- Authority: live filesystem + local git/source only. Prior prose is lead, not proof.

## Loop-spec

- Loop archetype: spec-satisfaction repair (inventory + archival + research documentation).
- Trigger: user asked to record detailed codex-rs findings in devlog and sweep finished folders to `_fin` via `$cxc-loop`, trusting real code/folders not documents alone.
- Goal: durable research unit for 2026-07-23 codex-rs pull/realtime/subagent work; every finished `_plan` unit relocated under `_fin`; ACTIVE/AMBIGUOUS left in place with evidence.
- Non-goals: product code changes in `src/`/`gui/`; GitHub mutation; push; deleting plan content; moving ambiguous units.
- Verifier: `find/ls` before/after; inventory matrix completeness; destination non-clobber checks; research docs contain live SHAs/paths.
- Stop: criteria `c_roadmap_difflevel`, `c_research_sourcebacked`, `c_inventory_complete`, `c_moves_safe` met with capturedEvidence.
- Memory artifact: this unit under `devlog/_plan/260723_codexrs_realtime_subagent_devlog_sweep/`.
- Terminal outcomes: DONE | NOOP | BLOCKED | UNSAFE | NEEDS_HUMAN | BUDGET_EXHAUSTED.
- Escalation: if a high-value unit lacks finish proof, leave AMBIGUOUS and list for human rather than archive.

## HOTL resource bounds

- Write scope: `devlog/_plan/**`, `devlog/_fin/**`, goalplan/ledger only.
- Tool scope: local shell, git status/log, file reads; no remote push.
- Wall-clock bound: 45 minutes after roadmap lock for remaining work-phases.
- Token/cost: unlimited host goal; prefer one Sol/explorer audit max per phase.

## Live baseline (measured 2026-07-23 before moves)

- `devlog/_plan` entries: 25 (mix of dirs, stub files, empty dir).
- `devlog/_fin` entries: 203.
- Root non-meta units: `cli-improvement`, `custom-model-chip`, `opencode-cursor`, plus `_chase` research tree.
- Local codex tip (120_codex-cli main): `4462b9dee` after pull.
- 121_openai-codex remains on feature branch `codex/spawn-agent-metadata-ux` with `origin/main` at `4462b9dee`.

## Dependency-ordered work-phase map

1. **WP0 docs-only roadmap (this cycle)** — create unit + protocol + decade docs. No moves.
2. **WP1 research docs** — write source-backed codex-rs/OpenCodex notes into this unit.
3. **WP2 classify** — inventory matrix for every `_plan`/root unit from live evidence.
4. **WP3 moves + verify** — relocate only FINISHED, prove final tree.

## Scope boundary

IN:
- Research documentation for realtime/subagent/codex-rs pull.
- Classification + archival of finished plan units.
OUT:
- Implementing OpenCodex feature fixes discovered by research.
- Moving nested git checkouts (`opencode-cursor`, `_chase/*`) unless clearly finished plan docs (they are not finished OpenCodex plan units).

## Success criteria (testable)

- C1: unit path exists with numbered docs 000/001/010/020/030/040.
- C2: research docs cite SHAs `4462b9dee` (or measured tip) and concrete source paths.
- C3: inventory matrix covers every current `_plan` entry and root non-meta unit.
- C4: every FINISHED move has pre-check `! exists(_fin/name)` and post-check `exists(_fin/name) && !exists(_plan/name)`.
- C5: ACTIVE/AMBIGUOUS remain under `_plan` or root with matrix rationale.

## SoT sync target

- No production SoT change required. This unit is the durable evidence store for the sweep.


## Amendment A1 (pre-A re-read)

Conservative finish bar tightened after live re-read of candidate closeouts:

- Require explicit terminal artifact with measured results, not keyword hits alone.
- Empty verification checklists (`050_final_verification.md` style) are not finish proof.
- Triage units with residual open PR/issue queues remain ACTIVE.
- Empty dirs and tiny non-unit stub files may be archived as STUB-FINISHED when destination-free.
- Nested git trees never move.


## Amendment A2 — A-gate fold-back (main synthesis after reviewer timeout)

Independent Sol reviewer dispatch timed out twice without a returned verdict. Main session performed the adversarial re-read against live `_plan` contents and folded:

1. **FINISHED bar is conservative (blocking if violated):** only archive when a terminal artifact with measured results exists. Empty checklists are not terminal. Residual open PR/issue queues keep a triage unit ACTIVE.
2. **Lead map in 020 is non-authoritative:** WP2 B must reclassify from files; the "likely FINISHED" list is a candidate set only.
3. **Loose files and stubs:** `120_desktop_3p_*.md` classified individually; empty dir / tiny stubs may be STUB-FINISHED if destination-free.
4. **Nested git never moves:** `opencode-cursor`, `_chase/**` remain root research trees.
5. **No product code in any WP** of this goal.
