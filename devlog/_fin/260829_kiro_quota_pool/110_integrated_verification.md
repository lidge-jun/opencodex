# 110 — Integrated verification on dev

Three PRs landed separately, so the last thing worth proving is that they compose.
Verified against `origin/dev` at `3e3df05aa`, which contains all three plus unrelated
work merged in between (`6703aba88`, `b9cb23656`).

## What is on dev

| PR | Merge | What it delivered |
| --- | --- | --- |
| [#2875](https://github.com/lidge-jun/opencodex/pull/2875) | `d82b3049d` | Kiro usage reader, per-account + provider quota, quota-aware 429 recovery, CLI column, docs |
| [#2878](https://github.com/lidge-jun/opencodex/pull/2878) | `12fbb5b7a` | Pre-dispatch account selection |
| [#2880](https://github.com/lidge-jun/opencodex/pull/2880) | `3e3df05aa` | Quota persistence across restart |

## Result

```text
bun x tsc --noEmit -> exit 0
bun test (9 files) -> 259 pass / 0 fail / 756 expect() calls
```

Files: `kiro-usage-quota`, `kiro-account-quota`, `kiro-pool-rank`,
`provider-account-quota-persistence`, `provider-account-quota`, `provider-quota`,
`generic-oauth-failover`, `cli-headless-parity`, `core-lab-boundary`.

The last of those matters independently: none of this work put a Lab import on the
request path, which the boundary walker verifies transitively rather than by inspection.

## Known unrelated failures

`bun run test` reports three failures in
`tests/codex-envkey-admission-substitution.test.ts`. They reproduce on unmodified
`124a2b148` in a separate clean worktree, so they predate this unit and are not caused
by it.

## Objective status

- **Kiro quota display** — done. Per-account and provider rows, GUI bars, CLI column,
  explicit unknown state.
- **Pool-based automatic loading** — done in both directions: quota-ranked selection
  before the first request, and quota-ranked rotation after a 429, with exhaustion
  cooldowns and per-account credential/route pairing.
- **429 PR reconciliation** — done in doc `003`: seven merged, two superseded by #2841,
  nothing needing rework. #2783 is a separate open unit.

What remains kiro-lb's, honestly: an operations dashboard and dashboard-native device
login. Both are product surface, not pool machinery.
