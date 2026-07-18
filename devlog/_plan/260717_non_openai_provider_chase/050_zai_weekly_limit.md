# WP5 — Z.AI weekly-limit terminal classification

## Goal and dependency

Classify an actual Z.AI weekly-plan exhaustion response as terminal quota without reclassifying transient per-minute rate limits or changing unrelated providers.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| NEW | `src/adapters/zai-errors.ts` | Z.AI errors use generic OpenAI-chat classification | parse only documented/captured Z.AI status, code, message, and reset headers into terminal-vs-transient outcome |
| MODIFY | `src/adapters/openai-chat.ts` | no provider-scoped Z.AI formatter hook | call the Z.AI classifier only for the `zai` registry identity/base contract |
| MODIFY | `src/server/responses.ts` | key rotation sees generic 429 | terminal weekly exhaustion does not churn the same key; transient 429 keeps current failover behavior |
| MODIFY | `src/providers/key-failover.ts` | all keyed 429s can cool/rotate | accept a classified terminal hint only if the adapter boundary can preserve CAS and existing providers |
| NEW | `tests/zai-errors.test.ts` | no exact fixture | cover captured weekly exhaustion, transient rate limit, malformed body, reset header, redaction, and sibling provider negative cases |
| MODIFY | `tests/server-key-failover-e2e.test.ts` | generic key pool cases | drive both terminal and transient Z.AI 429 paths end to end |

## Evidence gate

No classifier is written from English phrase guesses. P must first capture a sanitized real error body/status/headers or obtain an official schema. If neither exists, the work-phase ends `NEEDS_HUMAN` with no production code.

## Activation scenarios

- Captured weekly exhaustion returns Codex `insufficient_quota`, preserves a safe reset hint, and performs no immediate retry loop.
- A per-minute 429 remains `rate_limit_exceeded` and retains existing key-pool rotation/cooldown.
- The same phrase under another provider is not classified by Z.AI-specific code.
- Malformed or oversized bodies fail closed to generic error handling without leaking raw content.

## Verification

```bash
bun test tests/zai-errors.test.ts tests/error-fidelity.test.ts tests/server-key-failover-e2e.test.ts
bun run typecheck
```

## Terminal outcomes

- `DONE`: real fixture drives a provider-scoped terminal branch and negative cases pass.
- `NOOP`: generic classifier already maps the real fixture correctly without retry/failover harm.
- `NEEDS_HUMAN`: no real error fixture or quota-limited test account is available.
- `UNSAFE`: obtaining the fixture requires deliberately exhausting a costly production account without an approved cap.
