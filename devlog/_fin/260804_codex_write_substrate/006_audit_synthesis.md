# Substrate audit round 1 — synthesis

Verdict: **FAIL**, 7 High blocking, 5 Medium, 1 Low. Fresh reviewer, auditing the
whole unit as an implementer would apply it.

## What the reviewer proved rather than accepted

This round did unusually heavy independent verification, and three results
matter regardless of the findings:

- **Bun Workers do what `020` assumes.** The reviewer ran a probe: TypeScript
  ESM workers load, structured clone carries the proposed message shapes, and
  the repo already uses Workers in storage restore/policy paths. Every field
  crossing the boundary is plain data.
- **A crashed lock holder does NOT wedge the lock.** They ran the existing
  abrupt-holder regression on Bun 1.3.14: the OS releases the SQLite transaction
  on process death, so `030`'s no-stale-takeover decision is safe.
- **Refusing a missing `CODEX_HOME` does not break first run.** The native
  injection path already rejects a missing `config.toml`, so no legitimate caller
  depends on materializing a home.

So the three riskiest *technical* bets in the unit survived. What failed is
composition.

## The defect behind #1 through #4

I dispatched four phase docs in parallel and each one wrote a correct design for
its own boundary. Then they met.

| Finding | The collision |
|---|---|
| #1 | `030`'s locked callback forbids awaitable work; `020` puts history in a Worker with only an in-process flight. So the lock never serializes history at all — and the real history path writes the manifest and rollout files OUTSIDE its SQLite transaction (`history-provider.ts:606,626`), so two processes going opposite directions can still corrupt each other |
| #2 | `010` rewires 16 management callers to a direct gather/commit helper; `040` replaces startup, ensure and `/api/sync` but never touches those 16. A provider edit therefore still commits catalog bytes with no ownership, provenance, intent or lock check |
| #3 | `020` and `040` both declare themselves owner of `integrations/codex.json`, each with its own required `version: 1` shape. A record written by one is malformed to the other |
| #4 | `010`, `020` and `040` each define the `/api/sync` contract, and `040`'s version drops `Retry-After`, bypasses `020`'s seam, and returns neither `catalogRefresh` nor `history` |

This is the same failure the previous unit had — two docs redefining one union —
and I reproduced it at four times the scale. **The lesson I did not apply: when
phases share a contract, ONE phase must own it and the others consume it.** I
wrote that sentence into the previous unit's synthesis and then dispatched four
parallel authors with no shared-contract owner.

## The three findings that are real design errors, not composition

**#5 — "recheck under the lock" still does not linearize.** `mutatePersistedConfig`
says so itself (`config.ts:1855-1857`): a writer that ignores the coordinator can
change bytes after the final check, because the filesystem has no portable
conditional rename. My ordering releases the config lock before native
convergence, so A can recheck ON, B can persist OFF, and A still writes. Accept:
this needs a monotonic generation verified before AND after the native commit,
with a post-commit mismatch left unresolved and re-converged.

**#6 — my staleness guard is a state comparison, not a revision guard.** Hashing
current config and base-catalog bytes passes an A→B→A cycle, and a parent symlink
can retarget while the textual path is unchanged. `010`'s own criterion (C2) says
"revision", and I implemented "contents". Accept: a monotonic catalog generation
plus stable target identity, not path strings.

**#7 — the lock namespace is not per-user.** `homedir()` reads `HOME` /
`USERPROFILE` first, so a service and a CLI for the same user can land on
different lock databases and defeat exclusion entirely. My tests set both
consistently and would never have caught it. Accept: derive from OS-provided
effective-user identity.

## Medium and Low

All accepted. Two are worth naming:

- **#12 — the unit ships a switch after claiming it does not.** `040` adds
  `clientIntegrations.codex`, treats false as OFF, and makes convergence obey it.
  That is a config-file switch even without a GUI. `000_plan.md` says "It ships no
  switch", which is now false. Either say so plainly or move the boolean out.
- **#11 — the 13 criteria are not sufficient for the COMPOSED system.** Several
  are provable only inside their own phase and break at the seams; C3 tests an
  `/api/sync` seam that `040` removes. This is the "8000 green tests beside a
  broken real file" class the plan itself warns about, so it needs a final
  composed acceptance suite against real production entry points.

## Disposition

Thirteen findings, thirteen accepted, nothing rebutted. I verified #1's
out-of-transaction manifest write and #5's config caveat in the source myself
before accepting.

## The correction

Not another parallel round. The phase map gains a **contract phase** that lands
FIRST and owns every shared surface:

- the `integrations/codex.json` record: one owner, one schema, provenance as an
  extension-safe optional field
- the `/api/sync` response contract: one adapter carrying catalog disposition,
  history state and desired/observed projection
- the module name (`codex-write-lock.ts`, per #13)
- the convergence entry point that all 16 management callers and the three
  lifecycle paths funnel through

Then WP9-WP12 CONSUME it instead of each inventing their share. Sequential, one
audit each, which is the property that made the two shipped phases of the
previous unit clean.

`005_disable_leaves_a_broken_file.md` — the live incident found mid-audit — feeds
the same contract phase: the artifact inventory needs a baseline class for
containers a client requires to be non-empty.

## Carried forward

| Finding | Inherits |
|---|---|
| #1 history linearization | contract phase (protocol), WP10 (implementation) |
| #2 the 16 bypassing callers | contract phase (entry point), WP9 |
| #3 record ownership | contract phase — **it is the contract** |
| #4 `/api/sync` contract | contract phase |
| #5 config generation | contract phase (generation), WP12 |
| #6 catalog generation + target identity | contract phase (generation), WP9 |
| #7 per-user namespace | WP11 |
| #8 config snapshot reuse | contract phase (admission returns a snapshot) |
| #9 history retry dormancy | WP10 |
| #10 provenance recovery + ABA | WP12 |
| #11 composed acceptance suite | a final verification phase |
| #12 scope honesty | `000_plan.md`, now |
| #13 module name | contract phase |

Prior-unit findings r1 #1 and r2 #4 remain open and are re-homed above rather
than being counted as housed.
