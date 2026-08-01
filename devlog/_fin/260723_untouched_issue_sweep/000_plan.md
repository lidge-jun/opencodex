# 260723 Untouched Issue Sweep

## Objective

Triage and fix 7 GitHub issues that have no maintainer review or comment.
Three require code fixes (#322, #327, #323); four need English triage comments
(#320, #324, #326, #294).

## Constraints

- Branch: `codex/260723-untouched-issue-sweep-2`
- Local commits only (no push without approval)
- No gui/ changes without explicit approval
- All GitHub comments in English, evidence-backed
- `bun run typecheck` + `bun run test` + `bun run privacy:scan` must stay green

## Work-Phase Map (dependency-ordered)

| Phase | Decade | Title | Dependencies |
|-------|--------|-------|-------------|
| WP0 | 000-009 | Docs-first roadmap | None |
| WP1 | 010 | Fix #322: shim first-arg bypass | WP0 |
| WP2 | 020 | Fix #327: __main__ needsReauth | WP0 |
| WP3 | 030 | Fix #323: reasoning_summary compat | WP0 |
| WP4 | 040 | Triage comments #320/#324/#326/#294 | WP0 |

WP1-WP3 are independent of each other (disjoint file sets).
WP4 is pure GitHub comments, no code changes.

## Success Criteria

- c1-roadmap: All decade docs written to diff-level
- c2-322-fix: Shim bypass works with flags before subcommand + regression test
- c3-327-fix: __main__ DTO includes needsReauth + 401/403 marks reauth + test
- c4-323-fix: reasoning_summary not sent for unsupported models + test
- c5-triage: English comments posted on #320, #324, #326, #294
