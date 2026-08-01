# 003 — Management API credential contracts (research)

Source: explorer lane "Faraday" (read-only repo scan, 2026-07-20). Anchors are
verbatim `path:line`. All routes are served by the proxy process; every `/api/*`
request passes `requireApiAuth(req, config, "management")` (src/server/index.ts:236)
and an origin/host check (src/server/management-api.ts:180-182, 403 on cross-origin).
Errors are JSON `{ "error": string }` (codex-auth sometimes adds `code`/`reason`).

## Client auth + port resolution (what the CLI needs)

- Loopback bind (default 127.0.0.1): `isApiAuthRequired` false
  (src/server/auth-cors.ts:114-116) → no token needed; CLI must send a loopback
  Host and no foreign Origin (src/server/auth-cors.ts:55-73).
- Non-loopback bind: client must send `x-opencodex-api-key` / `Authorization: Bearer`
  / `x-api-key` matching `OPENCODEX_API_AUTH_TOKEN` or a `config.apiKeys` entry
  (src/server/auth-cors.ts:156-163, 125-143). Existing CLI convention:
  `runningProxyUpdateHeaders()` (src/oauth/login-cli.ts:9-14) injects the env token.
- Port ladder (canonical): `findLiveProxy()` (src/server/proxy-liveness.ts:93-144) =
  pid file (`readAlivePid`, src/config.ts:846-857) → `runtime-port.json`
  (`readRuntimePort`, src/config.ts:750-759) → `/healthz` identity probe
  (`isOpencodexHealthz`, src/server/proxy-liveness.ts:59-65) → `config.port ?? 10100`
  fallback. Config dir: `OPENCODEX_HOME` or `~/.opencodex` (src/config.ts:268-274).

## Family A — Codex (ChatGPT) account pool

Routed at src/server/management-api.ts:1622-1623 → `handleCodexAuthAPI`
(src/codex/auth-api.ts:380). Main Codex App login id = `__main__`
(`MAIN_CODEX_ACCOUNT_ID`, src/codex/main-account.ts:11). Pool ids match
`^[a-zA-Z0-9._-]{1,64}$` (src/codex/auth-api.ts:43). Tokens never leave the server;
emails masked via `maskEmail` (src/lib/privacy.ts:1-12).

| Endpoint | Shape / semantics | Anchor |
|---|---|---|
| GET `/api/codex-auth/accounts` (`?refresh=1` forces fresh quota) | `{ accounts: CodexAuthAccountDto[] }` main-first; DTO `{ id, email(masked), plan?, logLabel?, isMain, quota: { weeklyPercent?, monthlyPercent?, weeklyResetAt?, monthlyResetAt?, resetCredits?, updatedAt } \| null, needsReauth?, hasCredential }`; go/free plans expose monthly fields only | src/codex/auth-api.ts:387-390, DTO :259-268, `quotaForPlan` :57-70 |
| POST `/api/codex-auth/accounts` | manual token import; gated by env `OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT=1`, else 403 `manual_import_disabled` | src/codex/auth-api.ts:392-434, :36 |
| DELETE `/api/codex-auth/accounts?id=` | always 200 `{ ok: true }` (no 404); purges credential + quota + thread affinity; clears `activeCodexAccountId` if pointed here | src/codex/auth-api.ts:436-443; src/codex/account-lifecycle.ts:14-20 |
| GET `/api/codex-auth/active` | `{ activeCodexAccountId: string \| null, autoSwitchThreshold: number (default 80), upstreamFailoverThreshold: number (default 3) }` | src/codex/auth-api.ts:458-465 |
| PUT `/api/codex-auth/active` body `{ accountId: string \| null }` | `"__main__"` = Codex App login; pool id must exist → 400 "Account not found"; `null` clears pin (auto-select lowest usage, src/codex/routing.ts:384-389). Response `{ ok, activeCodexAccountId }`. Writes config only; does NOT clear in-memory thread affinity — pinned threads keep their account until affinity expiry (src/codex/routing.ts:346-378), i.e. applies to NEW threads/sessions | src/codex/auth-api.ts:445-456 |
| PUT `/api/codex-auth/auto-switch` body `{ threshold: 0-100 }` | 0 disables; persisted as `autoSwitchThreshold` | src/codex/auth-api.ts:467-477 |
| PUT `/api/codex-auth/failover` body `{ threshold: 0-20 }` | consecutive upstream failures before failover | src/codex/auth-api.ts:479-489 |
| GET `/api/codex-auth/quota` | `{ quotas: { [accountId]: StoredAccountQuota } }` (no tokens/emails) | src/codex/auth-api.ts:491-495 |
| GET `/api/codex-auth/reset-credits?accountId=` | `{ credits: [{ granted_at, expires_at }], available_count? }`; 400/401/404 matrix | src/codex/auth-api.ts:497-523 |
| POST `/api/codex-auth/reset-credits/consume` body `{ accountId }` | `{ code: "reset" }` on success + quota force-refresh | src/codex/auth-api.ts:525-564 |
| POST `/api/codex-auth/login` body `{ id? }` | browser OAuth flow (opens browser server-side); `{ ok, flowId, url, instructions? }`; 409 while pending | src/codex/auth-api.ts:566-704 |
| POST `/api/codex-auth/login/cancel` / GET `/api/codex-auth/login-status?flowId=` | `{ ok, cancelled }` / `{ status: pending\|done\|error\|expired\|idle, accountId?, email?(masked), error? }` | src/codex/auth-api.ts:706-730 |

