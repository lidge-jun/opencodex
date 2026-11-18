# 010 carry #8758: refuse redirects on Anthropic bearer requests

Author: vadymhimself (Co-authored-by trailer). Source head 052e91f32f.

## Change (MODIFY)

- `src/providers/claude-cli-usage.ts` `probeAnthropicUsageQuota`: add `redirect: "error"` to the usage fetch.
- `src/providers/anthropic-reset-grants.ts` `getAccountJson` (status and profile reads) and `claimAnthropicResetGrant`: add `redirect: "error"`.
- `structure/providers/claude-cli-replay.md`, `structure/gui-and-management-api.md`: note the refusal (from the PR).
- `tests/providers/provider-anthropic-usage-windows.test.ts`: the PR's option-capture test (`seen` equals `["error", "error", "error"]`), plus an outcome test: a local `Bun.serve` origin answers every request with a 307 to a second local server; the reset-grant status read, organization read and claim are pointed at the first server through `origin`, and the test asserts the second server received no request, the claim rejects as `AnthropicResetGrantUnknownOutcome` and the reads reject with code `upstream`. Without the fix, fetch follows the 307 and the second server receives the re-posted claim. (The usage probe's URL is fixed, so only the option capture covers it.)

## Proof

Test fails with the `src/` hunks reverted, passes with them. `bun test tests/providers/provider-anthropic-usage-windows.test.ts`.

