# Provider Quota Dashboard Implementation

Date: 2026-07-05

## Outcome

- Added `/api/provider-quotas` for active configured providers with quota-capable credentials.
- Reused ChatGPT/Codex WHAM quota data for forward `openai`/`chatgpt` providers.
- Added xAI OAuth quota via `https://cli-chat-proxy.grok.com/v1/billing`.
- Added Anthropic OAuth quota via `https://api.anthropic.com/api/oauth/usage`, but only when the stored access token is still fresh. This path intentionally does not refresh Anthropic in the background.
- Added Google Antigravity OAuth quota via `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`, using the stored Cloud Code Assist `projectId` and collapsing model quota info into Gem/Cla rows.
- Kept the response as an allowlisted DTO: provider id, label/source, normalized quota windows, and timestamps only.
- Extracted shared `QuotaBars` from Codex Auth and reused it under Provider cards.
- Added provider SVG assets and static provider icon mapping.

## Security Notes

- No raw upstream response body, email, access token, refresh token, or arbitrary upstream field is returned by `/api/provider-quotas`.
- Google Antigravity project ids are sent upstream but not returned in the management API response.
- Disabled providers and providers without active quota rows are omitted.
- The endpoint is registered inside the management API path, so it inherits the existing management origin/auth checks.

## Verification

- `bun test ./tests/` passed: 1387 tests.
- `bun run privacy:scan` passed.
- `bun run typecheck` passed.
- `cd gui && bun run build` passed.
- Targeted `bun test tests/provider-quota.test.ts` passed.
- Playwright render smoke with mocked API:
  - Desktop 1280x950: provider cards 4, quota rows 3, icons 4, broken icons 0, horizontal overflow 0.
  - Mobile 390x844: provider cards 4, quota rows 3, icons 4, broken icons 0, horizontal overflow 0.