## Family B — generic OAuth providers

src/server/management-api.ts:1359-1471 (accounts/logout block :1427-1471). Valid providers = `listOAuthProviders()`:
`xai`, `anthropic`, `kimi`, `kiro`, `google-antigravity`, `cursor`, `github-copilot`
(`chatgpt` excluded via `isPublicOAuthProvider`, src/oauth/index.ts:123-126,155-157).
Unknown provider → 400 "unknown oauth provider".

| Endpoint | Shape / semantics | Anchor |
|---|---|---|
| GET `/api/oauth/providers` | `{ providers: string[] }` | src/server/management-api.ts:958-961 |
| POST `/api/oauth/login` body `{ provider, addAccount? }` | `addAccount: true` forces fresh browser identity; `{ url, instructions? }`; 409 on conflict | src/server/management-api.ts:1363-1382 |
| POST `/api/oauth/login/cancel` / `/api/oauth/login/code` | cancel: `{ ok, cancelled }`; code paste: `{ provider, input? }` → `{ ok: true }`, 409 on rejection (NOT for chatgpt) | src/server/management-api.ts:1386-1408 |
| GET `/api/oauth/status?provider=` | `{ loggedIn, email?(masked), source?, error?, done, activeAccountId?, accounts?: [{ id, email?(masked), active, needsReauth?, expiresAt? }] }` | src/server/management-api.ts:1410-1414; src/oauth/index.ts:556-577 |
| POST `/api/oauth/logout?provider=` | query param; removes ACTIVE account only, promotes first remaining | src/server/management-api.ts:1427-1439; src/oauth/store.ts:262-277 |
| GET `/api/oauth/accounts?provider=` | `{ activeAccountId: string \| null, accounts: OAuthAccountSummary[] }` (masked) | src/server/management-api.ts:1440-1445 |
| PUT `/api/oauth/accounts/active` body `{ provider, accountId }` | `{ ok, provider, activeAccountId }`; 400 missing id; 404 "account not found". Immediate — `getCredential` re-reads active row per request | src/server/management-api.ts:1446-1456; src/oauth/store.ts:202-207 |
| DELETE `/api/oauth/accounts?provider=&id=` | `{ ok: true }`; 400 missing id; 404 not found; removing active promotes first remaining | src/server/management-api.ts:1457-1472; src/oauth/store.ts:313-326 |

## Family C — API-key pools

src/server/management-api.ts:1473-1526, logic src/providers/api-keys.ts. Valid for
configured providers whose auth is not oauth/forward (`isKeyAuthProvider`,
src/providers/api-keys.ts:41-43). Pool = `provider.apiKeyPool` (src/types.ts:608);
`provider.apiKey` mirrors the active entry. Key ids = `sha256(key)[:8]`
(src/providers/api-keys.ts:36-38). Masking `maskApiKey`: `first4****last4`, `****`
when ≤8 chars, `${ENV}` refs verbatim (src/providers/api-keys.ts:28-32).

