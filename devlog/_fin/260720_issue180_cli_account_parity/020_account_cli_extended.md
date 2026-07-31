# 020 — WP3: codex-pool extras + guarded remove + key add (diff-level design, R1-folded)

Completes GUI parity for the account domain beyond the 010 core. Every command
reuses an existing management contract (`003`); no server change.
Audit fold: `021_wp3_audit_synthesis.md` (Gauss R1, 7 findings — all folded here).

## Outcome

`ocx account` covers the remaining read/toggle/remove/add verbs the GUI exposes:
quota refresh, auto-switch control, guarded credential removal, and API-key add
with pipe-only secret intake.

## Command surface (all under `ocx account`)

```text
ocx account refresh openai [--json]
ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]
ocx account remove <provider> <id|main> --yes [--json]
ocx account add-key <provider> [--label <label>] [--json]    # key via stdin pipe only
```

### `refresh <provider>`

- GET `/api/codex-auth/accounts?refresh=1` (forces WHAM quota fan-out,
  src/codex/auth-api.ts:359-389), then GET `/api/codex-auth/active`.
- Prints one line per account: id (`main` alias), masked email, plan,
  `weekly NN%` and/or `monthly NN%` when present, `resets <ISO>` when present,
  `needs-reauth` when flagged; `quota: unknown` when quota is null (never
  prints `0%` for unknown). `--json` rows carry a `quota` object.
- `refresh <oauth-or-key-provider>` → GET `/api/provider-quotas?refresh=1`
  (audit R3/B2: a REAL server-side refresh exists — it force-refreshes provider
  quota reports, src/server/management-api.ts:517-520 +
  src/providers/quota.ts:658-670, covering oauth xai/anthropic/cursor/
  google-antigravity/kimi and canonical-Kimi-Code key auth,
  src/providers/quota.ts:643-652; the GUI quota bars use exactly this,
  gui/src/pages/Providers.tsx:121). Prints the provider's report row
  (percent + window/reset fields as present in `ProviderQuotaResponse.reports`);
  when the provider's report is null/absent, prints
  `no quota report available for <provider>` (exit 0 — truthful, not an error).
- `refresh --json` envelope (audit R3#3): `{ accounts: AccountRow[] }` (same
  row shape as `list --json`; codex rows carry the `quota` object); for
  oauth/key providers `{ provider, report: object | null }`.

### `auto-switch <provider> …`

- Provider argument REQUIRED; must classify `codex` (openai) — anything else
  exits 1 with "auto-switch only applies to the openai Codex account pool".
- `status` → GET `/api/codex-auth/active`, prints
  `auto-switch: on (threshold N%)` / `auto-switch: off`; `--json` emits
  `{ provider, autoSwitchThreshold, enabled }`.
- `on` → PUT `{ threshold: 80 }`; `off` → PUT `{ threshold: 0 }` (GUI toggle
  parity, gui/src/components/CodexAccountPool.tsx:164-171);
  `threshold <n>` → integer 0-100 validated client-side (server contract
  src/codex/auth-api.ts:467-477); anything else → usage error exit 1.

### `remove <provider> <id|main> --yes`

- `--yes` REQUIRED (non-interactive destructive op), enforced at ARG-PARSE time
  BEFORE `resolveBaseUrl` — without it the command exits 1 with the exact
  re-run hint and NO request is sent, even when the proxy is down (audit R3/N3).
- Pre-check via the family list endpoint: unknown id → exit 1, NO delete sent
  (normalizes the codex DELETE idempotency, src/codex/auth-api.ts:436-443).
- `main` maps to `__main__` for codex; removing main is refused (the GUI never
  offers it — CodexAccountPool renders no remove action for the main row).
- DELETE per family: codex `/api/codex-auth/accounts?id=`, oauth
  `/api/oauth/accounts?provider=&id=`, keys `/api/providers/keys?name=&id=`.
- Post-delete: re-read the family and print the family-specific outcome —
  codex: pin cleared → `auto (no pin — lowest-usage account is selected per
  request)` when the removed id was pinned (src/codex/account-lifecycle.ts:15-20);
  oauth: promoted first-remaining id or `no accounts remaining`
  (src/oauth/store.ts:313-326); keys: promoted id or `no keys remaining`
  (src/providers/api-keys.ts:105-120). A post-delete re-read failure is
  surfaced DISTINCTLY from the delete failure (delete may have succeeded).
