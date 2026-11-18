# Meta Muse login

Meta Muse management login in `src/server/management/oauth-account-routes.ts` requires a
server-resolved `gui-session` before starting credential acquisition, including local import,
device login, add-account and reauthentication. This principal is not a checkbox receipt;
forged GUI headers and raw management credentials do not substitute for it. Direct CLI login
and other OAuth providers retain their existing policies. `src/oauth/meta-muse-device.ts`
cancels unparsed authorization/mint failures, including mint429, without reflecting their bodies.
`src/oauth/meta-muse-keychain.ts` reads the measured macOS service/account through `/usr/bin/security`
with a cancellable 120-second approval deadline. The importer publishes a dashboard hint before waiting,
reaps the prompt on timeout/cancellation, and distinguishes missing, denied, interaction-disallowed
and unknown failures without retaining stderr. `src/oauth/meta-muse-errors.ts` provides fixed
reason-based import/validation diagnostics; public error projection reconstructs those messages
from their kind and bounded HTTP status, never mutable messages, OS errors or credential text.
Invalid pointer/secret JSON shapes are refused before property access. Import failures keep
the existing credential and offer explicit key paste recovery when available, without silently
initiating a second login. Import and paste validation use `x-api-version: 1.0.0` and reject redirects.
Management discovery and changing device/manual instructions follow the
[OAuth continuation contract](../gui-and-management-api.md#oauth-login-continuations); discovery
filters the current principal without changing the direct CLI roster or relaxing login admission.

`src/oauth/meta-muse.ts` imports only the verified macOS pointer/Keychain shape.
Successful import takes precedence over device login; add-account and reauthentication
skip import. Missing local identity falls through to device login. Existing but unreadable
credentials never trigger an automatic grant: an explicit paste may recover the login.
Neither the OAuth account token nor an imported email is reused by a manual-key recovery.
`src/oauth/login-cli.ts` prints instruction-only hints without announcing or launching a browser.

`tests/providers/meta-muse-keychain.test.ts` exercises the subprocess deadline and cleanup
without invoking the real Keychain. `tests/oauth/oauth-meta-muse-login-diagnostics.test.ts`
covers public projection, shape refusals, cancellation and explicit paste recovery.

`src/providers/meta-muse-plan-refusal.ts` recognizes Meta's runtime refusal (#8352): a 403
whose OpenAI-compatible `error.message` is the whole "This API key is billed to a Muse Code
subscription" sentence, at most 8,192 UTF-16 code units, where `type` and `code` may be absent or
`null` and any other value must be on an allowlist. After HTTP error formatting the same verdict
also accepts the `Provider error 403: ` framing of that envelope, the bare sentence, and the
proxy's own replacement message, so a later formatting pass keeps the class. The match is
deliberately narrow, in the shape of `src/providers/anthropic-billing-refusal.ts` — a missed
match relays Meta's own text, while a loose one would relabel an unrelated permission denial.
`classifyError` in `src/lib/errors.ts` answers `subscription_required` with one fixed sentence
naming the restriction and the `meta-model` pay-as-you-go alternative, so the request-log code,
the dashboard diagnostics and the client body all agree that this is a plan restriction on a
valid credential rather than a rejected or expired one. `src/server/responses/passthrough-error.ts`
replaces the relayed body, and both `src/server/responses/passthrough-delivery.ts` and
`src/server/responses/adapter-dispatch.ts` stamp the `quota-exhausted` failure cause, whose
resend verdict is `refused-futile`. The refusal is never retried, never rotates a key or
account, never reaches the account auto-pause roster, and never impersonates the Muse Code
client. `tests/providers/meta-muse-plan-refusal.test.ts` covers the bounded match, the
classification, the diagnostic code, the client sentence and the registry/docs wording.
