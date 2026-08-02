# wt1 — Update path + star-prompt leakage (research)

Worktree: `/Users/jun/.codex/worktrees/260802-wt1-update-path` (branch `codex/wt1-update-path`, off `dev`).
This unit is docs-first preparation; the executing session re-verifies every claim at its own P before building.

## Scope

Three bugs in the install/update/prompt surface, all must-fix regardless of PR quality:

### Bug A — PR #871: preview installs cannot update to stable

- Evidence: PR #871 (`fix(update): allow stable updates from older previews`).
- Root cause: an installed preview such as `2.8.2-preview.20260731` cannot be parsed by the stable-only current-version branch of the update comparator, so with npm `latest` at `2.9.1`, `isNewer()` returns `false` and the dashboard reports `already_latest`, disabling one-click update.
- Grounding: `src/update/notify.ts` (`isNewer`, `readVersionCache`), consumed by `src/update/badge.ts:69` (`updateAvailable: isNewer(cache.latest_version, current, channel)`).
- Severity: high — the update path silently bricks itself for every preview-channel user once a stable supersedes their build.
- Fix shape (from PR, re-verify): compare an installed preview by its `major.minor.patch` core when the selected channel is `latest`; keep the latest-channel target strict (a preview registry target is never accepted as a stable update).

### Bug B — Issue #879: star-prompt agent deferral leaks into every editing session

- Evidence: issue #879, filed 2026-08-02 after user report ("shows during editing, not just install").
- Root cause (three compounding decisions, verified in code):
  1. `src/cli/star-prompt.ts` leaves the `.star-prompted` marker unwritten on the agent path, so every agent-driven `ocx start` re-prints `printAgentDeferral()` — no deferral marker, counter, or cooldown.
  2. The deferral text recruits the agent as an unbounded relay ("put the same Yes/No question at the top of your next reply, unchanged"); AGENTS.md repeats the repeat-forever rule, so one `ocx start` hijacks every later reply.
  3. Agent PTYs pass the TTY gate, so the deferral fires on routine edit/test cycles.
- Grounding: `src/cli/star-prompt.ts` (`MARKER`, `printAgentDeferral`, `maybeShowStarPrompt`), `src/cli/agent-driven.ts` (env detection), callers `src/cli/index.ts:317` and `src/service.ts:2468`, consumer of marker semantics `src/update/notify.ts:135`, tests `tests/startup-prompt.test.ts`, `tests/agent-driven.test.ts`, `tests/sidebar-routes.test.ts`.
- Severity: medium — degrades every agent-assisted session and trains users to dismiss a consent question.
- Constraint (must keep): an agent never answers or auto-dismisses; only the account owner stars; `403 agent_consent_required` on `POST /api/github/star` stays untouched.

### Bug C (should-fix, same subsystem) — PR #557: npm cache recovery hardening

- Maintainer-takeover draft for #533: fail closed when the npm cache is same-UID but not effectively readable/writable before any proxy stop path; sanitize persisted update-job command/log/error fields (raw home/cache paths, uid/gid).
- Include only if wt1 capacity allows after A and B land; otherwise leave for maintainer review.

## Claim ledger

| # | Claim | Source | Status |
|---|-------|--------|--------|
| 1 | `isNewer()` stable-only parse rejects `2.8.2-preview.*` current versions | PR #871 body + `src/update/notify.ts` | code-verified |
| 2 | Marker unwritten on agent path; deferral re-arms every agent start | `src/cli/star-prompt.ts` | code-verified |
| 3 | npm semver/dist-tag behavior for preview vs stable channels | Luna lane (not dispatched — covered by repo comparator code) | n/a |

## Out of scope

- Changing the consent invariant (agent never stars; user-only prompt).
- Pushing anything; each worktree session commits locally and asks before push.
