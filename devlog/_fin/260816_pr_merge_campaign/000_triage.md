# 000 — Nine-PR merge campaign: triage and merge order

## Scope

Nine open PRs the user marked ready for final review and merge, plus a direct
implementation of #1797 pushed to `dev`.

## Why every PR reports BLOCKED

This was the first thing to establish, because "BLOCKED" invites the assumption
that CI is red. It is not.

| PR | reviewDecision | Failing checks | Real blocker |
|----|----------------|----------------|--------------|
| #1727 | REVIEW_REQUIRED | none | awaiting approval |
| #1728 | REVIEW_REQUIRED | `label` CANCELLED | awaiting approval |
| #1729 | REVIEW_REQUIRED | none | awaiting approval + stacked base |
| #1732 | REVIEW_REQUIRED | none | awaiting approval + stacked base |
| #1740 | REVIEW_REQUIRED | none | awaiting approval |
| #1750 | REVIEW_REQUIRED | none | awaiting approval |
| #1764 | REVIEW_REQUIRED | none | awaiting approval |
| #1793 | **CHANGES_REQUESTED** | `label`, `enforce-target` CANCELLED | requested changes must be resolved |
| #1799 | REVIEW_REQUIRED | `macos` pending | **5 unresolved CodeRabbit threads** |

Eight of nine are gated purely on approval. Only two carry real work:
`#1793` has a CHANGES_REQUESTED review, and `#1799` (my own unit) has five
unresolved review threads including one Major.

The `macos` job is a pre-existing Bun segfault that also fails on unmodified
`dev` (run 31902897010), so it is not a per-PR blocker.

## Surface and risk

| PR | Size | Surface | Risk |
|----|------|---------|------|
| #1727 | +1750/-7, 18 files | new `src/codex/log-guard/`, CLI, GUI, docs | additive; new subsystem |
| #1729 | +2753/-124, 28 files | extends log-guard; touches `src/codex/app-server-processes.ts` | larger, touches existing runtime |
| #1732 | +1636/-15, 13 files | log-guard maintenance + management context | additive on the chain |
| #1728 | +649/-29, 25 files | subagent surface, i18n across 5 locales, docs | behavioral: model-version routing |
| #1793 | +575/-26, 14 files | `slug-codec.ts`, `model-discovery.ts`, `router.ts`, `registry.ts` | **overlaps #1799** |
| #1740 | +1030/-240, 4 files | `release.yml`, changelog builder | release automation — security-review surface |
| #1750 | +116/-16, 12 files | `.github/scripts/*`, `src/codex/*` | CI scripts + small runtime fixes |
| #1764 | +700/-15, 6 files | issue-triage workflows and scripts | CI-only |
| #1799 | +1957/-22, 16 files | `capability.ts`, `effort.ts`, `parsing.ts`, `provider-fetch.ts` | **overlaps #1793** |

## Conflict found during triage

`#1793` and `#1799` both modify `src/providers/model-discovery.ts`, and `#1793` also
rewrites `src/providers/slug-codec.ts` — the module #1799's design deliberately
avoided importing. Whichever lands second must rebase and re-verify rather than
trusting a clean auto-merge. This is the single ordering constraint that is not
visible from the PR list alone.

## Merge order (dependency-first, not effort-first)

1. **#1799** — my own unit; its five threads are mine to close, and landing it
   first fixes the shared `model-discovery.ts` baseline that #1793 must rebase on.
2. **#1727 -> #1729 -> #1732** — forced stack. `#1729` targets
   `feat/codex-log-guard-inspect` (head of #1727) and `#1732` targets
   `feat/codex-log-guard-protect` (head of #1729). Each child is retargeted to
   `dev` after its parent lands, per AGENTS.md.
3. **#1793** — after #1799, rebased onto the new `model-discovery.ts`, with its
   CHANGES_REQUESTED review resolved.
4. **#1728** — independent surface (subagent routing + i18n).
5. **#1750**, **#1764** — CI/script surface, mutually independent.
6. **#1740** — release automation LAST: it edits `.github/workflows/release.yml`,
   which AGENTS.md flags as a highest-priority security-review surface. Landing it
   after everything else keeps the release path stable while the rest merge.

## Method per PR

One PABCD cycle each: read the real diff, run the checks that cover it, dispatch
an independent `gpt-5.6-sol` explorer, fold every finding, then merge. Bypass of
the approval gate is authorized by the user; each bypass is recorded with what
was bypassed and why it was safe.
