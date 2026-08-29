# 050 — Phase 5: verification, head-to-head proof, delivery

Work class: C2. Depends on: `010`–`040`.

## Verification matrix

| Gate | Command | Reads this unit's target? |
| --- | --- | --- |
| Preflight | `bun install` (root), `cd gui && bun install` | Prerequisite — without it every gate below fails on missing `bun-types`/`zod`/`oxlint` |
| Types | `bun x tsc --noEmit` | Yes — strict, whole project |
| Focused tests | `bun test tests/kiro-usage-quota.test.ts tests/kiro-account-quota.test.ts tests/kiro-pool-rank.test.ts` | Yes — direct arguments |
| Regression | `bun test tests/provider-quota.test.ts tests/provider-account-quota.test.ts tests/generic-oauth-failover.test.ts tests/adapter-event-oauth-failover.test.ts` | Yes |
| Full suite | `bun run test` | Yes — required, this touches shared routing/config/server |
| Privacy | `bun run privacy:scan` | Yes — reads `src/` and `devlog/` |
| GUI lint | `bun run lint:gui` | Only if GUI source changes |

`bun run test` is not optional here: AGENTS.md requires the full suite for shared
routing/config/server changes, and `quota.ts` plus the failover path qualify.

## The head-to-head claim

The user's bar is "확언할 수 있을 때까지" — able to state with confidence that we are
better. That requires a table where **every one of our claims cites our code** and **every
kiro-lb claim cites its file:line**, written after the implementation, from the landed
tree. Not from this plan.

Draft axes (to be filled with evidence at C, not asserted now):

| Axis | kiro-lb | opencodex (to prove) |
| --- | --- | --- |
| Usage source | `GetUsageLimits`, 900s background poll | same operation, pull-on-demand, no timer |
| Freshness | 15 min default poll | 5 min provider-level display cache; 10 min per-account cache |
| Breakdown selection | `AGENTIC_REQUEST` else index 0 | priority list, unknown → unavailable |
| Free trial pool | dropped | separate window |
| Recovery ordering | reactive ring walk after 429 | headroom-ranked ring after 429 |
| Pre-request selection | weighted random, model-blind | **not shipped in this unit** (deferred) |
| Unknown account | numeric weight | categorical known-healthy > unknown > known-exhausted |
| Exhaustion | 6h–32d quarantine | reset-aligned, clamped 5min–24h |
| Identity safety | per-account auth manager | per-account snapshot, cross-pairing regression test (#2841 lineage) |
| Idle cost | polls every 60s minimum | zero requests when idle |
| Scope | Kiro only | Kiro is one provider among many, same seam |

Honesty requirement: kiro-lb has a dedicated operations dashboard with request-rate charts,
per-model token panels and Prometheus export. We do not, and the table must say so. A
comparison that only lists our wins is marketing, and the user asked for confidence, not
cheerleading.

Two more rows must stay in the "they are ahead" column: kiro-lb selects an account
**before** the request (model-blind, but pre-dispatch), and it persists quota rows across
restart to seed routing. This unit does neither.

## Delivery

- Branch: `codex/kiro-quota-pool` off current `dev`.
- Commits: one per phase (`010`…`040`), plus the devlog unit.
- PR against `dev`, full template (Summary / Verification / Checklist), GUI screenshot.
- Push with `--no-verify` (user-authorized), merge after CI green.
- Move `devlog/_plan/260829_kiro_quota_pool/` → `devlog/_fin/` at close-out, since the
  fix will be public by then.

## Security note

Nothing in this unit is pre-disclosure material: the cross-account pairing invariant is
already public via merged #2841, and everything here is a forward-looking feature. So the
devlog unit is the right home. If implementation *uncovers* an unfixed weakness, that
write-up goes to `.tmp/`, not here.

## Terminal outcome

`DONE` requires: all gates green, the head-to-head table written from the landed tree, the
PR merged into `dev`. Anything less is reported as its real outcome, not rounded up.
