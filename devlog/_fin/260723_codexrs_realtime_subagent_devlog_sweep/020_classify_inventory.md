# 020 — Classify every _plan entry from live evidence

## Objective

Produce a complete inventory matrix. No moves in this phase.

## File

| Path | Action |
| --- | --- |
| `020_inventory_matrix.md` | NEW — one row per current `_plan` entry + root non-meta units |

## Pre-measured candidate map (lead only; B must re-read files)

Re-check each before final label. Initial lead from 2026-07-23 live probe:

### Likely FINISHED (need close-out confirmation)

- `260723_issue_fixes` — has `040_loop_closeout.md` terminal DONE with commits.
- `260722_star_surge_triage` — merge/close records for triage batch.
- `260722_pr_review_strategy` — close/final verification docs present.
- `260722_issue_bug_sweep` — merge readiness review present.
- `260721_sidebar_diet` — WP docs + evidence screenshots; check residual.
- `260722_provider_usage_cost_breakdown` — large completed phase docs; check residual.
- `260723_open_pr_review` — `100_merge_records.md`.
- `260723_overnight_pr_review` — close docs for PR batch.
- `260722_dev_sync_stabilize` — READY + release train; confirm whether release closed unit or still active ops note.
- `260721_260721-alibaba-token-plan-hardening` — implementation + release train docs.
- empty `260721_alibaba_token_plan_hardening` — empty dir STUB.
- stub files `260712_cla`, `260712_claudecode_webs` — non-dir stubs.

### Likely ACTIVE

- `260723_issue_triage` — fixes exist but residual open questions / ongoing guidance work.
- `260723_issue_triage_r2` — open set remaining.
- `260723_antigravity_usage_model_unify` — plan + verify checklist not closed.
- `260722_custom-model-chip` — multi-phase design; residual unclear → re-read.
- `260722_claudedesktop_branch_split` — plan-only ops doc; residual branch policy.
- `260722_repo_governance_config` — plan-only.
- `260701_codex-catalog-split` — `999_status.md` explicitly kept in `_plan`; deferred split.
- `500_storage-page-session-cleanup` — open questions.
- `issue_017_mobile-thread-bypass-proxy` — review-only.
- root `cli-improvement`, `custom-model-chip` — design notes without close-out.
- root `opencode-cursor`, `_chase` — nested research/git; not finished plan units.

### Loose files

- `120_desktop_3p_alias_spec.md`, `120_desktop_3p_aliases.md` — classify as ACTIVE/AMBIGUOUS plan files unless close-out found.

## Matrix columns

`path | type(dir/file) | label | evidence_paths | residual | destination_free | notes`

## Accept criteria

- Every entry under `devlog/_plan` appears exactly once.
- Root non-meta units appear.
- No FINISHED label without evidence path cited.
- Destination free column checked against `devlog/_fin/<name>`.


## Amendment A2

The "likely FINISHED" section is a **candidate shortlist only**. Authoritative labels are written only in `020_inventory_matrix.md` after re-reading each unit. Known false-finish traps from live re-read:

- `260722_pr_review_strategy/050_final_verification.md` empty checklist
- `260722_star_surge_triage` residual open PR/issue queue in 040
- `260721_sidebar_diet` / `260722_provider_usage_cost_breakdown` may be implementation plans without unit close-out — prove before FINISHED
- `260721_260721-alibaba-token-plan-hardening` has implementation notes + release train plan; require measured release result or leave AMBIGUOUS/ACTIVE
