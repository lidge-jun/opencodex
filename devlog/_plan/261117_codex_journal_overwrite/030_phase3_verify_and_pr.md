# 030 — Phase 3: verification, PR, CI (wp4)

1. Final head gates, each recorded with exit code: `bun run typecheck`; the focused files from 010/020; `bun run test:changed`; `bun run structure:check`; `bun run privacy:scan`. `test:changed` follows the import graph and cannot see the child runner, so the two new files are run explicitly.
2. Full local `bun run test` only if resources allow (macOS host, concurrent worktrees); otherwise record why on the NOT RUN line and rely on the ci:full Ubuntu shards.
3. Issue: search open issues for an existing one covering restore reverting later config.toml edits / app rewrites of injected keys; open one with `.github/ISSUE_TEMPLATE/bug_report.yml` headings only if none covers it.
4. Push `fix/codex-journal-overwrite`; open one PR to `dev` filling every section of `.github/PULL_REQUEST_TEMPLATE.md` (no `gui/` change, so no screenshot); add the `ci:full` label before the final push; `goat_pull_request_link`.
5. Report the exact-head check results (gates + four Ubuntu shards) without dispatching `lane=all`.
6. `origin.report` completed with C1–C6 evidence, subagent models, NOT RUN, residual risk.
