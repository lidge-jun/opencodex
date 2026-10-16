# wp12 — #695 generic OAuth pool: slice 1 = pool-settings capability contract

Issue #695 (score 69). Reviewer order: (a) per-account Antigravity quota (#1082, landed ef7b3c9cf);
(b) generalize pool-settings API + CLI through a provider capability contract; (c) selector consumes
the evidence. Investigation by grok subagent (Fermat); see 121.

## Slice 1 (this cycle): reviewer step (b) only
- `src/oauth/pool-settings-capability.ts` (new): `poolSettingsCapability(name, provider)` →
  `"codex" | "anthropic" | "generic" | null`; generic = `isGenericFailoverProvider`.
- `src/types/provider.ts`: `oauthAccountFailover: { enabled?, strategy?: "quota"|"round-robin"|"fill-first", autoSwitchThreshold?: 0..100 }`.
- `src/server/management/oauth-account-routes.ts` GET/PUT `/api/oauth/accounts/pool`: admit generic
  providers; storage `providers.<name>.oauthAccountFailover`; Anthropic path byte-identical.
- `src/cli/account-extended.ts`: `poolTransportFor` + `cmdAutoSwitch` consult the capability.
- Docs: providers.md `oauthAccountFailover` section.
- Stored generic settings are inert in this slice (selector unchanged) and documented as such.

## Deferred (issue stays open with a written slice list)
Session affinity, classified 401/403 failover, strategy consumption, 95% preemption, stickyLimit,
selection reasons, cooldown re-probe, GUI.

## Acceptance
- Codex/Anthropic pool routes and CLI unchanged (existing tests green).
- GET/PUT for google-antigravity round-trips strategy/autoSwitchThreshold/enabled; validation 400s;
  api-key provider still 400.
- CLI `ocx account strategy google-antigravity quota` and `auto-switch google-antigravity 90` send the PUT.
- tsc, privacy, focused tests.

