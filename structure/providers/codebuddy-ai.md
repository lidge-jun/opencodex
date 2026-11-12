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
