# Windows quota network-path evidence

Depends on composed runtime; class C3 investigation and diagnostic documentation. #3644 remains a current-version evidence gap, not a proven entitlement or retry defect.

## Exact map / before-after
- READ src/codex/auth-api.ts fetchMainAccountInfoWhileOwned and listCodexAuthAccountsSnapshot: WHAM uses Bun fetch; quotaRefresh result is identity-fenced. READ src/codex/quota-refresh-outcome.ts enum/projector, src/cli/account-api.ts fetchCodexRows, src/config.ts applyProxyEnvWith, src/lib/windows-system-proxy.ts readWindowsSystemProxy, src/server/index.ts applyProxyEnv call.
- MODIFY docs-site/src/content/docs/reference/configuration/server.md and its seven existing translated counterparts: explain explicit proxy:auto/HTTP proxy versus an unset config and service-start environment; show privacy-bounded ocx account list openai --quota --refresh --json fields quotaRefresh.status and optional httpStatus. Do not paste account ids or credentials. Explain that WinINET/PAC/SOCKS and TUN are not equivalent transport evidence.
- MODIFY numbered outcome record only if current docs already fully cover this; NO runtime policy change without a reproduced categorized failure. Existing diagnostic #3693 (71edeec8807d99e8e56a8c093f74da27d163d47a) already carries Ingwannu's implementation, so no redundant reimplementation.
- Existing tests/codex-integration/codex-auth-api.test.ts, tests/cli/cli-account.test.ts, tests/server/proxy-env.test.ts are remote verifier paths; add fixture only for an uncovered documented config contract.

Before: reporter's 2.43.0 output lacks newly landed quotaRefresh; system proxy mode null quota cannot distinguish direct network failure, HTTP failure or parsing. After: next release exposes already-implemented categories and explicit network setup guidance. A/B same machine/account: TUN on versus TUN off with explicit auto/HTTP configuration; observe status/HTTP code, not raw payload. No Windows environment is fabricated locally.

## Acceptance / completion
Fresh source and CI show diagnostic fields travel enum -> main-account cache -> snapshot -> CLI, with malformed/unrecognized extras dropped and null not converted to zero. Document unsupported PAC/SOCKS-only behavior according to actual code. Leave issue open if reporter evidence is still absent and record FIELD_VALIDATION_PENDING, rather than calling the underlying incident fixed. This evidence-limited investigation outcome satisfies this named investigation slice, not a false runtime fix. No outbound credentials or system configuration changes here.

