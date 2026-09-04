# 090 — Outcome

Shipped in three pull requests:

| PR | Merge | What |
|---|---|---|
| [#3495](https://github.com/lidge-jun/opencodex/pull/3495) | `56a084aa9` | the failover fix itself |
| [#3499](https://github.com/lidge-jun/opencodex/pull/3499) | `26a2e512a` | GUI copy the fix invalidated |
| [#3503](https://github.com/lidge-jun/opencodex/pull/3503) | `6edc56328` | a per-request store read #3495 introduced |

The second and third were not planned. Both were found by auditing the merged result against
the tree rather than against the plan, and both are recorded in `091`.

## What changed

| Surface | Before | After |
|---|---|---|
| `apiKeyPool` | presence-activated | unchanged (this was the model) |
| Generic OAuth reactive | presence, but `enabled: false` disabled it | presence only, not disableable |
| Generic OAuth proactive | shared the same predicate | own predicate, `enabled: false` still refuses |
| Anthropic reactive | dead unless `anthropicAccountPool.enabled` | presence-activated, flag-independent |
| Anthropic proactive | behind the flag | unchanged, still behind the flag |
| Continuation loop | keys + Anthropic only | keys + Anthropic + generic OAuth |
| Sidecar `on429` hook | keys + generic OAuth only | keys + generic OAuth + Anthropic |

## Verification

No repository-wide local suite (standing instruction). `bun run typecheck` clean; eight focused
files green, 232 pass / 0 fail. Receipt:
`.codexclaw/evidence/01a06d31-a387-7320-a093-dfe3ece724fe/test-receipt.json` (97 pass across the
five failover-critical files). Repository-wide validation is delegated to CI on the exact PR head.

One failure appears when `management-provider-validation.test.ts` runs in the same invocation as
the pool tests. It is pre-existing cross-file interference, proven by stashing `src` and `tests`
and reproducing it identically on the unmodified tree; the file passes 97/97 alone.

## Review history

Three audit rounds, same reviewer (`xai/grok-4.6`), recorded in `001_audit_round_1.md`. Round 1
failed with four blockers — two of them surfaces the plan had missed entirely. Round 2 failed
with one: the proposed sidecar Anthropic arm sat behind an early `return null` and would have
been dead code that a naive string test still passed. Round 3 passed. Every finding was folded
in; none was rebutted.

## Follow-ups — both closed

`gui/src/i18n/en.ts:1818` `anthropicPool.disabledDesc` ("Uses only the active Claude account")
went stale the moment #3495 landed: with the pool off a 429 now does move. Deferring it out of
the routing PR was right — an `AGENTS.md` screenshot gate plus a ten-locale copy pass does not
belong there — but leaving it deferred was not, because the toggle would have sent an operator
to the EXPERIMENTAL pool to buy failover they already had unconditionally. Closed by #3499.

The per-request auth-store read is the more serious of the two and is written up in `091`.
