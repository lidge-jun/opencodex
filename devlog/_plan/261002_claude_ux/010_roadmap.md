# 261002 Claude UX — roadmap (010)

Three outcomes, four work-phases (wp1 = this roadmap).

| wp | Unit | Doc | Branch |
| --- | --- | --- | --- |
| wp2 | Start the Claude intercept pair on demand instead of asking for a restart | 020 | `codex/claude-intercept-on-demand` |
| wp3 | Top-level Claude page under Codex: Account / Code / Desktop / Settings | 030 | `codex/gui-claude-page` |
| wp4 | Local OpenCodex.app rebuild from merged dev, install handed to the user | 040 | none |

## Evidence

- `startClaudeIntercept` (src/claude/intercept/runtime.ts) runs once, from `createClaudeInterceptLifecycle().start` in
  src/server/index/optional-listeners.ts at `startServer`. It resolves `null` when Claude routing is off
  (`claudeCode.enabled === false`), the intercept is disabled, the role is `client`, or the public port is ephemeral, and a
  bind failure only warns. Nothing starts it later, so `getClaudeInterceptState()` stays `null` for the life of the process.
- The CLI first-party toggle (`PUT /api/claude-code {cliFirstParty}`, agent-settings-routes.ts:1557) then refuses with
  `intercept_unavailable` ("…restart needed"), and the Desktop panel shows `claudeDesktop.firstParty.proxyStopped`:
  "로컬 프록시 127.0.0.1:{port}가 실행 중이 아님 — OpenCodex 재시작". `claude.firstParty.disabled` also tells the user to restart.
  The live user config has `claudeCode.enabled: false`, `desktopMode: first-party`, which reproduces it.
- The Desktop picker controller and runtime are created inside `startClaudeIntercept` only, so the picker is also absent.

## Order

wp2 and wp3 are independent and run in parallel lanes (separate worktrees). wp3 rebases after wp2 merges if both touch
ClaudeCode/ClaudeDesktop copy. wp4 needs both merged.

