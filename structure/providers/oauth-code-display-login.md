# OAuth code-display login

Owner of the headless `mode: "code"` login on `POST /api/oauth/login`
(`src/server/management/oauth-account-routes.ts`). The route summary lives in
[GUI and management API](../gui-and-management-api.md); this page holds the contract.

For hosts whose browser cannot reach the proxy's loopback callback (containers, remote servers,
hosted agents), `POST /api/oauth/login` accepts `mode: "code"`. The provider then redirects to its
own code page and shows `code#state`, which the operator pastes back. No callback server is bound
and no browser is launched. Omitting `mode` (or sending `"callback"`) keeps the loopback flow
unchanged.

- **Providers.** Only a provider with a `codeRedirectUri` supports it (`supportsCodeLoginMode` in
  `src/oauth/index.ts`); today that is `anthropic` alone
  (`https://platform.claude.com/oauth/code/callback`). Any other provider is refused with
  `400 {"error":"code_mode_unsupported"}`. The Codex spellings of `ocx login` (`codex`, `openai`,
  `chatgpt`) refuse `--code` and point at `ocx account login codex --device`, because account-auth
  owns a valued `--code <code>` that would otherwise read the provider name as the code
  (`src/cli/dispatch.ts`).
- **Flow identity and ownership.** A code-mode start returns `{ mode: "code", flowId, expiresAt }`.
  Flows are keyed by `flowId` in `src/oauth/login-flow-state.ts`, so several code logins for one
  provider can be in flight at once; a callback-mode flow still serialises per provider. Every
  lookup is provider-scoped (`loginFlowKeys` matches `(state.provider ?? key) === provider`), so
  status, cancellation, clearing and the admission cap never see another provider's flows. A
  cancel naming a `flowId` that belongs to a different provider is refused.
- **Expiry and limits.** A code flow's paste window is `CODE_LOGIN_TTL_MS` (10 minutes); an expired
  flow is reaped as `no_pending_login` the next time that provider starts a login. At most
  `MAX_LOGIN_FLOWS_PER_PROVIDER` (64) rows per provider are kept; settled rows are evicted first
  and a flow still in progress is never evicted.
- **Paste contract.** `POST /api/oauth/login/code` with a `flowId` (or while the provider's newest
  flow is code-mode) answers with the **outcome of the token exchange**, not merely acceptance:
  `{ ok: true, account }` or `{ ok: false, error }` where `error` is one of `state_mismatch`,
  `invalid_or_expired_code`, `no_pending_login` (409), `provider_unreachable`, `malformed_input`.
  A rejected paste leaves the flow alive for another attempt. `provider_unreachable` is reserved
  for a network failure (`TimeoutError`/`AbortError`, or a fetch `TypeError` carrying a `code`);
  any other error falls to `invalid_or_expired_code`, with the original message kept on the flow.
  Without a `flowId` and with no code-mode flow, the legacy accept-only contract is unchanged.
- **Status.** `GET /api/oauth/status` reports the provider's newest flow, including `mode` for a
  code flow. A caller running several flows tracks each one through its own paste response.
- **Account store semantics: single operator.** A successful code login writes the same credential
  store as any other login, and the store has one active account per provider. Two concurrent code
  logins that both succeed leave the **later** one active. This is a single-operator convenience
  for headless hosts, **not** tenant isolation: do not use it to host several unrelated users on
  one instance.

Tests: `tests/oauth/oauth-code-login.test.ts` (flow keying, cross-provider isolation, error
classification, paste contract) and the `--code` cases in `tests/cli/cli-provider.test.ts`.
