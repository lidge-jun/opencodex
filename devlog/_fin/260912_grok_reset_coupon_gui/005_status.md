# Unit status — Grok reset-coupon dashboard surface

## wp1 — in Check

**What shipped.** The xAI account rows in Providers > Accounts carry a ticket badge
with their remaining coupon count, and the badge opens a dialog that lists validity
windows and redeems the coupon closest to expiry. Server side is untouched: both
actions call the routes merged in #4306.

**What the audit changed.** The first implementation would have told a user that a
failed redemption succeeded — the route replays a settled failure as HTTP 200 with
`replayed: true` — and would have retried an aborted redemption against a ledger
record that re-executes, spending a second coupon. Both are fixed; the second is
fixed by refusing to post again at all. A single generation counter would also have
let one row's retry strand its siblings' badges; reads now carry per-account tokens.

**Evidence.**

- `gui/tests/grok-reset-coupons.test.tsx` — 9 pass, covering badge counts, the
  redeem body, replayed failure, 409 id clearing, 503 capacity, the aborted-unknown
  state with no second POST, sibling-read survival, and the three-in-flight bound.
- `cd gui && bun test tests` — 1963 pass / 0 fail (pre-rebase tree).
- Receipt: `.codexclaw/evidence/<session>/test-receipt.json` over
  `grok-reset-coupons` + `locale-parity` + `i18n-locales` — 23 pass / 0 fail.
- `bun run lint`, `lint:i18n`, `build`, `structure:check`, root `typecheck` — exit 0.
- Root `bun run test`: **NOT RUN.** Two local attempts died in a parallel worker with
  SIGSEGV on `tests/routing/routing-policy-surface-parity.test.ts`, which passes
  alone (6 pass); the user then instructed no further local suite runs, so exact-head
  CI on #4330 is the authority.
- Live: a proxy built from this branch read the real account pool and rendered
  0 / 0 / 1 badges; the dialog listed the actual coupon expiring 2026-09-13.

**Delivery.** Issue #4329, PR #4330 into `dev`, screenshots on the never-merged
`codex/pr-assets-grok-coupon-gui` branch.

**Residual, carried not closed.** `src/grok/reset-coupon-ledger.ts:87` returns
`execute` for a record that is still `open`, so any client that retries a timed-out
redemption can spend a second coupon. This unit's client never retries, which is a
mitigation, not a fix. The route-side fix belongs to a follow-up against `src/`.

**What did not improve.** The badge count still costs one billing RPC per account
per panel mount, with no TTL cache. Folding it into the xAI quota probe would make
it free, and that remains the recorded follow-up rather than something this unit
attempted.

