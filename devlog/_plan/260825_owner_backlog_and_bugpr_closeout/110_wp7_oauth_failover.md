# 110 — wp7: generic OAuth multi-account 429 failover (#2568)

## Call-site enumeration (audit hazard H4)

Every `hasKeyPoolFailover` reference on dev, and what it actually does:

| File | Status |
|---|---|
| `src/providers/key-failover.ts:86` | the definition |
| `src/server/responses/core.ts:4908` | live 429 rotation loop (streaming) |
| `src/server/responses/core.ts:5252` | live 429 rotation (non-streaming) |
| `src/server/chat-native.ts:248` | live 429 rotation (native Chat) |
| `src/server/responses/compact.ts:86` | **import only** — no call |
| `src/server/responses/collaboration.ts:69` | **import only** — no call |
| `src/server/responses/encrypted-payload.ts:68` | **import only** — no call |

So there are exactly THREE live key-pool rotation sites, not five. The three
import-only files are dead references; they are out of scope here but worth noting, since
the audit's concern was that a rotator could be generalized while leaving live paths
unfixed.

OAuth rotation today exists at exactly two sites, both in `core.ts`
(`:4941` streaming, `:5288` non-streaming), and both are Anthropic-only and gated on
`isAnthropicAccountPoolEnabled`.

## Design

`anthropic-routing.ts` is already written against generic primitives. The provider-specific
parts are three: the constant `PROVIDER = "anthropic"`, the config gate, and token minting
via `getAnthropicPoolAccessToken`. The last one is NOT trivially generic — it enforces a
fail-closed rule about background `local-cli` credential slots that exists because of how
the Claude CLI stores its token. A generic rotator must not silently apply or drop that rule.

Plan: parameterize the rotator by provider, keep the Anthropic credential rule attached to
Anthropic, and let each provider declare whether it participates.

## Consent decision (recorded assumption, HIGH severity — needs owner review)

The issue proposes presence-driven activation: 2+ accounts means rotate, mirroring how a
2-key API pool is treated as consent. `request_user_input` is denied under an active goal,
so I could not ask, and this is a product decision rather than a code one.

**Assumption taken: ship it OPT-IN, not presence-driven.** Reasoning:

- Rotating across subscription accounts spends a second account's quota. An API key pool
  spends the operator's own metered credit; a subscription account is a different kind of
  resource, and the Anthropic pool shipped opt-in for exactly this reason.
- Opt-in is reversible in one direction only that matters: turning it on later costs the
  user nothing, whereas a default-on rotation that surprises someone has already spent the
  quota.
- The audit flagged this specific question as needing explicit review rather than being
  settled by an opt-out knob.

If the owner prefers presence-driven, the change is a one-line default in
`oauthAccountFailoverEnabled` — the mechanism does not change.

## Acceptance

1. A provider with 2+ eligible accounts and the knob on rotates on 429 and replays once.
2. A single-account provider is a strict no-op.
3. The knob off is a strict no-op regardless of account count.
4. Existing Anthropic configuration keeps its current meaning.
5. The Codex pool is untouched.

