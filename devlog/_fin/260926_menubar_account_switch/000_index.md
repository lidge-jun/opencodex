# Native panel account switch

Adds a "Use" action to account rows in the macOS menu bar panel so the operator can change a
provider's active account without opening the dashboard. Delivered as two stacked PRs on top of
#5923 (manual chain):

| Order | Doc | Branch | Outcome |
|---|---|---|---|
| 5 | [010](010_server_capability.md) | `codex/local-account-switch-capability` | The desktop host can authorize exactly the three existing "set active account" PUTs with a body-bound, single-use local capability. |
| 6 | [020](020_panel_switch.md) | `codex/menubar-account-switch` | The native panel shows Use on hover/focus, mirrors the server's lock and exhaustion signals, and switches through the host. |

## Why a new capability

The desktop host holds two scoped grants: the local-management-read-v1 GET allowlist
(`src/lib/local-management-capability.ts`) and the body-bound desktop snapshot POST
(`src/lib/local-desktop-snapshot-capability.ts`). The switch routes are ordinary management
mutations (`PUT /api/codex-auth/active`, `PUT /api/oauth/accounts/active`,
`PUT /api/providers/keys/active`); the host cannot call them today and receives 401. It never
sends the admin token or a dashboard session, and this unit keeps it that way.

## Server behavior this mirrors (no new rules)

- `PUT /api/codex-auth/active` `{accountId}`: 409 for a paused account, pending validation or a
  legacy `__main__` pool row; it accepts a hard-locked main or an exhausted pool account and lets
  routing drain the pin. The roster's `__main__` row carries `mainAccountHardLock.state`.
- OAuth `{provider, accountId}` and API key `{name, id}` switches check existence only.
- The 98% hard lock applies to the main Codex account only. Pool accounts are exhausted at 100%
  (`isCodexQuotaExhausted`). The panel disables Use only where the server would block traffic
  outright (hard-locked main, paused) and shows a warning for an exhausted target.

## Threat note

The capability is minted with the runtime attestation secret the desktop already reads from the
runtime record. A same-user process that can read that record can mint it, exactly as it can mint
read and snapshot grants today. In file-backed mode the same user can also read
`admin-api-token`, which grants all of management; when the admin token comes from the environment
that file does not exist, so the comparison holds only for the file-backed default. Either way the
new grant is strictly narrower than the admin token: three routes, one method, one exact body, ten
seconds, single use, and no browser `Origin`. Security review is still required by MAINTAINERS.md
because it changes an authentication boundary.

## Architect consultation

Read-only gpt-6-sol architect (Godel) decisions D1-D6, all accepted: dispatcher-level body
verification (D1), scope enforced at admission and again at dispatch (D2), no GUI session/CSRF
change (D3), capability and ingress tests incl. cross-domain rejection and a shared MAC vector
(D4), updates to `structure/gui-and-management-api.md` and `structure/desktop-shell.md` plus
security review (D5), Rust `put_account_switch` with the existing error mapping (D6).
