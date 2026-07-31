# 260628 Windows GPT Pro follow-up slice map

## Objective
Close GPT Pro follow-up Windows release blockers on dev using repeated PABCD cycles, devlog evidence, focused verification, and atomic commits.

## Source evidence
- Review: devlog/80_windows-codex-path-hardening/16_gpt_pro_followup_review_3fe1286.md
- Prior plan: devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md
- Branch state at start: dev equals origin/dev at 3fe1286.

## Work-phase map

### Cycle 1 - P0 passthrough SSE native client body
Goal: avoid async-pull JS ReadableStream wrappers on the OpenAI/ChatGPT passthrough SSE client-facing body while retaining side-channel terminal inspection and request log finalization.
Files: src/server.ts, tests/passthrough-abort.test.ts.
Verification: targeted passthrough/server-auth tests + typecheck.

### Cycle 2 - P1 Task Scheduler XML settings
Goal: replace Windows schtasks flag-only create args with generated XML task definition containing PT0S execution limit, restart, battery, and multiple-instance settings.
Files: src/service.ts, tests/service.test.ts.
Verification: service tests + typecheck.

### Cycle 3 - P1 WebSocket lifetime policy
Goal: make Bun WebSocket idle policy explicit and test config shape/behavior.
Files: src/server.ts or extracted helper if needed, websocket tests.
Verification: websocket/server-auth tests + typecheck.

### Cycle 4 - P1 Bun runtime override and version diagnostics
Goal: add validated OPENCODEX_BUN_PATH override plus Bun/opencodex version diagnostics for status/service logging.
Files: src/bun-runtime.ts, src/service.ts, src/cli.ts, tests/bun-runtime.test.ts, tests/service.test.ts, tests/cli-help.test.ts.
Verification: focused tests + typecheck.

### Cycle 5 - P2 PID cleanup fallback
Goal: explicit stop/uninstall should log and attempt safe cleanup when pid file exists but Windows command-line identity inspection is inconclusive.
Files: src/config.ts/process-control or service helpers, tests.
Verification: focused tests + typecheck.

### Cycle 6 - P2 clone GUI docs/dev polish
Goal: conditional startup banner, dev:proxy/dev:gui scripts, gui README replacement.
Files: src/server.ts/package.json/gui/README.md/docs tests as needed.
Verification: focused tests + typecheck.

## Known debt
- src/server.ts, src/service.ts, src/cli.ts, and some tests already exceed the 500-line guideline. This goal keeps per-cycle edits small and records the debt; full file splitting is a separate refactor.
