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

## wp1 — CLOSED (shipped)

`#3022` is fixed on `dev`. PR #3035 squash-merged as `4bdc0f6fb`.

Two defects, one file (`src/codex/model-entitlements.ts`): the gated client-version
floor derived `0.142.2` from the bundled snapshot when upstream only returns the
gpt-5.6 rows at `0.144.0` and above, and an empty roster was recorded as a
confirmation because an empty `Set` is truthy. The floor is now composed as
`max(derived, measured, fallback)`, and a roster with no usable rows is unconfirmed
on the 15s failure TTL.

Eight regressions, each driven red against the unfixed source. Reverting both changes
produces exactly six failures in `tests/codex-model-entitlements.test.ts` and one in
`tests/claude-models-discovery.test.ts`; restoring returns 37/37. One existing
assertion was intentionally flipped (an all-filtered roster is no longer "confirmed"),
and one existing mock was corrected — it gated at minor `>= 142`, which is precisely
why the suite never caught the regression.

Verified on `ssh lidge` at the exact pushed head `1b6b36b96`: privacy scan passed,
typecheck clean, full suite **16510 pass / 0 fail / 16 skip**, `EXIT=0`. Repo CI green
across all four test shards, Windows, macOS, keyring, npm-global and the gates.

## wp2 — CLOSED as a planning cycle; implementation is wp6

Four audit rounds, four correctness holes, all in the same place: what a deduplicated
ensure is allowed to answer for. The flight key grew from a bare timestamp to
`(candidate set, client version, mutation epoch, identity vector, workset)`, one term
per round, each added because a reviewer produced a concrete cross-answering sequence.

Round 8's is the one worth remembering: every other term can be unchanged while an
entry expires mid-flight, so a second caller joins a flight that will never refresh
the account it came to refresh, and `ocx export` — the surface #3023 actually
reported — returns short rows having refreshed nothing.

wp2 does not claim an implementation, because there is none. It is registered as wp6.

## wp3 — repair in flight

The drain itself is right: correct ordering before the 2 MiB snapshot exclusion, a
genuine stable-fixed-point loop, `B=5000`/`R=4000` with the fallback receiving its
reserved slice, and the shared ACL deadline reaching both hardeners. The review found
one high defect: supersession reaches the state tracking but not the writer, so an
abandoned writer can still publish to the filesystem and orphan a temp. Sent back.
