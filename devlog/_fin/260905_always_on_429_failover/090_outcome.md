# 090 — Outcome

Shipped as `fix(oauth): always fail over to another credential on 429`.

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

## Known follow-up

`gui/src/i18n/en.ts:1818` `anthropicPool.disabledDesc` ("Uses only the active Claude account")
is now stale — with the pool off a 429 does move. `gui/` was kept out deliberately: an
`AGENTS.md` screenshot gate plus a ten-locale copy pass does not belong in a routing fix. Owed
as its own change.
