# 010 — wp7e: presence-driven activation for generic OAuth 429 failover (#2568d)

## Owner decision (resolves the wp7 escalation)

`devlog/_plan/260825_owner_backlog_and_bugpr_closeout/111_wp7_audit_response.md` closed wp7d as
**NEEDS_HUMAN**: rotating on a 429 spends a second subscription account's quota, so the agent
refused to pick the default. The owner has now decided, in these words: "이거는 그냥 항상
켜지도록해" — always on.

That settles exactly one question, the *default*. It does not delete the escape hatch, and it
does not change the mechanism, the exclusions, or the bounds.

## Loop spec

- **Archetype:** single-cycle amendment to a shipped subsystem.
- **Trigger:** owner decision on the wp7d escalation.
- **Goal:** with 2+ logged-in accounts for an OAuth provider that has no pool of its own, a 429
  rotates to another account with no configuration step.
- **Non-goals:** Codex pool semantics, Anthropic pool semantics, new rotation mechanism, new
  provider coverage, logging of account identity.
- **Verifier:** `bun test tests/generic-oauth-failover.test.ts tests/adapter-event-oauth-failover.test.ts`
  plus `bun x tsc --noEmit`.
- **Stop condition:** the two suites green, #2568 verified CLOSED, change on `dev`.

## What changes

One function's default branch, plus a per-provider override the issue's own example asks for.

`isGenericOAuthFailoverEnabled(config, providerName)` currently reads
`config.oauthAccountFailover?.enabled === true`, which is false for every install that never
edited its config. It becomes a three-step precedence:

1. `providers.<name>.oauthAccountFailover.enabled` when it is an explicit boolean — a
   per-provider override, because a user may accept rotation on xAI and refuse it on Cursor.
2. `oauthAccountFailover.enabled` when it is an explicit boolean — the global switch, unchanged
   in meaning. An operator who already wrote `false` keeps single-account behaviour.
3. Otherwise **presence-driven**: enabled when the provider has 2 or more eligible stored
   accounts.

### Why presence, not a bare `true`

Returning an unconditional `true` would be wrong, and not only stylistically. This predicate
guards more than the rotation loops: at `core.ts:4660` and `:4745` it decides whether the
runTurn event stream is wrapped in `preflightRunTurnFailover`, which buffers events until the
first meaningful one arrives. For a single-account install that wrapper can never rotate — the
rotator returns `null` at `accounts.length < 2` — so it would be pure added latency on the
streaming path for users who get nothing from it.

Presence is also the consent argument the issue itself makes, and the one `hasKeyPoolFailover`
already applies to a 2+ key pool: logging in a second account is the decision. One account is a
strict no-op, exactly as it is today.

"Eligible" here means the same thing it means everywhere else in this module — not flagged
`needsReauth`. A second account that has been revoked is not a second account, and counting it
would arm the preflight wrapper for a user who still cannot rotate.

## File change map

| File | Change |
| --- | --- |
| `src/oauth/generic-account-failover.ts` | `isGenericOAuthFailoverEnabled` gains the precedence chain; new presence helper reading `getAccountSet` |
| `src/types/provider.ts` | `OcxProviderConfig.oauthAccountFailover?: { enabled?: boolean }` |
| `src/types/config.ts` | doc comment on `oauthAccountFailover` rewritten: no longer opt-in / default OFF |
| `docs-site/src/content/docs/reference/configuration/providers.md` | default column, opt-out instructions, caution box rewritten |
| `tests/generic-oauth-failover.test.ts` | activation tests rewritten for the new default; opt-out coverage at both levels |
| `tests/adapter-event-oauth-failover.test.ts` | config no longer needs to set the knob; add an explicit-false case |

No change to `core.ts`. The call sites already ask the predicate; only its answer moves.

## Field chain (PLAN-FIELD-CHAIN-01)

`oauthAccountFailover` as a **provider-level** key:

- **Creation:** hand-edited config, or a future management write. No CLI flag is added.
- **Serialization:** whole-config save; `providerConfigSchema` ends in `.passthrough()`
  (`src/config.ts:533`), so the key survives a load/save round trip without a schema edit.
- **Deserialization:** same passthrough. A non-boolean value falls through to the next
  precedence step rather than throwing, because a malformed knob must not take a provider out of
  service.
- **Consumers:** `isGenericOAuthFailoverEnabled` only. Verified by `rg`: the global key has
  exactly one runtime reader today.

## Accept criteria, with activation scenarios

| # | Criterion | How C triggers it | Observable proof |
| --- | --- | --- | --- |
| A1 | Two stored xAI accounts rotate on 429 with no config at all | config object with no `oauthAccountFailover` key, seed 2 accounts, call the rotator | returns the second account id; first is cooled |
| A2 | One stored account is still a strict no-op | seed 1, same call | null, no cooldown recorded, predicate false |
| A3 | Global `enabled: false` still disables | seed 2, global false | null |
| A4 | Per-provider `enabled: false` beats presence | seed 2, provider-level false | null |
| A5 | Per-provider `enabled: true` beats a global false | seed 2, global false + provider true | rotates |
| A6 | A `needsReauth` second account does not create a quorum | seed 2, flag one | predicate false |
| A7 | Codex and Anthropic unchanged | predicate on openai/anthropic with 2 accounts | false |
| A8 | The Cursor adapter-event path rotates with no knob | existing e2e-style test, knob removed from its config | two upstream attempts with different credentials |

## Scope boundary

**IN:** the activation predicate, the per-provider override type, docs, tests.

**OUT:** rotation mechanism, provider coverage, cooldown lengths, the per-request bound, logging,
GUI surface (this key has none today), management API write path.
