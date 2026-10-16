# 050 — Delivery: stacked PR chain (work-phase wp5)

## Chain

Four branches, each based on the previous one's head, all eventually targeting `dev`:

| PR | branch | base | content |
|---|---|---|---|
| 1 | `codex/provider-catalog-plan` | `dev` | this plan unit |
| 2 | `codex/provider-catalog-local-tab` | PR 1 head | R3 (`020`) |
| 3 | `codex/provider-catalog-note-popup` | PR 2 head | R2 (`030`) |
| 4 | `codex/provider-catalog-unified-search` | PR 3 head | R1 (`040`) |

Ordinary dependent PRs, not a GitHub native stack. `enforce-target` skips the
wrong-base gate for a child whose base is another open PR's head; each child is
retargeted to `dev` once its parent lands.

## Rules carried from the request

- Every push is `--no-verify`.
- No local test suite, typecheck, or build runs in this worktree. Local checks are
  reported as NOT RUN; remote CI on each PR's final head is the evidence.
- Every PR fills `.github/PULL_REQUEST_TEMPLATE.md` in full. PRs 2-4 mention `gui`, so
  each needs a screenshot of the UI change in its description.

## Screenshot capture

The proxy is already running on `http://localhost:10100`, so the GUI change can be
driven in a browser against a dev build of the dashboard for the required screenshots.
