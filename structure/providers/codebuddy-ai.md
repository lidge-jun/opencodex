# CodeBuddy AI Subscription

`codebuddy-ai` uses the international CodeBuddy subscription at `https://www.codebuddy.ai`.
It mirrors the [WorkBuddy AI contract](workbuddy.md) with the origin, client identity
(`CLI/2.180.0 CodeBuddy/2.180.0`) and the private `codeBuddyAi` credential metadata swapped.
Both gateways share the Tencent wire shapes, so behavior, bounds and security rules match.

## Modules

- `src/oauth/codebuddy-ai.ts`: browser login (`platform=CLI`), team resolution and account-bound refresh.
- `src/providers/codebuddy-ai.ts`: fixed origin, destination assertion, headers and catalog identity.
- `src/adapters/codebuddy-ai.ts`: OpenAI Chat contract over upstream SSE; `src/adapters/codebuddy-ai-schema.ts` normalizes tool schemas.
- `src/providers/codebuddy-ai-models.ts`: extracts the `cli` agent roster from `/v3/config`.
- `src/providers/quota/codebuddy-ai.ts`: reads the credit meter and reuses the display-only `workbuddyCredits` quota DTO field and its GUI panel.

## Verification

`tests/oauth/codebuddy-ai-login.test.ts`, `tests/adapters/codebuddy-ai-adapter.test.ts`,
`tests/providers/codebuddy-ai-provider.test.ts` and `tests/providers/codebuddy-ai-quota.test.ts`
mirror the WorkBuddy suites.

## Live verification

Verified against the international CodeBuddy service on 2026-11-15, driving this branch's own
OAuth, discovery, quota and adapter code:

- Token refresh through `refreshCodeBuddyAiToken` against `/v2/plugin/auth/token/refresh`.
- Live catalog read from `GET /v3/config`, returning 26 model ids parsed by
  `extractCodeBuddyAiModels`.
- Live credit meter read through `fetchCodeBuddyAiQuota`, reporting 220 total / 220 used credits.
- Live chat turn through `createCodeBuddyAiAdapter`'s built request, sent to
  `https://www.codebuddy.ai/v2/chat/completions` with the `CLI/2.180.0 CodeBuddy/2.180.0`
  user agent, `X-Domain: www.codebuddy.ai` and `X-IDE-Type: CLI`, answering `PONG` on the
  `hy3` free model.