| Endpoint | Shape / semantics | Anchor |
|---|---|---|
| GET `/api/providers/keys?name=` | `{ activeId: string \| null, keys: [{ id, label?, masked, active, addedAt? }] }`; non-key provider → `{ activeId: null, keys: [] }`; unknown name → 404 | src/server/management-api.ts:1473-1478; src/providers/api-keys.ts:57-71 |
| POST `/api/providers/keys` body `{ name, key, label? }` | 201 `{ ok, id }`; new key becomes ACTIVE immediately; clears model/quota caches + key cooldowns | src/server/management-api.ts:1479-1494 |
| PUT `/api/providers/keys/active` body `{ name, id }` | `{ ok, name, activeId }`; 400 missing id; 404 unknown provider/key. Immediate (mirrors `provider.apiKey`) | src/server/management-api.ts:1495-1509 |
| DELETE `/api/providers/keys?name=&id=` | `{ ok: true }`; removing active promotes first remaining | src/server/management-api.ts:1510-1525 |

Adjacent: GET `/api/key-providers` (key-login picker metadata,
src/server/management-api.ts:963-966); GET/POST/DELETE `/api/keys` = the proxy's OWN
admission keys — POST returns the full `ocx_…` key exactly once
(src/server/management-api.ts:1518-1543).

## Provider-capability matrix

Programmatic discriminators: `authKind` (src/providers/registry.ts:14,22) and
`codexAccountMode` (src/providers/registry.ts:23; `"direct" | "pool"`,
src/types.ts:762), both exposed via GET `/api/provider-presets`
(src/providers/derive.ts:187,255-259).

| Provider | authKind | Account capability |
|---|---|---|
| openai (built-in) | forward | Codex pool (default) or main-only (`codexAccountMode: "direct"`) — registry.ts:295-298, :848 |
| xai | oauth | multi-account (registry.ts:322) |
| anthropic | oauth | multi-account (registry.ts:364) |
| kimi | oauth | multi-account — JWT `user_id`/`sub` stable identity (src/oauth/kimi.ts:57-75); NOT single-slot as the issue assumed |
| kiro | oauth | replacement-style single slot — no accountId/email in credential (registry.ts:420; src/oauth/store.ts:10-16,248-256) |
| google-antigravity | oauth | multi-account (registry.ts:583) |
| cursor | oauth | multi-account (JWT `sub`) (registry.ts:301) |
| github-copilot | oauth | multi-account (registry.ts:822) |
| all `authKind: "key"` providers (openrouter, groq, google, cerebras, opencode, qwen-*, …) | key | `apiKeyPool` multi-key with active mirror |
| ollama / vllm / lm-studio | local | no credentials |

Gap: multi-vs-replacement OAuth is NOT derivable over HTTP. `SINGLE_SLOT_PROVIDERS`
(src/oauth/store.ts:28) covers only `chatgpt`; kiro's replacement behavior comes
from the no-identity credential branch (src/oauth/store.ts:13-15,247-256 — no
accountId/email extracted at login). The CLI must hardcode the known
replacement-style set (`kiro`) or show a generic hint.

## Missing server-side contracts (CLI parity impact)

1. No aggregate cross-provider account view — CLI must fan out:
   `GET /api/oauth/providers` → per-provider `/api/oauth/accounts`; plus per
   key-provider `/api/providers/keys`. (Codex pool is the only aggregated one.)
2. No manual-code path for Codex pool login (browser-only) — CLI `account add` for
   openai stays browser-flow-based; out of scope for the minimal command set.
3. No HTTP-derivable multi-vs-replacement flag (see matrix gap).
4. No "force immediate switch" on PUT `/api/codex-auth/active` — pinned threads keep
   their account; CLI output must say "applies to new sessions/threads".
5. Tolerable asymmetries: DELETE codex-auth account + DELETE /api/keys return 200 on
   unknown ids; `/api/oauth/logout` takes query param.

Conclusion: the issue #180 minimal scope (`list` / `current` / `use`) needs NO new
server contract — all three families already expose the required reads and switches.
