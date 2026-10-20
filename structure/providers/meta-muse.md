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
