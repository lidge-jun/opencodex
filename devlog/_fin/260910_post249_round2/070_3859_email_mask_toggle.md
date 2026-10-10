# B3 — #3859 let an operator unmask stored account emails

Raw research: `_research/3859.md`. **Surface choice is pending a user decision.**

## Verdict

Real. `maskEmail()` has no reveal argument (`src/lib/privacy.ts:1-11`) and every
management projection applies it before the Dashboard or CLI sees the DTO:
`poolAccountDto` (`src/codex/auth-api.ts:367`, `:380`), the main account DTO
(`:2011`), the login-status wire (`:3045`, `:3049`), and `getLoginStatus`
(`src/oauth/index.ts:1808`, `:1815`, `:1835`). `/api/oauth/accounts` and
`/api/oauth/status` do not mask themselves — they consume the already-masked
`getLoginStatus` (`src/server/management/oauth-account-routes.ts:236`).

`OcxConfig` has no `privacy` or `dashboard` key (`src/types/config.ts:328`,
`src/config.ts:1140`). The schema is `.passthrough()` (`:1295`), so a hand-edited
`dashboard.maskEmails` would sit on disk and do nothing, and
`ocx config set dashboard.mask_emails false` cannot create a missing parent object.

The issue's line numbers are stale; the anchors above are current for `cd813d3d9`.

## The judgment call

Management is not always loopback. `remoteGui` (`src/types/config.ts:334-346`)
means a persisted unmask discloses operator PII to every management principal that
can reach the hub, not just to someone sitting at the machine.

**Asked the user:** persisted config flag, CLI flag only, or both with a Dashboard
session reveal. **Recommendation: the persisted flag with masking as the default**,
because the reporter's case is a self-hosted admin managing many accounts, and a
CLI-only flag does not help the Dashboard they actually use.

## Fix shape

- Add optional `privacy?: { maskEmails?: boolean }` to `OcxConfig` and
  `configSchema`. Omitted or `true` keeps today's behaviour. Prefer `privacy` over
  `dashboard`: `ocx status` and `ocx account` are not the dashboard.
- Give `src/lib/privacy.ts` a `projectEmail(value, mask)` — or an optional second
  argument on `maskEmail` — rather than forking redaction per call site.
- Thread the flag through `poolAccountDto`, the main DTO, login-status, and
  `getLoginStatus`. Pass an explicit boolean from `handleOauthAccountRoutes`
  (`ctx.config`) and from the CLI; do **not** load config inside `getLoginStatus`,
  which would couple oauth to config I/O.
- Do not re-mask in `oauth-account-routes`; it already consumes `getLoginStatus`.
- Dashboard and CLI then render whatever the DTO carries.

## Blast radius — tests that encode "always masked"

`tests/codex-integration/codex-auth-api.test.ts:1281`, `:1289-1305`, and `:5769-5773`
(the last is a source-contains assertion on the literal `maskEmail(st.email)`, so it
breaks on refactor even when behaviour is preserved);
`tests/oauth/oauth-status-privacy.test.ts:55-70`;
`tests/oauth/oauth-accounts-api.test.ts:260-269`;
`tests/oauth/oauth-login-summary.test.ts:17`;
`tests/cli/cli-status-oauth-health.test.ts:113`;
`tests/gui/provider-workspace-auth.test.ts:51`.

All of these stay green if the default is unchanged; they only need the new
opt-in case added alongside.

## `privacy:scan` does not cover this

It scans **tracked source** for email-shaped text
(`scripts/privacy-scan.ts:204-227`) and allows `example.test`, `example.com`,
`test.com`, `*.test` (`:94-113`). Unmasking at runtime is invisible to it. The
practical rule for this PR: never put a non-`example.*` address in a fixture.

## Regression test

`src/lib/privacy.ts` maps to `tests/lib/` via the explicit
`privacy-mask-account.test.ts` entry (`layout.json:958`) — extend that file for the
helper, and keep wire contracts in `tests/oauth/` and `tests/codex-integration/`.

In `tests/oauth/oauth-status-privacy.test.ts`, with a credential saved as
`person@example.test`: with `privacy.maskEmails === false`, `getLoginStatus("xai")`
returns the full address (red today, which still returns `p***n@example.test`);
omitted or `true` still returns the masked form. Mirror it for the Codex pool DTO.

## PR

`feat(privacy): let an operator opt out of email masking` — branch
`lane-b/3-3859`, PR base `lane-b/2-4075`. Closes #3859.
