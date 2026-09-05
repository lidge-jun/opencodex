# 000 — Inventory: where a 429 does and does not move to another credential

## The report

"멀티계정이나 멀티 api 일때 pool 모드가 안 켜져있더라도 429 나면 다른걸로 옮기는 기능이
다 꺼져있어" — with several accounts or several API keys configured, a 429 does not move the
request to another credential unless the operator turned a pool mode on.

The follow-up constraint is what makes this a design change rather than a default flip:
**429 failover must be on by default and must not be switchable off.**

## What actually exists today

Three independent rotators, three different activation rules.

| Surface | Module | Activation | Verdict |
|---|---|---|---|
| API-key pool | `src/providers/key-failover.ts` | `hasKeyPoolFailover`: key auth + `apiKeyPool.length >= 2` | Already unconditional. This is the model to copy. |
| Generic OAuth | `src/oauth/generic-account-failover.ts` | `isGenericOAuthFailoverEnabled`: per-provider bool > global bool > presence (2+ accounts) | On by default, **but an explicit `false` still disables it.** |
| Anthropic OAuth | `src/oauth/anthropic-routing.ts` | `rotateAnthropicAccountOn429` returns `null` unless `isAnthropicAccountPoolEnabled(config)` | **Off by default. This is the reported bug.** |
| Codex (openai) | `src/codex/routing.ts` | `recordCodexUpstreamOutcome` cools + `pickAlternateCodexAccount` promotes, no pool-enable flag | Already unconditional. Leave alone. |

### The Anthropic hole, precisely

`src/oauth/anthropic-routing.ts:456`:

```ts
export function rotateAnthropicAccountOn429(...): string | null {
  if (!isAnthropicAccountPoolEnabled(config)) return null;
```

`anthropicAccountPool.enabled` defaults to absent, so `isAnthropicAccountPoolEnabled` is
`false` on a stock install. An operator who logs into two Anthropic accounts and hits a 429
gets the upstream 429 relayed to the client with no attempt at the second account.

The call sites in `src/server/responses/core.ts` compound it. Both the streaming loop
(`:6173`) and the continuation loop (`:6584`) guard on `anthropicPoolAccountId` being set —
and that variable is only assigned at `:3412`, inside
`if (route.providerName === "anthropic" && isAnthropicAccountPoolEnabled(config))`. So with
the pool off there is not even an account id recorded to cool. The rotation is doubly dead:
no identity captured, and the rotator would refuse anyway.

### The generic OAuth hole

`isGenericOAuthFailoverEnabled` reads presence as consent (#2568d), which is right. But the
precedence chain lets `oauthAccountFailover.enabled: false` — global or per provider — turn
reactive rotation off entirely. The user's instruction removes that possibility.

## The distinction this unit introduces

The reason Anthropic gated rotation behind the pool flag is that its pool bundles two very
different behaviours under one switch:

- **Proactive routing** — session affinity, quota-ranked new-session selection,
  `autoSwitchThreshold`, `strategy`. This changes which account serves a *healthy* request.
  It is experimental, it has provider-terms implications, and it stays opt-in.
- **Reactive failover** — the account that just returned 429 is cooled and the request is
  retried on another usable account. This only ever runs *after* upstream refused. It cannot
  spread load, cannot cross-contaminate a session, and cannot fire at all unless the operator
  deliberately logged in twice.

Reactive failover is a safety net, not a routing policy. That is why it can be non-disableable
without breaking the caution the pool flag was written to express: with the pool off, the
operator still gets exactly one account per session — they just stop getting a hard 429 when
that account is spent and a second one is sitting idle.

## Non-goals

- No change to Codex quota scopes or probe leases.
- No change to combo failover.
- No weakening of `isPoolCredentialUsable` (the fail-closed `local-cli` rule).
- No new proactive behaviour for anyone who has not opted in.

## Implementation phases

- `010` — Anthropic reactive/proactive split.
- `020` — Generic OAuth: make reactive rotation non-disableable.
- `030` — Types, docs and surface alignment.
