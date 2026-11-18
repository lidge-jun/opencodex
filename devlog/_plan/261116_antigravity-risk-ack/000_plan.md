# 000 — Antigravity OAuth risk acknowledgement: Plan

## Objective

Google Antigravity sign-in uses an OAuth login issued for Google's own Antigravity app. Users of
third-party tools have reported their Google accounts being disabled with Cloud Code Assist's
"This service has been disabled in this account for violation of Terms of Service." (recognised
already by `src/oauth/account-auto-pause-policy.ts`; reports in google-gemini/gemini-cli #19501,
#20813, #27199, #27388). Before this change the dashboard showed the generic high-risk copy, and
the CLI and API started an Antigravity login with no warning at all.

Outcome: every way to add an Antigravity account shows a strong, factual warning and requires an
explicit acknowledgement; the management API refuses one that does not carry it.

## Loop-spec

- Loop archetype: verifier-defined (tests + typecheck + lint).
- Write scope: `src/oauth/antigravity-risk.ts` (new), `src/server/management/oauth-account-routes.ts`,
  `src/cli/account-auth.ts`, `src/cli/account-extended.ts`, `src/oauth/login-cli.ts`,
  `src/cli/dispatch.ts`, CLI capability/registry text, `gui/src/oauth-tos-risk.ts`,
  `gui/src/components/OAuthTosWarningModal.tsx`, GUI login/import call sites, `gui/src/i18n/*.ts`,
  one new stylesheet, docs-site English reference pages, tests.
- Out of scope: other providers' risk copy, desktop tray and menubar (they only list and switch
  existing accounts), translated docs pages.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1 | 010_phase1.md | contract, server gate, CLI gates, GUI danger dialog, copy, tests, docs | — |

## Accept criteria

- `POST /api/oauth/login` and `POST /api/oauth/accounts/import` for `google-antigravity` return 403
  `antigravity_risk_not_acknowledged` unless the body carries `acknowledgeAntigravityRisk: true`.
- `ocx login`, `ocx account login`, `ocx account import` print the warning, ask y/N on a terminal,
  accept `--accept-antigravity-risk` for non-interactive use, refuse otherwise before any request.
- Dashboard Antigravity dialog is danger-styled, checkbox unchecked on every open, Continue disabled
  until checked; login, add-account, reauth and Cockpit import all go through it.
- Every GUI locale carries the Antigravity keys, quoting the ban message verbatim.
- Other providers' flows unchanged.
