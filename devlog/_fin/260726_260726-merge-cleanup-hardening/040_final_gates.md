# 040 — WP4: full gate verification and close-out

No source change of its own. This phase proves that the WP2 fix and the WP3 test
addition hold across the entire suite, not just the focused files each was
verified against.

## Changes entering this gate

| Commit | Change |
|--------|--------|
| `2f3fa584` | AGENTS.md / CONTRIBUTING.md branch policy: retire `claudedesktop` |
| WP2 | `src/cli/index.ts` both `handleStop` proxy catches echo the error; `tests/grok-lifecycle.test.ts` regression case |
| WP3 | `gui/tests/claude-desktop-locale.test.ts` (2 cases) |

## Gates

| # | Command | Expected |
|---|---------|----------|
| 1 | `bun run typecheck` | exit 0 |
| 2 | `bun run test` | zero failures; count at or above the 4460 baseline plus the new case |
| 3 | `gui: bun run test` | zero failures; 218 (216 baseline + 2 new) |
| 4 | `bun run lint:gui` | eslint clean |
| 5 | `bun run privacy:scan` | passes — relevant because WP2 added `console.error` of an error message |
| 6 | `bun run build:gui` | succeeds |

## Baselines to compare against

Measured earlier this session, before the hardening cycles: root suite 4460 pass
/ 0 fail across 340 files; GUI 216 pass / 0 fail across 54 files. Any new
failure is attributable to this work rather than pre-existing, since both
baselines were green on the same tree.

## Close-out

Push the hardening commits to `origin/dev` (the user authorized publishing this
work in this turn) and confirm SHA parity, then report the terminal outcome per
work-phase: WP1 DONE, WP2 DONE, WP3 NOOP-plus-guard, WP4 DONE.
