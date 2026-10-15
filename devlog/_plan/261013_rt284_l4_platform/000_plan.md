# Lane L4 — platform issues #6853 and #6973 (2.84.0 release train)

Lane of the 2.84.0 release train. Coordinator thread `01a130be-2e10-7af0-adf9-efca9fe37e30` owns push, PRs and merges.
Lane session `01a130c8-4644-7143-8264-ae552e1d1874`, worktree `/private/tmp/rt284-lanes/L4`,
branch `codex/rt284-issues-platform` from `origin/dev` `3e58c2ce3ee5433901ed467fe87c32fb4b5c5e77`.

## Objective

Two commits, each with focused regression tests:

1. **#6853** — prove OpenCodex Desktop supervision on Windows so `ocx status`, `doctor`, `resolve`,
   `service install/repair/start/restart`, `stop` and `update` treat a Desktop-supervised runtime the way
   they already do on macOS and Linux. Design: [010](010_6853_windows_supervision.md).
2. **#6973** — discover the Codex desktop app's bundled CLI on macOS as a lowest-precedence installed
   candidate that never silently takes over a persisted selection. Design: [020](020_6973_chatgpt_app_cli.md).

## Constraints

- `src/service/desktop-supervision.mjs` is imported by the Node >= 18 launcher (`bin/ocx.mjs:12`): no Bun or
  TypeScript imports, no FFI.
- `scripts/test-layout/layout.json` is 1999 lines on dev and must stay under 2000: new entries append to an
  existing line. New test files are registered in `layout.json` `explicit` and
  `tests/fixtures/test-layout-expected.json`.
- Tests run from the lane worktree with the global Bun 1.4.0 that dev pins (`package.json` `testRunnerBun`); the
  coordinator's 1.4.3 override applies only to the union with #6986.
- No push, PR, merge, comment or release from this lane.

## Work-phase map

| Phase | Doc | Depends on | Output |
|---|---|---|---|
| wp0 | 000-020 | — | this roadmap; audited before implementation (executed inside the wp1 cycle) |
| wp1 | 010 | — | commit `fix(service): prove OpenCodex Desktop supervision on Windows (#6853)` |
| wp2 | 020 | — | commit `feat(codex): discover the Codex app's bundled CLI on macOS (#6973)` |
| wp3 | 030 | wp1, wp2 | restack onto L3, commit `test(link): classify passive-read opens by write capability`, this devlog commit, Bun 1.4.3 union verification, exact-head review |

Final lane head on L3 `d9ce24cdec`: #6853 `52ca9103f7`, #6973 `ca946248f6`, watcher `91864ee9e7`, then this devlog commit.
Reviews: #6853 PASS (pre-restack `fc9d078201`), #6973 PASS (pre-restack `88840876ad`), restacked head PASS (`9a5ca6a415`).

## Verification per phase

Focused tests named in each decade doc, then `bun run typecheck`, `tests/ci-workflows/file-size-ratchet.test.ts`,
`tests/test-layout.test.ts`, `tests/test-layout-tooling.test.ts`, `bun run structure:check`,
`bun run privacy:scan`. Real Windows/macOS-app qualification is out of reach locally; hosted Windows CI runs the
injected-snapshot tests and live qualification stays a recorded residual.


## Consultation record

- #6973: architect proposal and reflection by sol agent Huygens (`01a130ca-d372-7d52-9fae-7655f54bd445`, gpt-6.1-sol):
  proposal → 020; reflection ALIGNED with gaps, folded in 020 amendments.
- #6853: plan written by main from source evidence (no separate architect proposal — recorded gap); bounded design check
  by the same architect returned MISALIGNED with three P1 and two P2 findings, dispositioned in 010 amendments
  (one P1 rejected for lane scope with a recorded residual).

