# 070 — wp7: #6765 desktop hint, and maintainer reports

## 7a — #6765 stalled-update fallback hint

PR title: `fix(desktop): point to a manual download when an update install fails`.
Worktree `.tmp/lanes/L7-ci-infra-7`. Credit: `Co-authored-by` Yum-wu (commit identity from the source PR).
L1 owns desktop runtime ownership; this change touches only `desktop/ui/update.html` text and
docs. Before building, check the L1 lane's open PR for `desktop/ui/update.html` edits; if it
touches the file, rebase on it or hand the hunk to L1.

| Path | Change |
| --- | --- |
| desktop/ui/update.html | PR :68-75 hint via `textContent`; show it only for install/download failures with a known `latestVersion`, not for `return_to_dashboard` errors; link to the version's GitHub release page |
| docs-site/src/content/docs/troubleshooting/update-failed.md | move the new desktop section after the complete npm-cache section (it currently splits it at :100 and captures :125-137); say to stop the proxy through its owner (app/service), with `Get-Process` only to find it |
| tests/clients/desktop-update-surface.test.ts | assertions: hint present for failed install with a known version; absent without a version; absent for unrelated navigation errors |
| structure/desktop-shell.md | one line on the fallback hint |

Acceptance: the surface test, docs build, typecheck; exact-head CI green.

## 7b — reports only (no carry)

- **#6472 (copilot Auto):** human credential/session security review, guardrail decisions
  (512 models, 1 MiB, 8 s, 32768 units, 32-entry/60 s caches) and live Student acceptance are
  open; `core.ts` would sit at 210/210. Recommend a maintainer-owned provider lane.
- **#6654 (Ollama late-tool attribution):** decide whether to accept a fixed 262144-byte
  per-request cap on generated attribution captions that turns some currently accepted
  histories into HTTP 413, ask for a different or configurable bound, or defer.
  The accounting itself (`src/lib/json-byte-size.ts`) reviewed clean; its CI is green on
  Linux/static (17 jobs).
