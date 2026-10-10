# wp8 audit r1 — synthesis

Reviewer: grok-4.6 subagent (Poincare). Verdict near-pass; all findings adopted:
- All `applyProxyEnv` callers are synchronous (`src/server/index.ts:641`, `src/codex/sync.ts:126/146/199`); a sync `reg.exe` read with argv `execFileSync`, `windowsHide`, 2s timeout mirrors `src/tray/windows.ts:361`. No await in `startServer`.
- Defer ProxyOverride: separators and `<local>` semantics differ from NO_PROXY; second policy.
- Logs: host:port only, userinfo stripped; doctor already never prints values.
- Tests inject the reader; CI never spawns `reg.exe`.
- Schema: passthrough, JSDoc only; an enum would start backing up configs.

