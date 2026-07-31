# 010 — Phase 1: `ocx account list|current|use` core (diff-level design)

Issue #180 minimal scope. Reuses existing management contracts only
(`003_management_api_contracts.md` → no server change). Conventions from
`002_cli_command_inventory.md`.

## Outcome

Terminal users can list every account/key the GUI shows, see the active
credential, and switch it — with identifiers shown masked as the API returns
them, `--json`, and non-zero exits on unknown provider/account, against the
live local proxy.

## Command surface

```text
ocx account list [provider] [--json] [--all]
ocx account current <provider> [--json]
ocx account use <provider> <account-or-key-id|main> [--json]
```

- `list` (no provider): codex pool (if `openai` configured, pool mode) + every
  OAuth provider from `GET /api/oauth/providers` + every configured key-capable
  provider. Providers with zero rows are skipped unless `--all`.
- `main` is the CLI alias for API sentinel `__main__` (issue example uses `main`).
- Human table columns follow the issue: `PROVIDER TYPE ID PLAN/LABEL STATUS`.
  - codex row: ID `main`/`chatgpt-…`; PLAN/LABEL = plan (fallback masked email);
    STATUS = `next session` for the pinned account, `needs-reauth` appended when
    flagged; note line when `activeCodexAccountId` is null: `auto (no pin —
    lowest-usage account is selected per request)`.
  - oauth row: PLAN/LABEL = masked email (fallback `Account N` ordinal, mirrors
    `oauthAccountDisplayLabel` gui/src/provider-workspace/auth.ts:31-39);
    STATUS = `active` / `needs-reauth`.
  - api-key row: PLAN/LABEL = label (fallback server-masked key); STATUS `active`.
  - kiro (replacement-style single slot) gets a printed note: single login slot,
    re-login replaces the current account (set hardcoded client-side — the
    behavior comes from the no-identity credential branch,
    src/oauth/store.ts:13-15,247-256, and is not HTTP-derivable, `003` matrix
    gap 3).
- `--json`: `list` → `{ "accounts": AccountRow[], "notes": string[] }`; `current` →
  `{ provider, type, activeId, autoSwitchThreshold?, account? }`;
  `use` → `{ ok, provider, type, activeId }`. JSON keeps the raw `__main__` id.

## Scope boundary

IN: the three files below + new test file. OUT: add/reauth/browser flows, key
add, auto-switch/refresh/remove (→ `020`), docs (→ `030`), server code, GUI.

## File change map

### NEW `src/cli/account.ts` + `src/cli/account-api.ts` (split per audit R1#5)

`account-api.ts` owns the HTTP/DTO layer (`apiJson`, `resolveBaseUrl`, family
readers, DTO types); `account.ts` owns classification, formatting, and
subcommands (re-exporting the public surface). Each lands under ~260 lines.

Structure (exports marked `*` are for tests, mirroring `buildClaudeEnv`
test-export convention in src/cli/claude.ts):

```ts
import { loadConfig } from "../config";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";

export type AccountType = "codex" | "oauth" | "api-key";
export interface AccountRow {
  provider: string; type: AccountType; id: string;
  label?: string; email?: string; plan?: string; masked?: string;
  active: boolean; needsReauth?: boolean; note?: string;
}
export interface AccountDeps {
  baseUrl?: string;                       // test injection; skips findLiveProxy
  fetchImpl?: typeof fetch;
  loadConfigImpl?: () => OcxConfig;
}
```

- Local `consumeFlag`/`consumeFlagValue` copies — SAME pattern as provider.ts
  and models.ts (search evidence: both keep local copies; extracting a shared
  args module now would widen the blast radius to two untouched files — dedupe
  recorded as a candidate, rejected for this phase).
