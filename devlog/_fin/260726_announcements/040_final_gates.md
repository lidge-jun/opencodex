# 040 — WP-E: full gates and close-out

No source change of its own.

## Gates

| # | Command | Expected |
|---|---------|----------|
| 1 | `bun run typecheck` | exit 0 |
| 2 | `bun run test` | zero failures, at or above baseline plus the new cases |
| 3 | `gui: bun run test` | zero failures |
| 4 | `bun run lint:gui` | eslint clean |
| 5 | `bun run privacy:scan` | passes |
| 6 | `bun run build:gui` | succeeds |

Baseline measured this session after the GUI/Grok unit: root 4516 pass across 343
files, GUI 232 pass across 58 files.

## The check a green suite cannot make

Every gate can pass while the feature is still wrong in the way that matters, so
confirm explicitly before closing:

- `ANNOUNCEMENTS` is still EMPTY at merge. A populated catalog means the release
  that introduces the system also backfills with it — the exact outcome rule 2
  forbids.
- No `info` announcement can reach the modal path.
- Onboarding does not fire for an existing user upgrading in.

## Push

NOT automatic (LOOP-GIT-01). Commit per work-phase, then ask.
