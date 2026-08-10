# WP4 audit round 2 — synthesis, and a scope decision

Verdict: **FAIL**. Three closed (#4, #6, #7), four still open, **five new High**.

## The count that matters

| Round | Closed | Still open | New |
|---|---|---|---|
| 1 | — | — | 7 (4 blocking) |
| 2 | 3 | 4 | 6 (5 blocking) |

Same signature as the earlier divergence: fixes opening more than they close.
But the diagnosis is different this time, and it is not the phase map.

## What round 2 actually discovered

My lock is not implementable over the code it has to wrap.

- **The refresh dependency has no seam.** `refreshCodexCatalog?: () => Promise<void>`
  (`src/server/management/context.ts:11`) gathers AND writes inside one opaque
  async call. My design says "gather outside the lock, commit inside it". You
  cannot do that to a callback that does both and returns nothing. Calling it
  outside leaves writes unprotected; calling it inside breaks my own
  no-await-under-lock rule (new #1).
- **The history write is not bounded.** Two SQLite busy waits at 5 s plus a
  synchronous `Bun.sleepSync(500)` (`history-provider.ts:31,537`), then
  row-dependent rollout writes. My "bounded synchronous commit" can hold the
  lock for ~10.5 s **on the server's event loop**, so a dashboard-initiated OFF
  stops serving every other client — the precise thing this feature exists to
  prevent (new #3).
- **I deleted a guard I did not recognize.** Startup suppresses journal repair
  when `currentExternalCodexModelProvider()` is set. I replaced that with
  service-home ownership and called it "unconditional". Those are different
  authorities, and the result can write our journal baseline over a config
  another provider owns (new #2).
- **Persisted ON can read as OFF.** `/api/sync` gates on the server's
  long-lived `config` object before reaching my fresh read, so a CLI enable in
  another process leaves the running server refusing (new #4).
- **`unchanged` is not `converged`.** I let a no-op config commit skip native
  convergence, which false-greens OFF-with-residue and ON-with-missing-artifacts
  (new #5).

Every one is accepted. None is a nitpick; #3 alone would ship a switch that
freezes the proxy.

## The decision this forces

Rounds 1 and 2 of WP4 are not the coupling failure `006` diagnosed — the
reviewer re-confirmed the re-scope holds. They are something narrower and more
honest: **Codex's write path was never designed to be interrupted**, and making
it safely interruptible is its own unit of work.

The evidence, plainly: to satisfy this design I would have to introduce a
gather/commit seam into the management refresh contract, move history mutation
off the server event loop or give it a fail-fast mode, define an async lock
acquisition protocol with deadlines and fairness, and specify a per-user lock
namespace with symlink hardening. That is a concurrency substrate. It is not
"add a boolean and check it".

I am not going to keep patching a design whose foundation the audit keeps
finding underneath it. Two rounds, eleven accepted findings, five of them
discovered only after my own fixes created them.

## What that means for the goal

The objective has four deliverables. Two shipped and are proven:

| | Status |
|---|---|
| gjc/Pi modality poisoning | **DONE** — proven against the client's own schema |
| API keys row | **DONE** — rendered, observed, isolated |
| Codex toggle | **BLOCKED on a prerequisite this unit uncovered** |
| Desktop toggle | deferred behind Codex, by design |

The Codex switch is not blocked by anything external, and it is not
unachievable. It is blocked by a real finding: the safe-interruption substrate
has to exist first, and its scope is a unit, not a work-phase inside this one.

Recording it as `NEEDS_HUMAN` rather than continuing is the honest call under
LOOP-CONTINUE-01. The rule forbids shrinking the objective to escape a loop; it
does not require pretending a newly-discovered prerequisite is small. The
owner should decide whether to fund the substrate now or ship the two proven
deliverables and revisit.

## Carried forward, in full

Every open and new finding, for whoever picks this up:

| Finding | Status | Belongs to |
|---|---|---|
| r1 #1 lock linearization | open — lock is right, wrapping is not implementable | substrate unit |
| r1 #2 ownership tri-state | open — external-provider guard regression (r2 #2) | substrate unit |
| r1 #3 `models_cache.json` | open — invalidation conflated with restoration (r2 #6) | substrate unit |
| r1 #4 caller semantics | **closed** | — |
| r1 #5 lock-error branch | open — `conflict` wrongly called non-retryable | substrate unit |
| r1 #6 legacy catalog backup | **closed** | — |
| r1 #7 docs-site sync | **closed** | — |
| r2 #1 refresh contract has no seam | open — **blocking**, needs a contract change | substrate unit |
| r2 #3 history is unbounded on the event loop | open — **blocking** | substrate unit |
| r2 #4 stale in-memory config admission | open — **blocking** | substrate unit |
| r2 #5 `unchanged` skips convergence | open — **blocking** | substrate unit |
| r2 #7 lock namespace hardening | open | substrate unit |

WP6 (Grok) and WP7 (Desktop) both depend on the same substrate, so neither is
startable ahead of it. That dependency is why the loop stops here rather than
chaining to the next work-phase.
