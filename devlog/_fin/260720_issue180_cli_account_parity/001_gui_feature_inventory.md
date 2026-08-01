# 001 — GUI feature inventory (research)

Source: explorer lane "Laplace" (read-only scan, 2026-07-20; anchors re-verified
against `25f3ded2`+ — note the tree kept moving during the scan). 98 feature rows.
This doc keeps the credential deep-dive verbatim-grade and condenses the rest by
page; the lane's full table lives in the session ledger.

## Credential features (issue #180 domain) — deep dive

### (a) Codex ChatGPT account pool — `gui/src/components/CodexAccountPool.tsx`

- Data: `CodexAccountEntry { id; email; plan?; isMain; hasCredential; quota: AccountQuota|null; needsReauth? }` (:11-15); quota fields incl. weekly/monthly percents + resetCredits (gui/src/codex-quota-utils.ts:1-11).
- List: GET `/api/codex-auth/accounts` (`?refresh=1` forces quota re-fetch) (:55-59).
- Next-session selection: GET `/api/codex-auth/active` → `{ activeCodexAccountId, autoSwitchThreshold? }` (:56); PUT same `{ accountId: id|null }` (:123-125). Main addressed by sentinel `"__main__"` (:121, :236-240).
- Auto-switch: GUI exposes ONLY on/off → PUT `/api/codex-auth/auto-switch { threshold: 80 | 0 }` (:164-171); threshold number not editable in GUI.
- Refresh quotas: GET accounts `?refresh=1` (refresh button in page head).
- Remove: DELETE `/api/codex-auth/accounts?id=` (:154, confirm dialog, email shown not id).
- Add / re-auth: POST `/api/codex-auth/login { id?, reauth? }` + poll `login-status` + cancel (AddCodexAccountModal.tsx:87-115, :52-71; reauth CTAs CodexAccountPool.tsx:312, :341).
- Reset credits: GET `reset-credits?accountId=` (:190-198); POST `reset-credits/consume { accountId }` → codes `reset | already_redeemed | nothing_to_reset | no_credit` (:205-215).
- Masking: emails/plans shown in clear; tokens never rendered; opaque ids never displayed in confirms/toasts.

### (b) Generic OAuth accounts — Providers page + workspace Accounts tab

- Data: `OAuthAccount { id; email?; active; needsReauth?; expiresAt? }` (Providers.tsx:26).
- List: GET `/api/oauth/accounts?provider=` → `{ activeAccountId?, accounts? }` (:164-170).
- Add: POST `/api/oauth/login { provider, addAccount: true }` (:405-414); status poll GET `/api/oauth/status?provider=` (:431).
- Switch: PUT `/api/oauth/accounts/active { provider, accountId }` (:190-196).
- Remove: DELETE `/api/oauth/accounts?provider=&id=` (:290, confirm dialog).
- Re-auth: POST `/api/oauth/login { provider, addAccount: true, accountId, reauth: true }` (:405-414; card CTA :934-939, row CTA :996-998).
- Manual code: POST `/api/oauth/login/code { provider, input }` (:514-518). Cancel: POST `/api/oauth/login/cancel` (:383-387). Logout: POST `/api/oauth/logout?provider=` (:535).
- Masking: email or localized ordinal ("Account 1") via `oauthAccountDisplayLabel` (gui/src/provider-workspace/auth.ts:31-39); raw storage ids never displayed.
- Client-side ToS gate: `oauthTosRisk` (gui/src/oauth-tos-risk.ts:13-18) forces an acknowledge modal before login POST (pure client-side).

### (c) API-key pools — Providers page + workspace Accounts tab

- Data: `ApiKeyEntry { id; label?; masked; active }` (Providers.tsx:27); `masked` produced server-side; GUI never sees raw secret after creation.
- List: GET `/api/providers/keys?name=` (:219). Add: POST `{ name, key }` (:257, password input :1040). Switch: PUT `keys/active { name, id }` (:227). Remove: DELETE `keys?name=&id=` (:244, confirm).
- Rows render `label · masked` (:1020; ProviderAuthPanel.tsx:191).

