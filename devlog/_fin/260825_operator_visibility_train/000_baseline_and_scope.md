# 000 — Operator visibility train: baseline, scope, and work-phase map

Unit opened 2026-08-25. Session `01a03688-c5ee-76c2-bb0f-a7a9213345d5`.
Goalplan slug `fix-three-opencodex-operator-visibility-defects`.

## Baseline

Verified live at unit open, immediately after the v2.32.1 publish:

| Ref | SHA | Meaning |
|-----|-----|---------|
| `origin/dev` | `bb89eafbe` | devlog: pin the report to the code SHA its gates describe (#2506) |
| `origin/main` | `71c57ea64` | `release: v2.32.1` |
| `origin/preview` | `f4cb9f800` | `release: v2.32.1-preview.20260825` |

`git merge-base --is-ancestor origin/dev origin/main` exits 0, so `dev` is an
ancestor of the shipped release and this unit starts from published code.
npm `latest` is `2.32.1`, `preview` is `2.32.1-preview.20260825`.

## What this unit is

Three defects that share one shape: **OpenCodex knows the truth and does not
tell the operator.** None of them is a routing or execution bug. In all three
the runtime is already correct and the surface that reports to a human is
wrong, stale, or silent.

| # | Surface | The lie |
|---|---------|---------|
| #2457 | Management write | The picker offers Gemini, then the save rejects it as an OpenAI model |
| #2411 | `ocx status` | Green proxy while nothing routes through it |
| #2412 | Shim auto-restore | A destroyed shim returns an ineligible verdict with no message |

That shared shape is why they travel together and why none of them may be
"fixed" by changing behavior. Every fix in this unit is a reporting fix.

## Work-phase map

| Phase | Doc | Issue | Deliverable |
|-------|-----|-------|-------------|
| WP1 | this unit | — | Docs-only roadmap at diff-level precision |
| WP2 | `010` | #2457 | Submitted backend is what the pair check validates |
| WP3 | `020` | #2411 | `ocx status` prints routing and warns on unused proxy |
| WP4 | `030` | #2412 | Version-manager shim destruction is detected and reported |

One work-phase is one full PABCD cycle. WP2, WP3, and WP4 each produce one PR
against `dev`.

## Scope boundary

Out of scope, stated once so no later phase reopens it:

- Merging other contributors' PRs, or another npm release.
- `src/lab/` — the core-lab boundary test exists for a reason.
- The undeclared-tool guard, and any auth, OAuth, credential, workflow, or
  release-automation surface.
- Auto-wrapping a version-manager-owned `codex` binary as a new original.
  This is the one that is tempting and wrong; see `030`.
- The Codex-side namespaced-model error message in #2411's reproduction. That
  is upstream copy, not ours.

## Evidence rule

A remembered pass is not evidence. Every completion claim in this unit carries
exact command output, the PR number and head SHA, and the CI run id and
conclusion on that SHA.

## Prior art consulted

- `260824_v2_32_1_hotfix_train/` — the freeze/GO discipline this unit inherits.
- `tests/repo-hygiene.test.ts` — no gitlinks, no vendored clones.
- `AGENTS.md` — focused checks during implementation, full suite before a
  non-trivial PR goes review-ready.
