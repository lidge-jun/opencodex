# 000 — Plan: open bug issue/PR triage (docs-only)

Unit: `260813_open_bug_issue_pr_triage`  
Cutoff: 2026-08-13 live GitHub fetch against `lidge-jun/opencodex`  
Baseline tree: worktree HEAD `570347304` (`Merge pull request #1596 ...`)  
Mode: docs-only / no code patches / no issue-PR mutations / no push

## Objective

Record every currently open **bug-related** issue and PR, classify it, rank what is prioritizable, and explain the result in plain Korean a child can understand.

## Why this unit exists

Open inventory at cutoff:

| Surface | Count |
|---|---:|
| Open issues | 70 |
| Open issues with `bug` label | 23 |
| Broader bug-candidate issues (label + title/symptom + compat-failure) | 33 before false-positive cull |
| Open PRs | 26 |
| Open bug/`fix(*)` PRs | 10 |

Past campaigns (`260805_bug_stack_campaign`, `260808_bug_campaign`, `260812_five_bug_fix_campaign`) already fixed many items. This unit freezes **today's remaining** open bug surface so prioritization is not based on memory.

## Scope

### IN

- Live inventory of open issues/PRs
- Classification: `BUG` / `LIKELY-BUG` / `NOT-BUG` / `NEEDS-INFO` / `UPSTREAM` / `DUPLICATE` / `ARCHITECTURE` / `TRACKING`
- Priority ranking P0–P4 for prioritizable defects
- Public-safe numbered docs under this unit
- Child-friendly Korean summary

### OUT

- Production code patches
- Merges, pushes, labels, comments, closes
- Security pre-disclosure writeups in tracked paths
- Feature/enhancement implementation work

## Priority scale used

Not effort buckets. Rank by:

1. **Severity** — process death / hard block / wrong answer / silent wrongness / CI noise
2. **Blast radius** — host service, Windows locale majority path, one provider, one GUI widget
3. **Evidence quality** — repro + code pointer > screenshots only > anecdote
4. **Fixability / readiness** — open green PR > draft PR > ready branch > needs design > needs reporter artifact

| Rank | Meaning |
|---|---|
| P0 | Host/proxy totally down for many users, confirmed, fixable now |
| P1 | Hard block or confirmed high-impact product break; ship/review soon |
| P2 | Real defect or costly wrongness; can wait behind P1 if needed |
| P3 | CI flake, UX mislabel, duplicate residual, low-urgency design debt |
| P4 | Tracking / upstream / cannot act without external change |

## Work-phase map (docs-first single cycle)

This goal is intentionally **one docs-only work-phase**. Implementation of ranked bugs is a later user-authorized unit.

| Doc | Purpose |
|---|---|
| `000_plan.md` | This plan |
| `001_live_inventory.md` | Raw live counts + candidate set |
| `002_disposition_matrix.md` | Per-item class + evidence |
| `003_priority_ranking.md` | Ordered prioritizable queue + PR review queue |
| `004_simple_korean_explainer.md` | Child-friendly explanation |
| `005_ranking_snapshot.json` | Machine-readable queue snapshot |
| `006_audit_synthesis.md` | Independent + main audit evidence |
| `010_landing_round.md` | What actually landed in the evening round + per-PR dispositions |
| `011_remaining_simple_korean.md` | Child-level Korean explanation of the REMAINING surface |

## Amendment (2026-08-13 evening)

The docs-only scope above describes the morning cycle. The user then authorized landing
work: merge the legitimately mergeable PRs (rebasing/repairing them ourselves where
needed), ship the Moonshot China fix, dedupe the issues, and re-explain what remains.
That round is recorded in `010`/`011`; `001`–`006` are left as the morning snapshot
rather than rewritten, so the before/after contrast stays readable.

## Loop-spec

- Loop archetype: satisfy-spec inventory
- Trigger: user asked for open bug issue/PR triage via `cxc-loop`, recorded in devlog, prioritized, explained simply
- Goal: durable triage unit + ranking + simple Korean explanation
- Non-goals: fixing, merging, commenting
- Verifier: files exist under unit; every open bug-labeled issue appears; every open bug/`fix(*)` PR appears; ranking is evidence-backed
- Stop: docs complete + audit pass/near-pass
- Expected terminal: `DONE` (docs) or `BLOCKED` (GitHub unavailable)

## False-positive policy

Keyword matches that are features stay `NOT-BUG` even if the title contains "fail" or "crash-safe". Dual-labeled architecture issues stay `ARCHITECTURE` unless a live user-facing break is proven.
