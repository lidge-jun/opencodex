# GPT Pro Result: Windows User Reports

## Session

- Session ID: `01KW43HHFMK6MC8N31M0E6GDAJ`
- Conversation: https://chatgpt.com/c/6a3f8b7a-77dc-83e8-bb3e-2c030b486539
- Reviewed branch/commit: `origin/dev` at `929d756314761da1b82107bc0314a5fd290cd7ff`

## Verdict

The pushed lifecycle patch is necessary but not sufficient.

- It plausibly fixes the narrow explicit lifecycle bug: direct `ocx service stop` / `ocx service uninstall` now stop the Task Scheduler wrapper and kill the tracked proxy PID before restoring native Codex or deleting service assets.
- It should not be treated as the fix for the new community report: "the proxy keeps stopping while I use it, very frequently, on any PC". That report is likely about runtime streaming/WebSocket lifetime, Bun crash behavior, scheduler restart settings, or missing diagnostics.

## Release-blocking Windows hotfix items

1. Data-plane lifetime hardening
   - `src/server.ts` sets Bun `idleTimeout: 255` and the async fetch handler does not use Bun's per-request timeout escape hatch.
   - Long-lived `/v1/responses` SSE and WebSocket sessions can have quiet periods.
   - Add no-timeout handling for long-lived `/v1/responses` requests and explicit WebSocket idle behavior.

2. Windows Task Scheduler hardening and logging
   - Current Windows service uses a `.cmd` loop and bare `schtasks /create` flags.
   - It lacks explicit indefinite runtime, restart-on-failure, start-when-available, battery behavior, multiple-instance behavior, and useful service logs.
   - Replace bare scheduler setup with XML or PowerShell scheduled-task registration and add timestamped child start/exit/restart/runtime logs.

3. Bun runtime diagnostics / mitigation
   - Current dependency is Bun 1.3.14.
   - GPT Pro found external evidence of an opencodex Windows 11 Bun 1.3.14 native crash class and noted the repo already has a Bun Windows streaming-crash workaround comment.
   - Add Windows startup diagnostics for Bun path/version and a supported runtime override. Do not silently switch all users to canary without Windows smoke validation.

## Strongly recommended

4. PID cleanup robustness
   - Current lifecycle cleanup depends on `readPid()` accepting the PID after command-line identity inspection.
   - On Windows, PowerShell/CIM command-line inspection can fail or time out.
   - Keep strict identity checks for status/reporting, but make explicit stop/uninstall attempt safe best-effort cleanup when the PID file exists and identity inspection is unavailable.

5. Better Windows service diagnostics
   - Print or expose the service log path from `ocx service status`.
   - Log child exit code, restart decision, Bun path/version, and config/CODEX_HOME.

## Docs/dev-experience items

6. Clone + `bun run dev` GUI clarification
   - Root `bun run dev` starts the proxy backend only.
   - GUI dev is separate (`cd gui && bun run dev`) or requires a built bundled dashboard (`bun run build:gui`).
   - README.md, README.ko.md, and gui/README.md need project-specific instructions.

7. Runtime UX for missing GUI build
   - Startup banner currently always prints `GET / -> GUI dashboard`.
   - Make it conditional: if `gui/dist/index.html` exists, print dashboard; otherwise print setup/help fallback and exact dev commands.
   - Expand `rootFallbackPayload()` with clone/dev commands.

## Suggested patch sequence

1. Patch data-plane lifetime hardening with tests for delayed SSE and explicit WebSocket idle policy.
2. Patch Windows scheduled task XML/settings and service wrapper logging with static tests plus manual Windows smoke checklist.
3. Add Bun runtime path/version diagnostics and override path support.
4. Improve PID cleanup fallback for explicit stop/uninstall.
5. Improve clone/dev GUI docs and root fallback/banner messaging.

## Release decision

Do not close the Windows frequent-stopping report with commit `929d756` alone. Close only the explicit stop/uninstall orphan-process issue with that patch.

For a credible Windows hotfix, ship at least patches 1 and 2. Patch 3 should be included if possible because without runtime/version logs the next report will still be hard to triage. Patch 5 is low-risk and can ship with the hotfix as dev-experience/documentation.
