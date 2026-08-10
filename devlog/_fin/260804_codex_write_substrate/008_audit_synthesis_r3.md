# Substrate audit round 3 — synthesis

Verdict: **FAIL**. Five closed (#9, #12, #13, N1, N4), eleven open, four new.

## The trend is real, and so is the remaining gap

| Round | Closed | Open | New |
|---|---|---|---|
| 1 | — | 13 | 13 |
| 2 | 1 | 11 | 5 |
| 3 | **5** | 11 | 4 |

Round 3 is the first round that closed more than it opened. The *ownership
transfer* worked: the reviewer re-walked their own thirty-entry checklist and
confirmed most entries are structurally transferred. `/api/sync` has one owner,
the module names are normalized, the caller no longer picks direction, the retry
dormancy is gone, and the scope creep is reversed.

What remains is narrower and mostly one thing.

## The one thing: I referenced types I never defined

`CodexArtifactId`, `CodexObservedState` and `CatalogDisposition` appear in the
contract's signatures and **are defined nowhere in the unit**. I verified this
myself — a grep for their definitions across all nine docs returns nothing.

That single omission cascades into four separate findings:

- **#3** the schema is not complete
- **#4** the adapter's exhaustive `never` check cannot be written
- **N2** WP8b cannot typecheck — the reviewer fed my bodyless
  `export async function convergeCodex(...)` to the actual TypeScript compiler
  and got **TS2391, "Function implementation is missing"**
- **checklist 8** the `AdmissionSnapshot` lacks fields WP12 says it compares

A contract that references undefined types is not a contract. I wrote "the
complete definition of every shared surface" at the top of a document that was
not complete.

## The design errors that survived

**#1 / N3 — the expected transition is still wrong on both sides.**

I wrote "reject when `nativeBefore` no longer matches", but after the native
commit the record holds `nativeAfter` — so the check compares against the value
that is *supposed* to have changed. Worse, the reviewer showed that even
corrected, checking once after acquiring the history lock only *moves* the race:
a newer transition can commit while the old Worker is still traversing files.

And the record has **no `txId` field at all**, so "same number, different txId"
is undetectable by construction.

Accept. Either a transition gate shared by native commits and the whole history
unit, or — the honest alternative — narrow the claim from *prevention* to
*detect-and-repair*, and guarantee the latest transition is durably scheduled
even when its Worker never spawned.

**#2 — the module graph cannot see what I asked it to see.**

I said writers move to `src/codex/internal/` with `convergence.ts` as sole
importer. But WP10's history worker must reach history writers directly, and
`inject.ts` / `journal.ts` are *mixed* read/write modules — a module-level graph
cannot tell a safe reader import from reaching a writer when both live in one
file. Accept: symbol-aware reachability, a published writer inventory, and
per-domain permitted roots (`convergence.ts` for native/catalog,
`history-worker.ts` for history).

**#7 — uid/SID is the right key on the wrong root.**

The key is settled. But `<os-runtime-dir>` calls an undefined resolver, and if a
service and a CLI derive different roots from `TMPDIR` / `XDG_RUNTIME_DIR` /
`LOCALAPPDATA`, adding the same uid underneath does not stop the split. The
environment problem I fixed at the leaf is still present at the root.

**N-new 2 — WP9's rewiring does not preserve behavior.**

The 16 management callbacks refresh catalog and cache only. Routing them through
a coordinator that also injects config, profile, journal and history means an
ordinary provider edit starts doing all of that — *before* WP10-WP12 land the
safety mechanics. That violates the invariant I wrote one round earlier: every
phase preserves behavior at its own commit. Accept: WP9's funnel is
catalog-only for management callers.

**N-new 1 — adoption can enshrine routed state as "native".**

If the ledger is lost while config still carries opencodex routing, adopting
current bytes as the baseline makes OFF *preserve* the routing forever. Accept:
adoption requires a verified native-clean state, or is split into salvage
(remove proven residue) then adopt.

## The honesty corrections

**#6 / #10 — `000_plan.md` still overclaims.** C17 is narrowed in the contract's
prose to cooperating transitions, and C10 is narrowed in WP12 to current-byte
drift, but the plan still promises unrestricted ABA detection and historical
edit detection. A criterion narrowed in one document and left broad in the
top-level plan is not narrowed.

**N-new 4 — "no window" is false.** I wrote that the file writes and the counter
bump have "no window" between them, then described a crash in that window three
lines later. Process exclusion does not make separate filesystem replacements
atomic. The claim becomes "no cooperating interleaving while the process is
alive", with per-artifact crash recovery stated.

## Disposition

Fifteen open items, all accepted. I verified the missing type definitions and
the TS2391 form myself.

## Next

No structural replan this round — the structure is now right and the reviewer
says so. The work is finishing what the contract started:

1. Define the three missing types, add `currentTxId` to the record, and complete
   `AdmissionSnapshot` with the fields WP12 compares.
2. Make `convergeCodex` a type alias in WP8b, not a bodyless declaration.
3. Fix the transition check side, and choose prevention-with-a-gate or
   detect-and-repair explicitly.
4. Specify the runtime-root algorithm per platform.
5. Scope WP9's management funnel to catalog-only.
6. Narrow C10 and C17 in `000_plan.md` to match the documents.
7. Write `050_composed_acceptance.md` (already dispatched in parallel).

Then re-audit with the same reviewer.
