# 260629 — PR & Issue Review (Documentation Phase)

**Branch:** `feat/kiro-on-dev`
**Constraint:** Documentation phase only. NO source code modification.
The only permitted code/git action is cherry-picking clean PRs into the current
branch with original author attribution preserved.

## Scope

### PRs (open)
| # | Author | Title | Base | State |
|---|--------|-------|------|-------|
| 40 | 0disoft (ZeroDi) | fix(gui): format dashboard uptime for readability | dev | MERGEABLE / CLEAN |

**PR #40 decision:** clean, small (3 files, +60/-3), self-tested. Verified the
current branch's `gui/src/i18n/index.tsx` exports `useI18n` + `Locale` and
`useI18n()` returns `{ locale, setLocale, t }`, so the `useT → useI18n`
migration in the PR is compatible. → **cherry-pick into `feat/kiro-on-dev`**,
preserving author `0disoft`.

### Issues (open) → one `issue_nnn_name/` folder each
| # | Author | Title (short) |
|---|--------|---------------|
| 45 | Rezhnn | Reasoning tokens not expanding in Codex UI ("Worked for X" but no trace) |
| 44 | 0disoft | Request logs can miss successful ChatGPT native passthrough turns |
| 43 | 0disoft | Diagnose stale Codex bundled plugin marketplace after app updates |
| 42 | 0disoft | Add Storage page for Codex session usage and cleanup policy |
| 41 | DomineYH | glm-5.2[1m] upstream 400 "Unknown Model" — bracketed 1M suffix forwarded |
| 17 | 0disoft | Mobile-created Codex threads may bypass local opencodex proxy |

## Method per issue
1. Read the full issue body + comments via `gh issue view`.
2. Locate the relevant code paths in the repo (read-only).
3. Use the search skill where external/behavioral facts are needed.
4. Write `devlog/_plan/issue_nnn_name/00_review.md` with:
   - Summary of the report
   - Root-cause analysis (with file:line references)
   - Concrete solution (no code applied — described only)
   - Verification approach / test idea
   - Effort & risk estimate

## Phases
- **B1:** cherry-pick PR #40 (the one code action) + verify build green.
- **B2:** research + document each of the 6 issues.
- **C:** confirm working tree clean except docs + cherry-pick; run focused build check.
- **D:** summary.
