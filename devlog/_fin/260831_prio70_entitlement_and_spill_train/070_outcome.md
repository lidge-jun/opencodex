# 070 — outcome and receipts

Filled in as each work-phase closes. Every receipt records the command, the host it
ran on, the exit code, and pass/fail counts. Local full suites are forbidden for
this train, so suite receipts name `lidge`.

## wp0 — roadmap (docs-only)

- Status: closing.
- Deliverable at the time wp0 closed: 12 docs — `000` plan, `001`-`003` research,
  `004`-`006` audit syntheses, `010`/`020`/`030`/`040`/`050` decade docs, `070`
  receipts. The unit now holds **14**: audit rounds 4-8 added `007`-`009`, and wp2's
  implementation split out as `060`.
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

## v2.37.0 released — #3022 verified live

The 5.6 fix is published and proven on the installed runtime, not just in CI.

- npm `@bitkyc08/opencodex@2.37.0` on `latest`; `gitHead` = `54e2274cff231631c0ea2ff12574ff03829d5fe6`
- tag `v2.37.0` and the GitHub release both point at that same commit
- `main` = `54e2274cf` (promotion PR #3037), `dev` = `4180067b4` and an ancestor of it

Both required gates passed on the exact release SHA as push events: Cross-platform CI
and Service lifecycle. `enforce-target` fails on any promotion by construction —
`ALLOWED_BASES` is `["dev"]` — which is why #3002 (v2.36.0) merged in the same state.

Release-path proof, in order:

1. The published tarball carries both changes:
   `MEASURED_GATED_CLIENT_VERSION_MINIMUM = "0.144.0"` at `:88` and
   `const usable = models !== null && models.size > 0` at `:472`.
2. The global install had to be forced. `bun add -g` reused a cached 2.37.0 from
   Aug 30 that predated the fix — same version string, old bytes. Worth remembering:
   a version match is not a content match, and `grep` on the installed file is the
   check that actually settles it.
3. The running proxy was serving the primary checkout, which sat 4 commits behind
   `dev` while reporting `version: 2.37.0`. So `/healthz` agreed with the release
   and the code did not. Fast-forwarded the checkout and restarted onto the global
   install (PID 57341, `~/.bun/install/global/.../@bitkyc08/opencodex`).
4. On that runtime: `ocx models live --provider openai` lists `gpt-5.6-sol`,
   `-terra` and `-luna` as native/enabled; `/v1/models` returns all three;
   `/api/models` and `ocx export --client opencode --json` carry them too.

That last point matters beyond #3022: the three surfaces #3023 names were checked on
a warm roster and all carry the gated rows. #3023 is about what happens once
`MODEL_ROSTER_TTL_MS` expires, so this is not a NOOP for it — but it does confirm
the warm path is intact and the wp6 work is scoped to expiry, not to the rows
themselves.

## wp3 — LANDED

#3011 fixed by carrying Ingwannu's `aec717722` and closing the shutdown boundary it
opened. His commit is the base of the branch, unmodified and credited. PR #3044 is
merged into `dev` as `e5d588669`.

Five review rounds, each returning FAIL until the last, and every finding was a real
defect rather than a style note. Worth recording as a sequence, because each fix
created the next problem:

1. Supersession reached the state tracking but not the writer, so an abandoned writer
   could still publish to the filesystem and orphan a temp. The first implementation's
   own test asserted **two** publications as expected behaviour.
2. Making cleanup failure reject the drain discarded **every other unsnapshotted
   response** — the rejection preempted `persistNow()` while shutdown still exited 0.
   My instruction to "reject the drain" was wrong as stated; the correct shape is that
   cleanup failure is reported but never prevents durable persistence.
3. Budget exhaustion caused an **infinite synchronous requeue loop**: pruning
   re-queued the over-cap resident and the drain never terminated. Graceful shutdown
   would have hung forever.
4. The regression guarding that loop could **wedge CI** rather than fail, because an
   in-test timeout cannot interrupt a blocked JS thread. Proven by the red run needing
   an external `timeout 3s` and exiting 124.

Final state: drain to a stable fixed point before snapshot serialization, budget split
`B=5000`/`R=4000` with the fallback receiving its reserved slice and passing it down to
both hardeners, supersession reaching the writer, cleanup attempted for every job
without short-circuiting persistence, terminalization bounded at 1001 passes with a
tested `ELOOP` guard, and the hang scenario isolated in a child process with a
watchdog that SIGKILLs and reports.

**The fail-closed consequence is deliberate and must stay documented.** When the
fallback budget is exhausted, the payload is destroyed and a `spill-failed` tombstone
persists. Shutdown exits nonzero, replay returns `previous_response_not_found` with
internal reason `spill_failed`, and the client resends the full conversation. If the
1001-pass structural guard ever fires, it fail-closes **all** remaining resident
continuation state, not only the originally pending spills.

Verified on `ssh lidge` at `f0a831efb` (rebased onto `dev` = `a8c3a9633`, 2.38.0):
privacy scan passed, typecheck clean, full suite **16524 pass / 0 fail / 16 skip**,
`EXIT=0`.

The earlier run at `9ef709460` had exactly one failure, `release version line`, which
reproduced on pristine `origin/dev` and was therefore not ours. `dev` was carrying the
just-published `2.37.0`. Fixed properly via `scripts/bump-dev-version.ts` and PR #3045
rather than by editing the version by hand.

Residual risk: a real Windows host is still needed for NTFS unlink semantics and
`icacls` timeout behaviour while a path is held.

## wp6 / wp5 / wp4 — the entitlement stack (landed 260831)

Three phases landed as a dependency-ordered stack on top of the spill work.

**wp6 (#3054, `0844dc9a9`) closed #3023.** A credential mutation epoch binds an
entitlement snapshot to the credential state that produced it; a read is a hit
only when both epoch and expiry still match. Steady state stays free: 0 extra
credential snapshots, 0 token refreshes, 0 network calls on the ~24/min polling
path.

The review round that mattered was the second one. The first submission's two
race regressions returned *usable* credentials, so they never reached the
negative-memo publication fence at all — **deleting the epoch and identity fences
left both tests green.** A third test could not distinguish absence-observation
time from settlement time. The implementation was correct; the tests guarding its
riskiest lines were worthless. Three replacements were driven red by removing
each fence in turn, and the reviewer reproduced every red independently rather
than trusting the report.

**wp5 (#3057) removes the #3022 class, not its instance.** wp1 fixed the current
failure by asking under a measured `0.144.0`. wp5 makes absence evidence only
when the question was capable of producing an answer: below-minimum omission is
`unknown` on the 15s failure TTL, at-or-above omission is `denied`, a present row
is `granted` regardless of version, and `gpt-daybreak-blue-latest` — which has no
row in `upstream-models.json` — keeps omission-as-denial rather than being handed
a guessed minimum. Projections still return only `granted`; that is what keeps
the gate fail-closed. One widening bug surfaced during implementation (an
unconfirmed present row briefly read as `granted`) and the guard test now pins it.

**wp4 (#3058) answers the part of #3023 that was never about rows.** The reporter
saw `discovery: {"status":"ok"}` beside missing models and read it as the proxy
lying. It was answering a different question, and nothing reported entitlement
freshness at all. Provenance had to come first: the parsed-empty path and the
catch path produced byte-identical cache entries, so reporting them as two states
would have been the same fabrication in a new field.

### Two CI defects found along the way

Neither was ours, and both were real.

`shutdown cleanup failure still persists unrelated response state` used a real
80ms wall-clock fallback reserve. Drain expiry is forced by an `icacls` gate and
is deterministic; the reserve was not. Under load it expired first, terminalizing
the unrelated response into a `spill-failed` tombstone. Measured on Linux at
`origin/dev`: eight parallel runs of that single test spanned **2.08s to 109.38s**,
and a six-way run reproduced the failure 1-in-6. Fixed in #3055 by sizing the
reserve so it can never be the thing that runs out; 10/10 parallel runs pass
afterwards, the longest at 45.51s.

`Unix install rejects delayed detached redispatch` failed once on macOS CI and
passed on rerun and on three local macOS runs. It pairs a 1500ms observation
window with a fixed `time.sleep(0.5)` in a forked child, which is thin on a slow
runner. Recorded rather than fixed: it has not reproduced.
