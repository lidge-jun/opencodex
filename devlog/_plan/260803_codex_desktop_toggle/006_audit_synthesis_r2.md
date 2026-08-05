# Audit round 2 — synthesis, and the replan it forces

Verdict: **FAIL**. Five of eleven closed, six still open, and **six NEW findings**
including three High.

## The number that decides this round

| Round | Closed | Still open | New |
|---|---|---|---|
| 1 | — | — | 11 |
| 2 | 5 | 6 | 6 |

A converging audit closes more than it opens. This one did not. And the new
findings are not nitpicks — they are the same *class* as the old ones, found one
layer deeper:

- round 1 said "persistence is unsafe" → round 2 says the fix drops the
  `authModeMigratedAt` sentinel, so a client toggle silently pins the user's
  Claude auth mode (`src/claude/auth-mode-migration.ts:16-31`)
- round 1 said "in-flight writers can re-enable" → round 2 says teardown callers
  in `src/service.ts:2587-2592` and `management-api.ts:181-186` still bypass the
  flight entirely
- round 1 said "startup must converge" → round 2 says the convergence I added can
  **tear down another installed service's Codex/Grok state** from a different
  `OPENCODEX_HOME`, because the registry calls the removers directly without
  `assertNativeTeardownOwned`

That last one is the tell. My fix for a finding *created a worse defect than the
finding*. And #5 (GUI union ownership) is still open after I explicitly assigned
the shared contract to WP3 — because I put the server contract there and left the
GUI parser unowned.

## Root cause (LOOP-REPAIR-01 → root-cause mode)

Two failed repair rounds on the same failure means stop patching and diagnose.

The diagnosis: **I coupled ten clients into one schema change.** `clientIntegrations`
as a ten-key map forced every phase to touch every client's write path, so each
round of fixes widened the blast radius instead of narrowing it. Codex, Grok,
Desktop, Claude Code and six file clients each have different ownership rules,
different teardown callers, and different migration histories. One map made them
one problem.

The evidence that this is the cause rather than bad luck: **WP2 passed both
rounds untouched.** It is the only phase that changes one thing at one boundary.

## The replan

Return to P (LOOP-REPAIR-01 escalation) with a decoupled map. Not a smaller
objective — the same four deliverables, sliced so each is independently
auditable.

1. **WP2 modality fix ships first, alone.** Clean through two adversarial rounds.
   It fixes a live user-facing failure and depends on nothing here.
2. **WP4 API-keys row ships second, alone.** Never audited as blocking; pure GUI;
   no coupling to the schema.
3. **Desired state is re-scoped to ONE client: Codex.** A `codex` flag, its
   gates, its single-flight, its ownership preflight, its CLI semantics. Not a
   ten-key map. Grok's regression gets its own later phase reusing whatever
   shape survives audit.
4. **Claude Code's gates are left exactly as they are.** Round 1 #1 proved I had
   no business touching that ingress; the amended plan keeps them, and now the
   honest move is to not route them through a new helper at all in this unit.
5. **Desktop moves behind Codex** and is re-audited on its own once the
   one-client shape is proven. The goal explicitly permits an evidenced deferral,
   and round 2 #3 (no coherent rule when a foreign profile is selected) plus #6
   (marker cleanup failure ignored) say it is not ready.

## What carries forward regardless

Verified across both rounds and not in dispute: the native-restore thesis
(`001`), the official standard-mode contract (`002`, re-opened by the reviewer in
round 2), the Grok regression (`003`), and the modality defect (`004`). The
research holds. It was the *phase map* that was wrong, which is exactly what
PHASE-SPLIT-01 exists to catch and what I got wrong by slicing along a schema
instead of along ownership boundaries.

## Carried-forward findings for the re-scoped phases

Round 3 found my first version of this table incomplete — findings were missing,
two were assigned to one phase when three inherit them, and two pointed at a
"file-client phase" the roadmap does not contain. A ledger that quietly drops an
obligation is worse than no ledger, because the next author reads absence as
closure. Complete version, every finding from both rounds:

| Finding | Status | Inherits |
|---|---|---|
| r1 #1 Claude ingress gates | **scope-eliminated** — this unit no longer touches them | — |
| r1 #2 unsafe persistence | open | WP4 (Codex), then reused by WP6/WP7 |
| r1 #3 file clients have no writer | **deferred** — no file-client flag in this unit; tracked as `FOLLOWUP-FILECLIENT-01` | a future unit |
| r1 #4 false-green CLI | open | WP4 |
| r1 #5 GUI contract ownership | open | WP4 defines it; **WP5 and WP7 both extend it** |
| r1 #6 in-flight writers | open | WP4 for Codex, WP6 for Grok, WP7 for Desktop — each must prove its OWN callers |
| r1 #7 restart reconciliation | open | same three, per client |
| r1 #8 Desktop status from stale bookkeeping | open | WP7 |
| r1 #9 Desktop status can create files | closed in r2 | WP7 keeps the test |
| r1 #10 test adequacy | open | **every** phase — each lands the test that would catch its own absence |
| r1 #11 stale citations | fixed | `001`, `002`, and `010` in this cycle |
| r2 #1 auth-mode sentinel dropped | open | WP4 |
| r2 #2 reconciliation can tear down a foreign home | open — **blocking** | WP4, and every native remover after it |
| r2 #3 Desktop foreign-selected profile has no rule | open | WP7 — the reason Desktop is deferred |
| r2 #4 existing-disabled clients not migrated | **deferred** with r1 #3 | `FOLLOWUP-FILECLIENT-01` |
| r2 #5 mutating GET | open | WP4 — status GETs stay inspection-only |
| r2 #6 Desktop marker cleanup failure ignored | open | WP7 |

`FOLLOWUP-FILECLIENT-01` is a named placeholder, not a phase: the six file
clients get no desired-state flag in this unit, so r1 #3 and r2 #4 are recorded
as owed work rather than silently dropped. Inventing that phase under audit
pressure is what produced round 2's new findings.
