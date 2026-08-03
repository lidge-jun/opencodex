# 000 — Cooldown recovery probe (#915)

Reserved unit. Deferred out of `260803_pr_issue_sweep` because the fix is not a
guard on an existing path — it needs a new contract.

## The defect

A reset-derived cooldown excludes account A from selection
(`src/codex/routing.ts:734-760`), and the alternate selectors only ever see the
eligible list (`:927-965`). Probe eligibility exists and is correctly limited to
non-`Retry-After` cooldowns with one lease per interval (`:369-423`) — but
`resolveCodexAuthContext()` selects the account first
(`src/codex/auth-context.ts:214-226`) and only then checks that selected
account's lease (`:237-253`).

So when account B stays eligible, B is always selected, A is never selected,
and A never reaches the lease code that would probe it. A recovers upstream and
the pool never notices.

A fresh WHAM read does not rescue it: pool results call
`setAccountQuotaFromParsed()` (`src/codex/auth-api.ts:590-626`), which writes
the quota cache (`src/codex/quota.ts:134-179`) and has no authority over
routing cooldown generations.

## Why it is its own unit

The fix is a background recovery worker with a claim/settle contract, fenced on
cooldown generation, quota scope, and credential generation — not a tweak to
account selection. It crosses routing state, auth resolution, WHAM refresh
concurrency, account generations, and quota scopes. Bundling that with four
other changes to the same subsystem, in one cycle, is how a subtle
concurrency bug ships.

Two constraints already established and worth not rediscovering:

- `clearCodexAccountCooldown()` must **not** be used. It clears every scope and
  carries no credential fence.
- The existing per-account quota refresh at `src/codex/auth-api.ts:646-688` is
  already generation-aware and single-flight, so it is the right thing to join
  rather than duplicate.
- "A 100% WHAM snapshot must never move an existing thread" is a *policy*
  change to the quota strategy's deliberate rebinding at
  `src/codex/routing.ts:1179-1200`, not part of this fix. Do not smuggle it in.

## Status

Not started. Sequenced after `260803_pr_issue_sweep` closes.
