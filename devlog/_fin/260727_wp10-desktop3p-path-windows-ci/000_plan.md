# 000 — wp10-desktop3p-path-windows-ci: Plan

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

Fix the current `origin/dev` Windows CI regression that blocks safe rerun/merge
of PR #526. Hosted CI for PR #526 head
`64624712aaf5fd1ef5a18167bee373c5fed63457` failed only on `windows-latest` in
`Claude Desktop 3P models > resolves the actual cross-platform Claude Desktop
config library (#539)`: expected `/profiles/claude/configLibrary`, received
`\profiles\claude\configLibrary`.

Evidence base:

- PR #526 diff is catalog sync/write-signal only and does not touch Desktop 3P
  path logic.
- `origin/dev@ff831858388179d3f76f4dd7c119d84470214fa6` contains
  `src/claude/desktop-3p-paths.ts`, whose resolver imports host
  `node:path.join`. On a Windows host, that converts POSIX profile override
  inputs used for `platform: "darwin"` / `platform: "linux"` test cases into
  backslash paths.
- `tests/desktop-3p.test.ts` expects target-platform behavior for non-Windows
  platforms, but the implementation currently follows the host OS separator.

## Loop-spec

- Loop archetype: spec-satisfaction repair. The verifier is the targeted Bun
  test suite plus hosted GitHub Actions on a fresh PR.
- Write scope: `src/claude/desktop-3p-paths.ts`,
  `tests/desktop-3p.test.ts`, and `tests/claude-desktop-config-path.test.ts`
  only. Devlog/goalplan updates are recorded in the live-triage worktree.
- Out-of-scope: provider behavior, auth/security, GUI/UX, main/preview/release
  branches, and any changes to PR #526's catalog-write semantics.
- Budget / bounds: one focused implementation attempt, one reviewer audit
  round unless the reviewer finds a high blocker, local targeted tests +
  `bun x tsc --noEmit`, then push a dev-target PR and wait for hosted CI.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP10 | `010_phase1.md` | Make Desktop 3P config-library path resolution target-platform-specific instead of host-OS-specific, and lock the CI failure with regression tests. | WP9 gitlink checkout fix merged to `origin/dev@ff831858` |

## Accept criteria

- `resolveClaudeDesktop3PConfigLibraryDir` trims explicit
  `OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` surrounding whitespace, then preserves
  the override without joining or target-platform normalization.
- With `CLAUDE_USER_DATA_DIR: "/profiles/claude"` and `platform: "darwin"` or
  `"linux"`, the resolver returns `/profiles/claude/configLibrary` even when
  executed on Windows.
- With `platform: "win32"` and Windows environment paths, the resolver returns
  Windows-style paths.
- Local checks pass:
  `bun test tests/desktop-3p.test.ts tests/claude-desktop-config-path.test.ts`,
  `bun x tsc --noEmit`, and `git diff --check origin/dev`.
- A dev-target PR is pushed and the latest hosted checks are green before merge.
