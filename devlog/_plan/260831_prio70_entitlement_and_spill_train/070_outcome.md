# 070 — outcome and receipts

Filled in as each work-phase closes. Every receipt records the command, the host it
ran on, the exit code, and pass/fail counts. Local full suites are forbidden for
this train, so suite receipts name `lidge`.

## wp0 — roadmap (docs-only)

- Status: closing.
- Deliverable: 12 docs — `000` plan, `001`-`003` research, `004`-`006` audit
  syntheses, `010`/`020`/`030`/`040`/`050` decade docs, `070` receipts.
- Branch: `codex/prio70-train-260831` at `903243d04`.
- Research: three read-only `gpt-5.6-sol` high-effort lanes. Every load-bearing
  claim was re-verified in-tree by the main session before it entered a doc.
- Audit: three adversarial `gpt-5.6-sol` rounds, all FAIL, each one amended rather
  than argued with. Round 3 closed the wp1 blocker and positively traced the
  reduced wp1 to a fix for #3022.

### Receipt — wp0 (host `lidge`, Linux x86_64, bun 1.3.14)

```
cd ~/ocx-ci/opencodex && git checkout -B verify-prio70 origin/codex/prio70-train-260831
  -> 903243d04, dirty=0
bun install --frozen-lockfile   -> 106 installs / 145 packages, no changes
bun run privacy:scan            -> exit 0, "Privacy scan passed"
bun run typecheck               -> exit 0
bun test tests/repo-hygiene.test.ts -> exit 0, 12 pass / 0 fail
```

No full suite was run locally, per the standing constraint. `repo-hygiene` is the
focused file that actually covers a `devlog/` change (tracked-devlog and
no-gitlink assertions), so it is the right narrow check for a docs-only phase.

### What the audits changed

Recording this because the diff between the first draft and the landed roadmap is
the real output of wp0:

- **wp1 shrank.** The draft would have applied model-scoped doubt as an
  account-wide denial, hiding models the account owns. Now Change 1 (measured
  `0.144.0` floor) plus Change 2a (empty roster is not a confirmation) only.
- **wp3 inverted.** It began as "review and merge #3018". The audit found the PR
  leaves a shutdown-loss window, so wp3 is now "land a bounded drain, then merge",
  and the option to abandon an outstanding job was withdrawn once round 3 showed
  `dev` publishes those candidates synchronously today.
- **Two phases were born from blockers.** wp4 (diagnostic transport) split out of
  wp2; wp5 (tri-state authority) split out of wp1.
- **Three vacuous or wrong test plans were caught before implementation:** a
  `gpt-5.5` assertion on a model that is not account-gated, two wp3 cases that
  already pass at the PR head, and a wp4 state that cannot occur.

## wp1 — #3022 entitlement floor + empty roster

- Status: pending.
- Receipt: _pending_

## wp2 — #3023 roster TTL refresh

- Status: pending.
- Receipt: _pending_

## wp3 — #3011 spill publication drain

- Status: pending.
- Receipt: _pending_