### (d) Proxy-access API keys — `gui/src/pages/ApiKeys.tsx` (separate domain)

- List GET `/api/keys` (:29, prefix only); create POST `/api/keys { name }` (:50, full key shown once :106-120); revoke DELETE `/api/keys { id }` (:67). NOT provider credentials — the proxy's own admission keys.

## Full GUI surface (condensed by page; lane table had 98 rows)

| Page / component | User-facing verbs | APIs used |
|---|---|---|
| App.tsx | toggle Claude surface, stop proxy, version badge, theme/lang (client-side) | GET/PUT /api/claude-code, POST /api/stop, GET /healthz |
| Dashboard.tsx | status/uptime, active providers, codex auto-start, sidecar/shadow-call model pick, 30d usage stat, multi-agent mode switch, injection model+effort, effort caps, models grid, sync models, update check/run | /healthz, /api/providers, /api/settings, /api/sidecar-settings, /api/shadow-call-settings, /api/usage, /api/v2, /api/injection-model, /api/effort-caps, /api/models, POST /api/sync, /api/update/* |
| Providers.tsx (classic+workspace) | config view/JSON edit, OAuth login/add/reauth/cancel/code/logout, account list/switch/remove, key list/add/switch/remove, provider add/remove/enable/disable/patch, codexAccountMode pool↔direct, quota bars | /api/config, /api/oauth/*, /api/providers*, /api/provider-quotas, /api/codex-auth/* |
| CodexAuth.tsx + CodexAccountPool | account-mode banner + full pool management above | /api/config, /api/codex-auth/* |
| Models.tsx | model list, per-model + bulk enable/disable, context caps (global/per-provider/set-all), shadow-call, ma-mode, thread limit | /api/models, /api/disabled-models, /api/provider-context-caps, /api/shadow-call-settings, /api/v2 |
| Combos.tsx + ComboWorkspace | combo create/edit/remove, targets/weights/strategy, rail search | /api/combos, /api/config, /api/models |
| Subagents.tsx | view/save subagent model picks (max 5) | GET/PUT /api/subagent-models |
| Logs.tsx | request logs 2s refresh, surface filter, row detail | GET /api/logs |
| Debug.tsx | debug flag view/toggle/reset, log streams, claude inbound capture | GET/PUT /api/debug, /api/debug/*logs, /api/claude/inbound-debug |
| Usage.tsx | usage analytics range/surface switch | GET /api/usage |
| Storage.tsx | storage report | GET /api/storage |
| ApiKeys.tsx | proxy key list/create/revoke | /api/keys |
| ClaudeCode.tsx | Claude settings save (authMode, modelMap, sidecar overrides...) | GET/PUT /api/claude-code |
| ProviderWorkspace* | rail counts/usage/quota, provider settings patch, notes | /api/selected-models, /api/usage, /api/provider-quotas, PATCH /api/providers, /api/provider-presets |

Pure client-side (no API): theme/lang, hash routing, ToS warning gate, rail
search/sort, unsaved-leave guards, quota bar coloring, usage charts computation.

## What the CLI already covers (cross-ref `002_cli_command_inventory.md`)

- `ocx status` — proxy/paths/OAuth-login summary (subset of Dashboard).
- `ocx debug` — full Debug page parity (flags + log streams).
- `ocx provider list/add/remove/show/set-default` — provider config management.
- `ocx models` — static model list (no enable/disable, no caps).
- `ocx login/logout` — first-credential OAuth/key login.
- `ocx update`, `ocx health`, `ocx doctor`, `ocx service`, `ocx v2`,
  `ocx claude`, `ocx sync`, `ocx gui`, daemon lifecycle.

## Headline gap (feeds `004_parity_matrix.md`)

ALL account/key-pool list+switch+remove verbs (a)(b)(c) have NO CLI surface:
`rg "codex-auth" src/cli/` = 0 hits. Also absent: model enable/disable + context
caps, combos, subagent picks, usage analytics, storage report, proxy API keys,
settings (auto-start/sidecar/shadow/injection/effort-caps), sync trigger, update
check parity (exists), logs view.
