# Qoder CLI providers

OpenCodex supports Qoder Global through Qoder's official Personal Access Token and headless CLI.
It does not read Qoder Desktop sessions, browser cookies, refresh tokens, or private console APIs.

## Qoder Global

1. Install the official CLI: `npm install -g @qoder-ai/qodercli`.
2. Create a PAT from `https://qoder.com/account/integrations`.
3. Add the `qoder` provider in `ocx init` or the Providers workspace and paste that PAT as the API key.
4. Run `ocx provider test qoder` to verify CLI authentication and account-specific model discovery.

OpenCodex passes the stored key only as `QODER_PERSONAL_ACCESS_TOKEN` in a scoped child environment.
The adapter accepts only the canonical `https://qoder.com` destination. A legacy custom provider
named `qoder` with another destination keeps its existing adapter and URL.

The CLI is invoked in one-turn `stream-json` mode with built-in tools disabled (`--tools ""`), MCP
restricted with an empty strict configuration, setting sources disabled, and session persistence
disabled. Codex remains the only tool owner. The first version is text/reasoning only; image input
fails explicitly until the provider route has verified multimodal evidence.

`qoder --list-models` is the authoritative entitlement roster for the current PAT. OpenCodex uses
its normal model cache and credential-generation invalidation. If discovery fails, it degrades to a
stale cache and then the documented static seed. Quota totals and reset times remain unavailable
because no public quota API is used; insufficient-credit errors are still surfaced as HTTP 429.

Free, trial, promotional, and subscription credits are expected to use the account attached to the
official PAT/CLI, but the exact product eligibility is account-controlled and is not inferred by
OpenCodex. There is no automatic regional failover or credential exchange. The companion Qoder CN
integration is intentionally delivered as a separate provider/PR with its own PAT, CLI profile,
model entitlement, cache, usage, and health state.

Primary sources (verified 2026-09-03):

- Installation: <https://docs.qoder.com/cli/installation>
- PAT authentication: <https://docs.qoder.com/cli/authentication>
- Headless scripts and CI: <https://docs.qoder.com/cli/run-in-scripts>
- Account model discovery: <https://docs.qoder.com/cli/model>
- SDK/tool configuration: <https://docs.qoder.com/cli/sdk/references-typescript>
- Terms: <https://qoder.com/product-service>

The service terms identify BRIGHT ZENITH PRIVATE LIMITED as the operator. This integration uses the
documented CLI automation surface; maintainers should still make the final routing/AUP determination.
