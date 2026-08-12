# Substrate audit round 5 — synthesis

Verdict: **FAIL**, but the sentence that matters is new:

> "The sibling SQLite coordinator is the right architecture."

Five rounds in, the reviewer has stopped arguing about the design and is now
arguing about three specific places where the roadmap has not caught up to it.

| Round | Closed | Open | New | Blockers |
|---|---|---|---|---|
| 1 | — | 13 | 13 | many |
| 2 | 1 | 11 | 5 | 8 |
| 3 | 5 | 11 | 4 | 8 |
| 4 | 9 | 8 | 5 | 8 |
| 5 | **14** | 10 | 9 | **3** |

Fourteen closed this round, and blockers fell from eight to three.

## The reviewer designed the lock order for us

Worth quoting, because it answers the question I have gotten wrong twice and it
is now the specification:

1. native/coordinator transaction `N` with `BEGIN IMMEDIATE`
2. config transaction `C`, **while holding** `N`
3. authoritative reread, native/provenance writes, and the transition-row update
   using the **already-open** `N` connection
4. release `C`, then **`COMMIT N`**
5. later, history lock `H`; at claim and terminal boundaries it performs only
   fail-fast conditional operations against `N`, releasing `H` and retrying if
   busy

Edges: `N → C` and a short `H → N`. No `C → N`, no `C → H`, no held `N → H`.
CLI and service processes taking the same order cannot deadlock.

They also validated the zero-row protocol against Worker death at every point,
and found the one hole I had not: **death after the SQLite commit but before
`postMessage`** leaves terminal state already durable. So the parent must
**reread the row before recording `worker-died`**, or it overwrites a real
success with a synthetic failure.

## The three blockers, all the same shape

Each is a place where a document still describes the world before the
coordinator existed.

**B1 — WP11 never received coordinator ownership.** `030` still writes the
transition through JSON and then executes `ROLLBACK` on its SQLite transaction
(`030:150-173`). That discards the very row the design depends on, and makes a
successful commit indistinguishable from an unrecorded partial write. WP11 must
own one **committed** coordinator transaction and pass it as an opaque capability
— opening a second connection inside the callback would contend with its own
`BEGIN IMMEDIATE`.

**B2 — WP9 has no path for the config object it promises.** `010` says gather
must receive the management callback's exact `OcxConfig` (`010:186-190`), but
`convergeCodex` takes only a `ConvergeRequest` and the management calls supply no
config (`010:328-343`). Neither commit specified the transport. It goes in the
internal catalog request, or convergence is bound to the management context —
not a resident global, and not a reread that contradicts the phase.

**B3 — adoption's native-clean proof is not serialized.** `040:399-412` validates
every surface and then writes provenance, with no lock across the gap. A CLI
convergence can modify an artifact in between, so the recorded baseline describes
a state that no longer exists. Revalidate under native coordination, then write
and initialize the row before releasing.

## What closed

Fourteen, including several I expected to argue about: the `/api/sync` adapter
(#4), the full admission snapshot with named readers (#8), the complete history
failure union (r3 #3), the baseline classes (N4), C17's narrowing (r4 #5), the
compile prelude (r4 #4), and three of the four WP13 defects — including D2, where
the reviewer confirms Scenario H "would fail without the substrate and pass with
it", which is this project's standing bar.

They also compiled the contract's ten blocks plus the WP10 and WP12 fragments
themselves: zero diagnostics.

## The finding that corrects my own gate

**WP13 D1 stays open, and the reason is sharp.** The disposable-host gate passes
on any developer account with no installed service. It protects *this* machine
only because a service happens to be installed here. Negative evidence — "no
service found" — is not proof of disposability.

That is exactly the class of reasoning this unit keeps catching in me: an absence
treated as a guarantee. A positive sentinel is required, plus exclusion from
ordinary test commands.

## Smaller, all accepted

- WP10 calls `updateCodexTransitionState`; the contract exports
  `updateCodexHistoryTransition` (#new 5)
- the SQLite `CHECK` accepts a NULL direction alongside a positive generation
  (#new 6)
- WP13 scenarios A/I/K and C16 still read transition state from the JSON record
  (#11, #new 7)
- `CodexArtifactId` and both `baseline` variants lack extension passthrough (#3)
- WP13 Scenario A still demands no writer outside `convergence.ts`, contradicting
  the per-domain root table (#2)
- stale wording and a drifted citation (#new 9)

## Position

Three blockers, all "make the document match the coordinator", plus a real
parent-reread rule and a real gate weakness. No structural replan. The next pass
fixes these and re-audits.
