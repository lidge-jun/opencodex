# 030 — composed acceptance: reduced workstation scope over 050

`devlog/_fin/260804_codex_write_substrate/050_composed_acceptance.md` remains the
source for the harness rules (real child processes, no imported handlers, seeded
temp roots, lock-path preflight/teardown allowlist, no-sleep synchronization) and
the scenario intents. This document fixes its stale RED claims and cuts the scope
to what this session's safety boundary allows. Where they disagree, this wins.

## What changed under the doc (from the WP-A/WP-B audits)

050's "RED today" claims predate the substrate landing and are now largely GREEN:
`withCodexWriteLock` has production callers (`inject.ts:871-956` and the restore
path), the typed acquisition/refusal taxonomy exists (`codex-write-lock.ts:67-125`),
a real two-process contention test exists (`tests/codex-inject-write-lock.test.ts`),
`convergeCodexCatalog` owns the catalog commit, and — new on THIS branch — desired-
state revalidation sits inside all three artifact serializers plus the cache
reacquisition permit, and every sync caller discriminates skips. What remains
unproven is COMPOSITION: that the real entry points, invoked as production
processes, reach those mechanisms rather than writing around them.

## Scope cut (binding, from 000_plan.md r3)

- **IN:** one new `tests/codex-composed-acceptance.test.ts` in the ordinary suite,
  workstation-safe rows only, real spawned `src/cli/index.ts` children and a real
  HTTP server on a temp `OPENCODEX_HOME` per 050's harness rules.
- **OUT:** the disposable-host service class (P09/P10/P18/P34-P36), the
  `scripts/disposable-host/` job, `/healthz`-under-SQLite-contention (scenario C's
  timing bound needs a controlled host), and the full 36-row census. Issue #1048
  STAYS OPEN; the PR references it without a closing keyword and names the rows
  this suite covers versus defers.

## The reduced scenario set

Composed rows chosen to cross module boundaries this branch touched, one case each:

Deferred workstation-safe IDs (explicit, for #1048 traceability): P01, P03,
P11-P17, P20-P33 — deferred, not covered here; covered IDs are named per
scenario below. The disposable-host class (P09/P10/P18/P34-P36) is excluded by
the safety boundary as before.

1. **A-reduced — entry-to-funnel for the toggle-relevant rows.** Real child
   invocations of: P02 (`ocx start`, then kill), P04 (`ocx ensure`),
   P05 (`ocx sync`), P07 (`ocx restore`), P08 (`ocx restore back`), P06
   (`ocx sync-cache`); plus HTTP P19 (`POST /api/sync`) and the toggle routes
   (`PUT /api/native-integrations/{codex,grok,claude-desktop}`) against the real
   server. Each asserts the discriminated result contract (applied vs skipped vs
   refused) and, where desired OFF is seeded, that NO codex artifact
   (config/profile/catalog/cache/history) is created or changed — byte-level
   before/after manifest of the temp `CODEX_HOME`.
2. **B-reduced — lost transition at a real entry.** Desired ON; child A enters
   P19-equivalent sync against a held local provider fixture; a second production
   config mutation persists OFF; release; assert A commits nothing and reports the
   discriminated skip. (The WP-B unit test proved this at the injector seam; this
   case proves it through the HTTP entry.)
3. **D-reduced — foreign home creates nothing.** Foreign-ownership evidence seeded
   per 050; invoke P02, P04, P19, P07 as real children; byte manifest asserts zero
   artifacts (lock DB, catalog, cache, config, history) created anywhere under the
   temp root or the case's OS-runtime lock path.
4. **E — same effective user, different env homes, one lock.** As written in 050
   (workstation-safe): child A holds the lock via a held injection; child B with
   different HOME/USERPROFILE but same CODEX_HOME gets typed `busy` naming the same
   lock id; no lock artifact under either fake home.
5. **Grok E2E (from 000_plan.md).** Disable Grok via the real route, then run the
   real `ocx start` startup path in a child with the persisted config; assert
   the Grok fence stays absent and the startup log/result reports the
   desired-state skip.
6. **Restore truth composed.** With history DB held by a `BEGIN IMMEDIATE` holder
   child, run `ocx restore` as a real child. The CLI prints only `{success,
   message}` (`src/cli/index.ts:817-826`), so the envelope is not directly
   observable from a spawned child; the case asserts the observable contract:
   non-zero exit, a message that names the history failure class (busy) rather
   than claiming full success, config/catalog bytes restored on disk while
   history rows are not, and a rerun after release converging. If the message
   contract proves too weak to discriminate, the case adds a machine-readable
   CLI output (e.g. `--json` on restore) as part of this phase rather than
   weakening the assertion.

## Harness rules kept verbatim from 050

Temp root via `mkdtempSync`; explicit fake `HOME`/`USERPROFILE`/`CODEX_HOME`/
`OPENCODEX_HOME`; children spawned as `Bun.spawn([process.execPath,
resolve(repoRoot, "src/cli/index.ts"), ...])`; servers on port 0 with `/healthz`
PID verification; local provider fixtures only. **Port safety is config-seeded,
never flag-passed:** every child fixture that starts a server writes
`"port": 0` into its temp `config.json` and invokes `ocx start` WITHOUT
`--port` — the CLI rejects `--port 0` as an invalid flag value
(`src/cli/index.ts:71-85`), while an unseeded temp config would default to
10100 and collide with the live proxy. The harness discovers the actual bound
port from the isolated runtime-port record and verifies `/healthz` reports the
child's own PID before any request. Sentinel-based synchronization
(no sleep-as-readiness); watchdogs per child; lock-path preflight requires the
case's hash-derived DB absent, teardown removes only the four-name allowlist
after identity recheck; a teardown failure fails the case. The suite must pass
inside `bun scripts/test.ts` on this workstation without touching the real homes
or the live proxy.

## Proof rule (050:37-54 applies per case)

Every scenario names its RED condition (the mechanism whose removal must fail
it — e.g. delete a revalidation re-read, point a caller past the funnel, skip
the intent persist), and EACH of the six gets its own executed broken-change
demonstration before D closes: mutate, show that scenario red, restore, show
green, `git diff --stat` clean. One aggregate demo is not sufficient; a
scenario without a demonstrated RED is not accepted as proving anything.