- `remove --json` envelope (audit R3#3): success
  `{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }`;
  failure exits 1 with `{ error: string }` on stderr, no partial success JSON.

### `add-key <provider> [--label <label>]`

- Provider must classify `api-key`; anything else → exit 1 with guidance.
- Secret intake: stdin ONLY when stdin is not a TTY (pipe/redirect). TTY →
  exit 1 with guidance `ocx account add-key <provider> <<< "$MY_KEY"` /
  secret-manager pipe example (`security find-generic-password -w … | ocx
  account add-key …`) — never a literal `echo <key> |` example (shell history).
- Read: first line, trimmed, 15s inactivity timeout (secret-manager pipes can
  be slow), reader + timeout injected via `AccountDeps` for deterministic tests;
  listeners/timers cleaned up on all exits.
- Empty/whitespace input → exit 1 with usage. POST `/api/providers/keys`
  `{ name, key, label? }` → 201 auto-activates (src/providers/api-keys.ts:75-94).
- Output: prints `{ ok, id }` + the label — redacted when the label EQUALS or
  CONTAINS the submitted key (audit R2#2): every exact occurrence of the trimmed
  key is replaced with `[redacted]` in both human and `--json` output. The key
  itself is never printed, never logged.

## Scope boundary

IN: `src/cli/account.ts` (router extension), `src/cli/account-api.ts` (method
union POST/DELETE + quota-carrying codex reader + stdin injection types), NEW
`src/cli/account-extended.ts` (the four handlers + readStdinLine), `src/cli/help.ts` (entry +
usage), `tests/cli-account.test.ts` (rows 18+), this devlog unit.
OUT: browser login/reauth/add-account flows, reset-credit consume, failover
threshold, docs (→ 030), server code, GUI.

## File change map

| File | Change | Budget |
|---|---|---|
| `src/cli/account-extended.ts` | NEW: cmdRefresh/cmdAutoSwitch/cmdRemove/cmdAddKey + readStdinLine | ≤ ~260 lines |
| `src/cli/account-api.ts` | MODIFY: apiJson method union + CodexQuotaDto in codex reader + stdin injection types | +~60 |
| `src/cli/account.ts` | MODIFY: cmdAccount dispatch + USAGE text | +~30 (stays ≤ ~330) |
| `src/cli/help.ts` | MODIFY: account entry details + printUsage line | +~6 |
| `tests/cli-account.test.ts` | MODIFY: rows 18-36 | +~240 |

Module direction (audit R2#1 — acyclic, no runtime import cycle):
- `src/cli/account-api.ts` owns shared infra AND `classifyAccount` + `AccountDeps`
  (incl. stdin injection types). `src/cli/account.ts` re-exports
  `classifyAccount` AND the moved public types (`AccountDeps` etc. — tests
  import them from `account.ts`) so the test import surface is unchanged
  (audit R3#1).
- Dependency direction is one-way: `account.ts` (router) → `account-extended.ts`
  (extended handlers) → `account-api.ts` (shared); `account.ts` →
  `account-api.ts`. Extended handlers never import from `account.ts`.
- `readStdinLine` has exactly ONE owner: `account-extended.ts`; `account-api.ts`
  only carries the injection types on `AccountDeps`.

## Test matrix (continues from suite rows 1-21 incl. restored guards 18-21 — R3#6 renumber)

| # | Path | Trigger | Assert |
|---|---|---|---|
| 22 | refresh codex | `refresh openai` | mock sees `?refresh=1`; quota lines show weekly/monthly %; quota:null → `quota: unknown` |
| 23 | refresh oauth / keys | `refresh anthropic`, `refresh openrouter` | both hit `/api/provider-quotas?refresh=1`; report row printed; null report → `no quota report available` (exit 0) |
| 24 | auto-switch on/off/threshold/status | four invocations | PUT bodies 80/0/55; status reads threshold; `--json` shape |
| 25 | auto-switch guards | `auto-switch anthropic on`, `threshold 101`, missing provider | exit 1 each with guidance |
| 26 | remove without --yes | `remove openai chatgpt-1` | exit 1 + re-run hint; NO delete request sent — even with the proxy DOWN (arg-parse-time guard) |
| 27 | remove unknown id | `remove openai nope --yes` | exit 1 pre-check; NO delete request sent |
| 28 | remove codex pinned | delete the pinned pool account | post-delete prints `auto (no pin…)` |
| 29 | remove oauth active promotes | delete active oauth account | prints promoted first-remaining id |
| 30 | remove last key | delete the only key | prints `no keys remaining` |
| 31 | remove main refused | `remove openai main --yes` | exit 1; NO delete sent |
| 32 | add-key pipe | stdin stream `"sk-test-1234567890abcdef\n"` | POST body `{name,key,label?}`; stdout has `{ok,id}`; stdout NEVER contains the key; label suppressed when label===key |
| 33 | add-key TTY / empty | injected TTY stdin; empty pipe | both exit 1 with guidance; NO POST sent |
| 34 | delete failure paths | pre-check ok → DELETE 500; DELETE 200 → re-read 500 | exit 1 with server text; re-read failure → nonzero + "delete may have succeeded" note |
| 35 | add-key POST failure + stdin timeout | POST → 400; stdin silent 15s | exit 1 with server text; timeout → exit 1, listeners/timers cleaned |
| 36 | refresh/auto-switch API failures | refresh accounts → 500; auto-switch status GET → 500; on PUT → 400 | exit 1 each, server error surfaced |
| 37 | add-key label containment + help family | label `"prod-sk-test-1234567890abcdef"`; `help account` | label prints `[redacted]` (human AND `--json`); help lists refresh/auto-switch/remove/add-key |
| 38 | promotion variants | remove active key with 2 remaining; remove last oauth account; remove NON-pinned codex account | key prints promoted id; oauth prints `no accounts remaining`; codex keeps the existing pin (no auto note) |
| 39 | add-key wrong family | `add-key anthropic`, `add-key openai` | exit 1 with guidance; NO POST sent |
| 40 | refresh/remove --json envelopes | `refresh openai --json`; `remove openai chatgpt-1 --yes --json` | `{accounts:[…quota…]}` / `{provider, report}`; `{ok:true,provider,id,removedActive,promotedActiveId}` |

## Accept criteria

1. `bun x tsc --noEmit` clean; `bun test tests/cli-account.test.ts` all rows (1-36) pass.
2. Live: `refresh openai` exit 0 with quota lines; `auto-switch openai status` prints
   current threshold; `auto-switch openai threshold` round-trip — RESTORE the
   original threshold after (evidence: before/after `status` output).
3. Live `remove --yes`/`add-key` ONLY against a disposable credential if one exists;
   otherwise mock-only + documented skip (never mutate real accounts for evidence).
4. No raw secret in any output (sentinel grep over add-key/refresh paths, mock + any live run).
