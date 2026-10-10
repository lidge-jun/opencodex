# 020 Audit fold

Reviewer verdict: NEAR-PASS (independent subagent, read-only). Folded:

1. Registry readiness — new `src/claude/desktop-3p-startup.ts`: `initDesktop3pRegistry(config)` (deduped, startup inputs incl.
   entitlements) replaces the inline block in `src/cli/index.ts`; the CLI loader awaits it when the registry is empty.
   Served rows are re-filtered against the live registry at response time.
2. Bootstrap — the listener consults the catalog hook before the relay-native shortcut; bootstrap eligibility is
   `desired.cli` only (its `claude-code/<v>` UA carries no entrypoint); upstream stays the route-selected one
   (`CLAUDE_INTERCEPT_UPSTREAM` for unknown clients).
3. cc rewrite only for clients classified `cli` with `desired.cli`; Desktop entrypoints untouched (test).
4. Cache invalidation lives in `settings.ts` apply/remove (on change) and in `reconcileClaudeFirstPartySettings` (every ok
   reconcile), covering the toggle route, ensure, disable and rollback paths. agent-settings-routes.ts is not touched.
5. Logs carry kind/status/counts only. 8. CLI hook wired from `loadPickerRoutes`, independent of the Desktop picker.
10. Desktop bootstrap output regression test. 13. Risk: `additionalModelOptionsCache` in `~/.claude.json` keeps
   bootstrap rows until the CLI's next bootstrap fetch (every launch).
Not folded: 7 (error text) — documented instead.

