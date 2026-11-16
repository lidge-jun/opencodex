# 010 — Phase 1: acknowledgement contract and gates

## MODIFY / NEW / DELETE map

- NEW `src/oauth/antigravity-risk.ts`: `ANTIGRAVITY_RISK_ACK_FIELD = "acknowledgeAntigravityRisk"`,
  `ANTIGRAVITY_RISK_CLI_FLAG = "--accept-antigravity-risk"`, `ANTIGRAVITY_RISK_REFUSAL_CODE`,
  `ANTIGRAVITY_TOS_BAN_MESSAGE`, `requiresAntigravityRiskAcknowledgement`,
  `hasAntigravityRiskAcknowledgement`, `antigravityRiskRefusalBody`, CLI warning text and
  `resolveAntigravityRiskAcknowledgement({flag, interactive, warn, ask})`.
- MODIFY `src/server/management/oauth-account-routes.ts`: after the public-provider check in
  `/api/oauth/login` and before `importAccounts` in `/api/oauth/accounts/import`, return
  `403 antigravityRiskRefusalBody()` when required and absent.
- MODIFY `src/cli/account-auth.ts` (`login`): parse the flag (google-antigravity only), resolve the
  decision before any request, send the field.
- MODIFY `src/cli/account-extended.ts` (`cmdImport`): same gate before source I/O; send the field.
- MODIFY `src/oauth/login-cli.ts` (`handleOAuthLogin`) + `src/cli/dispatch.ts`: same gate for the
  in-process `ocx login`, flag parsed in dispatch.
- MODIFY `gui/src/oauth-tos-risk.ts`: Antigravity copy keys with `tone: "danger"`, plus
  `oauthRiskAcknowledgementBody(provider)`.
- MODIFY `gui/src/components/OAuthTosWarningModal.tsx`: danger header/icon, error notice, condition
  list, danger Continue button; new `gui/src/styles/oauth-tos-danger.css`.
- MODIFY `gui/src/pages/use-providers-oauth.ts`, `gui/src/pages/Providers.tsx`,
  `gui/src/components/use-add-provider-oauth.ts`, `gui/src/components/AddProviderModal.tsx`: thread
  `riskAcknowledged` from the dialog continuation into the login body.
- MODIFY `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`: Cockpit import opens the
  dialog first and sends the field.
- MODIFY `gui/src/i18n/{en,ko,de,fr,ja,pt,ru,tr,vi,zh,zh-TW}.ts`: six `oauthTos.antigravity*` keys.

## TESTS

- `tests/oauth/antigravity-risk.test.ts` (new): decision function, API refusal for login and import,
  acceptance reaches the flow.
- `tests/cli/cli-account-login-options.test.ts`: non-TTY refusal with no request, flag sends field,
  TTY y/N.
- `ocx login` gate test beside the existing login-cli tests.
- `tests/gui/oauth-tos-warning.test.ts`, `gui/tests/oauth-tos-warning-modal.test.tsx`,
  `gui/tests/provider-account-import.test.tsx`: copy keys, danger dialog, reset, locale anchors,
  import requires the dialog.

## Verification (C)

- `bun run typecheck` → 0; `bun run lint:gui` → 0; focused `bun test` files above → 0 fail;
  touched GUI tests → 0 fail; `bun run test:changed`;
  `bun run skill:surface:check`, `bun run structure:check`, `bun run privacy:scan` → 0.