- `* classifyAccount(config, name): { type: AccountType } | { error: string }`
  — CONFIG-FIRST (audit R1#1): the credential surface follows the CONFIGURED
  authMode, mirroring `isKeyAuthProvider` (src/providers/api-keys.ts:38-40) and
  the GUI's `providerAuthSurface` (gui/src/provider-workspace/auth.ts:17-28);
  registry `authKind` is consulted only for unconfigured names. Order:
  1. `providerCodexAccountMode(name, config.providers?.[name])` (registry.ts:848)
     → `"codex"` (covers openai pool AND direct mode; direct prints a display
     note — see "Display notes" below).
  2. registry `authKind === "local"` (ollama/vllm/lm-studio) → error
     "has no credentials".
  3. configured with `authMode: "forward"` → error "no switchable credentials".
  4. configured with `authMode: "key"`, OR authMode unset WITH key material
     (`apiKey`/`apiKeyPool` non-empty) → `"api-key"`.
  5. `isPublicOAuthProvider(name)` (src/oauth/index.ts:123-126 — chatgpt
     excluded) → `"oauth"`. Reached by configured `authMode: "oauth"` AND by
     unconfigured public-OAuth names (empty account sets list fine).
  6. configured but falling through (no key material, not public oauth) →
     `"api-key"` (server returns a 200-empty pool → honest "no keys" display).
  7. unconfigured + not public oauth → error listing candidates.
  API errors still win: 404 from a family endpoint maps to the same exit-1 path.
  Classification is DISK-CONFIG-based (`loadConfig`) — GET /api/providers omits
  authMode, so HTTP-only classification is impossible (audit R1 obs 6).
- `list` (no provider) fan-out dedupe (audit R1#1): the candidate set is
  {openai when configured} ∪ {public OAuth providers} ∪ {configured providers};
  each name is classified ONCE via `classifyAccount` and listed in exactly one
  family — a key-overridden OAuth provider (xai/github-copilot with
  `authMode:"key"`) appears only under `api-key`.
  Fan-out error policy (audit R2#1): names classifying to `{error}` (local
  providers like ollama/vllm, forward-auth customs) are SKIPPED silently in the
  no-arg fan-out — never exit 1 for them; classification errors surface only on
  explicit single-provider invocations (`list <provider>`, `current`, `use`).

## Display notes (folded from audit round 1)

- Direct mode (`codexAccountMode: "direct"`): codex rows still list; a note line
  says `openai is in direct mode — the selection takes effect when pool mode is
  enabled` (GUI's `poolPrepared` semantics; audit R1 obs 4).
- Null pin (`activeCodexAccountId: null`): the CLI prints `auto (no pin —
  lowest-usage account is selected per request)` — an INTENTIONAL divergence
  from the GUI's legacy null→main display, because it matches the server:
  auto-select picks and persists the lowest-usage eligible account
  (src/codex/routing.ts:383-389) (audit R1 obs 3).
- Secret hygiene: server DTOs carry only masked fields (email `f***l@domain`,
  key `first4****last4`); `maskEmail` passes non-email identifiers through raw
  (src/lib/privacy.ts:4-6) — identical to the GUI, accepted; no DTO field can
  carry a raw access token or API key (audit R1 obs 5 + answer 5).
- Guarantee wording (audit WP2-R1#4): the CLI prints identifiers and secrets
  EXACTLY as the management API returns them (masked server-side); user-supplied
  labels/ids/plan strings are shown verbatim — identical to the GUI, and required
  for `use` to be addressable. The invariant is "no raw CREDENTIAL material" —
  the API never returns any in these DTOs — not "every printed byte is masked".
- Local-provider rationale (audit WP2-R1#3): local providers (ollama/vllm/
  lm-studio) classify to `{error: has no credentials}` even if a pathological
  config carries key material — GUI parity (`providerAuthSurface` returns null
  for local, gui/src/provider-workspace/auth.ts:21); the server predicate's
  leniency is a pre-existing server quirk, out of this unit's write scope.
- `* formatAccountTable(rows): string` — padded columns, `__main__` → `main`.
- `apiJson(deps, live, method, path, body?)` → `{ status, json }`; headers from
  `runningProxyUpdateHeaders()` (src/oauth/login-cli.ts:9); base URL from
  `probeHostname(live.hostname)` + `live.port` (mirror src/cli/debug.ts:19-21).
- `resolveLive(deps)` → deps.baseUrl ?? `findLiveProxy()`; null → stderr
  `Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.` return 1.
- `cmdAccount(args, deps = {}): Promise<number>` — subcommand switch; usage
  errors print `ACCOUNT_USAGE` + return 1; NEVER `process.exit` (return-code
  pattern of `ocx v2`, src/cli/index.ts:524 — Windows-friendly unwind).

Data flow per subcommand:

| Subcommand | Endpoint(s) |
|---|---|
| `list` (codex) | GET `/api/codex-auth/accounts` + GET `/api/codex-auth/active` |
| `list` (oauth) | GET `/api/oauth/providers` then per-provider GET `/api/oauth/accounts?provider=` |
| `list` (api-key) | GET `/api/providers/keys?name=` per configured key provider |
| `current` | same reads; prints the active row or auto/none note |
| `use` codex | PUT `/api/codex-auth/active` `{ accountId }` (`main`→`__main__`) |
| `use` oauth | PUT `/api/oauth/accounts/active` `{ provider, accountId }` |
| `use` api-key | PUT `/api/providers/keys/active` `{ name, id }` |

`use` success notes (stderr after JSON/stdout):
- codex: `Applies to new Codex sessions; running threads keep their current
  account.` (contract: PUT writes config only, thread affinity persists —
  src/codex/routing.ts:346-378) + when `autoSwitchThreshold > 0`: `auto-switch
  (threshold N%) may override this pin.`
- non-2xx: print server `{error}` text, return 1.

Error propagation rules (audit WP2-R1#1/#2, refined WP2-R2#1):
- Fan-out (`list` with no provider) tracks each target's provenance
  (`live-oauth-list` | `config` | `codex`). Skips are EXACTLY:
  - api-key family: status 404 AND error text contains `unknown provider`
    (disk/live config drift — src/server/management-api.ts:1473-1477).
  - oauth family, provenance `config` ONLY: status 400 AND error text contains
    `unknown oauth provider` (proxy version older than disk config).
  Everything else propagates: print the server error text, return 1 — never
  convert auth/server failures into partial success. A name returned by the
  live `/api/oauth/providers` that 400s on the next call is an internal
  inconsistency (same predicate) and MUST fail, not skip.
- Codex family routes are unconditional-200 (src/codex-auth/accounts,
  codex-auth/active): ANY non-200 fails the command.
- `fetchCodexRows` treats a non-200 `GET /api/codex-auth/active` as a failure
  surface (errorJson), never as a null pin. The `auto (no pin…)` note is
  reserved for a real 200 carrying `activeCodexAccountId: null`.

### MODIFY `src/cli/index.ts` (dispatch, next to provider case :626-629)

```ts
  case "account": {
    const { cmdAccount } = await import("./account");
    process.exitCode = await cmdAccount(args.slice(1));
    break;
  }
```

### MODIFY `src/cli/help.ts`

- `helpEntries` (after the `provider` entry, :72-78 region):

```ts
  account: {
    usage: "ocx account <list|current|use> [provider] [id] [--json] [--all]",
    summary: "List and switch provider accounts and API-key pools (GUI parity).",
    details: [
      "list [provider]     Codex pool, OAuth accounts and API keys (masked).",
      "current <provider>  Show the active account/key.",
      "use <provider> <id> Switch active credential; 'main' selects the Codex App login.",
      "Codex pool switches apply to new sessions; running threads keep their account.",
    ],
  },
```

- `printUsage()` (:119-158): add one aligned row `  account …` in the existing
  command list (both registries must move together — known convention).

### NEW `tests/cli-account.test.ts`

Local HTTP mock (Bun.serve on port 0 or node:http) implementing the six
endpoints; the row-11 fixture puts a RAW sentinel `sk-rawsentinel1234567890`
in an UNEXPECTED credential field (`apiKey`/`accessToken`) of the mocked DTO
while `masked` carries the valid server-masked `sk-ra****7890`. Capture
`console.log`/`console.error`; call `cmdAccount(args, { baseUrl })`.

Test matrix (activation scenarios, C-ACTIVATION-GROUNDING-01):

| # | Path | Trigger | Assert |
|---|---|---|---|
| 1 | list all families | `list` | 3 row types, `main` display, padded table |
| 2 | --json branch | `list --json` | JSON.parse; raw `__main__` id present |
| 3 | empty-provider skip / `--all` | `list` vs `list --all` | empty provider absent then present |
| 4 | current pinned | `current openai` | pinned id + plan printed |
| 5 | current auto (null pin) | fixture active=null | prints `auto (no pin…` note |
| 6 | use oauth ok | `use anthropic acct_1` | PUT body `{provider,accountId}`; exit 0 |
| 7 | `main` alias mapping | `use openai main` | PUT body `accountId:"__main__"` |
| 8 | unknown provider | `use nosuch x` | exit 1, stderr names candidates |
| 9 | unknown account (API 404) | `use anthropic nope` | exit 1, server error text surfaced |
| 10 | proxy down | baseUrl→127.0.0.1:1 | exit 1 + `ocx start`/`ensure` hint |
| 11 | secret hygiene (WP2-R2#2) | key DTO with sentinel in `apiKey` + valid `masked` | output shows `sk-ra****7890`, never the sentinel; `list --json` row has no `apiKey` property |
| 12 | kiro note | `list kiro` | single-slot replacement note printed |
| 13 | usage errors | bare `account`, `use` missing id | exit 1 + ACCOUNT_USAGE |
| 14 | fan-out error-skip (audit R2#1) | fixture: configured ollama + forward custom, `list` | exit 0, both skipped; `list ollama` → exit 1 "has no credentials" |
| 15 | fan-out auth failure (WP2-R1#1) | mock 401 on one family, `list` | exit 1, error text; NOT partial success |
| 16 | active-read failure (WP2-R1#2) | `GET /api/codex-auth/active` → 500, `current openai` | exit 1; no `auto (no pin…)` note |
| 17 | local-with-key classification (WP2-R1#3) | fixture: ollama config WITH apiKey, `list ollama` | exit 1 "has no credentials" (GUI parity) |

## B-phase amendments (folded at WP2 A-gate, reviewer Aquinas GO-WITH-FIXES)

- `AccountRow.note` dropped — notes are emitted out-of-band (stderr / the
  `notes` JSON array), never per-row (Aquinas #4).
- Fan-out pushes `openai` unconditionally rather than "when configured" —
  `providerCodexAccountMode` defaults openai→"pool" and the GUI's CodexAuth
  surface exists regardless of configuration (Aquinas #4).
- Failed codex active-read (non-200) maps to `errorJson`, never to the null-pin
  "auto" note (Aquinas #2; suite test 16).
- Provenance-aware fan-out error policy: 404 "unknown provider" from a key
  family and 400 "unknown oauth provider" on a config-provenance target are
  skipped (stale config vs live proxy); any other family-read failure in
  fan-out exits 1 with the server error (suite test 15).
- Key PLAN/LABEL display: `masked (label)` when both fields exist.
- Test suite at close: 21 tests (14 matrix rows + failure-injection rows 15-17
  + restored guards 18-21 covering the R1#1 classification regression,
  needs-reauth status, codex use notes, and table rendering).

## Accept criteria (C verifies each live)

1. `bun x tsc --noEmit` clean; `bun test tests/cli-account.test.ts` all rows pass (matrix 1-17).
2. Live proxy: `ocx account list`, `list --json | jq`, `current openai`,
   `use openai main` round-trip — then RESTORE the pre-test pin (evidence:
   before/after `current openai` outputs).
3. Live error exits: `use openai nope` → 1; `use nosuch x` → 1.
4. `ocx help account` and bare `ocx` usage both show the family.
5. No raw token/key material in any captured output (grep over live + mock).

## Pre-implementation P stale-check items

- Re-verify registry exports (`providerCodexAccountMode`, `getProviderRegistryEntry`
  — registry.ts:839,848 as of survey) and `runningProxyUpdateHeaders`
  (login-cli.ts:9); another session is landing provider-work commits on `dev`.
- Re-check `findLiveProxy` signature in proxy-liveness.ts before writing
  `resolveLive` (line drift expected; contract stable).
