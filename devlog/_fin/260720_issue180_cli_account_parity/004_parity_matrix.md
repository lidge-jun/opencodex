# 004 — GUI↔CLI parity matrix (research synthesis)

Cross-reference of `001_gui_feature_inventory.md` (GUI) against
`002_cli_command_inventory.md` (CLI). Status legend:
`full` = CLI covers the GUI capability · `partial` = weaker CLI surface exists ·
`gap` = GUI-only. Scope column: whether this loop addresses it.

## Credential / account domain (issue #180 — THIS LOOP)

| GUI capability | CLI status | Loop slice |
|---|---|---|
| Codex pool: list accounts (plan/quota/staleness) | **full** (010) — `account list`, live-verified | delivered |
| Codex pool: view next-session selection + auto-switch state | **full** (010/020) — `account current` + `auto-switch status`, live-verified | delivered |
| Codex pool: set next-session account (incl. `__main__`) | **full** (010) — `account use openai <id\|main>`, round-trip live-verified | delivered |
| Codex pool: refresh quotas | **full** (020) — `account refresh openai`, live-verified quota lines | delivered |
| Codex pool: auto-switch on/off | **full** (020) — `account auto-switch on\|off\|threshold N` (+ threshold beyond GUI), round-trip live-verified | delivered |
| Codex pool: remove account | **full** (020) — `account remove --yes` (guarded), mock-verified | delivered |
| Codex pool: add account / re-auth (browser flow + status poll) | **gap** — NO CLI path exists: `chatgpt` is excluded from public OAuth login (src/oauth/index.ts:123-126) and `openai` is neither an OAuth nor a key-login provider, so `ocx login chatgpt`/`ocx login openai` both exit 1 (src/oauth/login-cli.ts:35-42) | OUT — browser-flow territory; first credential comes from the Codex CLI/App login (main), pool adds via dashboard; recorded as future candidate |
| Codex pool: reset-credit view + consume | **gap** | OUT this loop (GUI-internal billing flow; candidate) |
| OAuth: list accounts per provider | **full** (010) — `account list <provider>`, live-verified | delivered |
| OAuth: switch active account | **full** (010) — `account use <provider> <id>`, mock+contract verified | delivered |
| OAuth: remove account | **full** (020) — `account remove --yes`, mock-verified | delivered |
| OAuth: add account / re-auth / manual code / cancel / logout | **partial** — `ocx login/logout` cover first credential only (no `addAccount:true`, no reauth, no code paste) | OUT this loop (browser-flow; candidate) |
| API-key pool: list keys (masked) | **full** (010) — `account list <provider>`, live active state | delivered |
| API-key pool: switch active key | **full** (010) — `account use <provider> <id>`, mock+contract verified | delivered |
| API-key pool: add key | **full** (020) — `account add-key` (pipe-only stdin, redaction), mock-verified | delivered |
| API-key pool: remove key | **full** (020) — `account remove --yes`, mock-verified | delivered |
| Single-slot OAuth (kiro): guidance | **full** (010) — note line printed when a stored kiro account exists, mock row 12 verified | delivered |

## Non-credential GUI features (recorded; OUT of this loop's write scope)

| GUI capability | CLI status | Note |
|---|---|---|
| Proxy start/stop/restart/health | full (`start/stop/restart/ensure/health/status`) | — |
| Self-update check/run | full (`ocx update`; GUI runs same job API) | — |
| Debug flags + log streams | full (`ocx debug`) | — |
| Provider add/remove/config | full (`ocx provider …`) | GUI-only extras: enable/disable PATCH, note edit, codexAccountMode switch — candidate |
| Model list | partial (`ocx models` static only) | GUI-only: enable/disable, context caps, selected-models — candidate |
| Multi-agent mode / thread limits | full (`ocx v2 …`) | — |
| Usage analytics | **gap** | candidate (`GET /api/usage`) |
| Request logs view | **gap** | candidate (`GET /api/logs`; `ocx debug … logs` covers debug streams only) |
| Storage report | **gap** | candidate (`GET /api/storage`) |
| Proxy API keys (admission) | **gap** | candidate (`/api/keys`; sensitive — full key shown once) |
| Combos CRUD | **gap** | candidate (`/api/combos`) |
| Subagent model picks | **gap** | candidate (`/api/subagent-models`) |
| Settings (auto-start, sidecar, shadow-call, injection, effort-caps) | **gap** | candidate (5 endpoint families) |
| Claude surface settings | partial (`ocx claude` launches; settings form GUI-only) | candidate |
| Sync models trigger | full (`ocx sync`) | — |
| OAuth login/add/reauth flows | partial (`ocx login`) | see credential matrix |

"candidate" = recorded for a future unit; NOT appended to this goalplan's
workPhases (issue #180 is the account domain; LOOP-UNIT-CHAIN-01 applies only if
the user extends scope).

## Mid-loop stale check + dedupe (2026-07-20, HEAD 30a71fe3→3cc1b6f7)

- `25f3ded2 feat(providers): Re-authenticate for OAuth and Codex accounts (#171)`
  landed mid-loop: GUI gained Re-authenticate CTAs with identity-bound re-login
  (`POST /api/codex-auth/login {id, reauth:true}`, OAuth `reauthAccountId` opts).
  CLI coverage: ❌ — recorded as a future candidate (`ocx account reauth`), NOT
  appended to this loop's scope.
- Verified unchanged by #171: `GET/PUT /api/codex-auth/active`, the accounts DTO,
  `PUT /api/codex-auth/auto-switch`, `/api/oauth/accounts*`, `/api/providers/keys*`
  — the contracts 010/020 build on.
- Dedupe: `001_gui_cli_parity_matrix.md` and `002_api_contracts.md` (first-draft
  research docs) were removed after this matrix and `003` absorbed their content;
  the stale `ocx login chatgpt` 🟡 row died with them (audit R1#2).

## Gap classification for the account domain

All account list/current/switch/remove capabilities reuse EXISTING management
contracts (`003_management_api_contracts.md` → "no new server contract needed").
Only missing HTTP contract: aggregate cross-provider view → CLI fans out
(oauth providers list + per-provider accounts + per-key-provider keys).
