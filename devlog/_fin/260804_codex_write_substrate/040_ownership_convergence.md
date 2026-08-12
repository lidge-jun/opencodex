# WP12 — ownership authority and convergence

Research: `004_ownership_and_convergence.md`. Shared contract:
`005_contract.md`.

The failure to prevent is data loss, not an untidy status result. Today a dead-PID
version-1 journal without injected hashes can replay its baseline
(`src/codex/journal.ts:109-162`), corrupt service-state mirrors collapse toward the
same absence result used for no service (`src/service.ts:165-175`), and native
teardown fails open for errors outside its one mismatch class
(`src/integrations/native/ownership-preflight.ts:21-35`). A matching service-home
check also does not authorize overwriting a `config.toml` whose effective
`model_provider` is now external.

WP9 and WP10 provide the catalog split, the history protocol, the CODEX_HOME-keyed
coordinator row, and the integration-record owner.

**The native lock is NOT among them.** Round 7 merged WP11 into this phase: the N
mechanism has exactly one consumer, and the two things needed to exercise its API —
a runtime `AdmissionSnapshot` producer and the `inject.ts` synchronous-native /
awaited-history split — both live here. A standalone WP11 could only have proven that
a fabricated snapshot drives the primitive, never that its API fits its one real
caller. The lock's design is `030_lock_protocol.md`, which is now this phase's lock
section; the sentence that used to stand here claimed a working funnel WP11 had not
in fact delivered.

WP12 therefore delivers the lock **with its first production caller**, plus the
mechanisms behind the funnel: tri-state service authority, file-backed intent,
journal/provenance admission, restoration, and observed-state inspection. It does
**not** add another record module, another convergence module, another route mapping,
or another public result union.

The prior plan named `write-lock.ts`, created `ownership-convergence.ts`, redefined
`integrations/codex.json`, and exported `convergeCodexToPersistedIntent`. Those are
deleted. Contract names are exact: `codex-write-lock.ts`, `integration-record.ts`,
and `convergence.ts` (`005_contract.md` §8).

WP12 is independently landable: it modifies the existing working funnel and
contract implementations in one commit, rewires every remaining lifecycle caller
in that commit, and typechecks/preserves behavior without a future phase. WP13 may
re-prove composition; it is not required to make WP12 correct.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`bd1065a85c4981a1662e3676243d7de3b4ed9c81`.

## IN / OUT

IN:

| Path | Change | Why |
|---|---|---|
| `src/types.ts` | MODIFY | Add `clientIntegrations.codex?: boolean`; absent means desired ON. |
| `src/config.ts` | MODIFY | Parse the extension-safe object; implement `readConfigGeneration`/`bumpConfigGeneration`; own authoritative config inputs to `AdmissionSnapshot`. |
| `src/service.ts` | MODIFY | Preserve all service registration/mirror evidence instead of skipping corrupt/unreadable rows. |
| `src/integrations/native/ownership-preflight.ts` | MODIFY | Tri-state read-only service-home authority; only owned permits native mutation. |
| `src/codex/convergence.ts` | MODIFY | Complete admission, provenance, restore, observation, and lifecycle routing behind the contract entry point. |
| `src/codex/convergence-types.ts` | IMPORT ONLY | Consume `AdmissionSnapshot`, `CodexObservedState`, `ConvergeOutcome`, `CodexProvenanceLedger`, and section types; no WP12 union. |
| `src/codex/integration-record.ts` | USE/MODIFY THROUGH OWNER API | Read/update provenance and extension keys through the contract owner; no transition pair, history state/schedule, path/schema/parser, or parallel merge here. |
| `src/codex/transition-state.ts` | CONSUME | Use `readCodexTransitionState`, `beginCodexTransition`, and `updateCodexHistoryTransition` for the canonical-CODEX_HOME pair and history state/schedule. |
| `src/codex/codex-write-lock.ts` | **NEW / IMPLEMENT** | This phase CREATES the module; `030_lock_protocol.md` is its design specification. It was WP11's until round 7 merged the phases. |
| `src/codex/journal.ts` | MODIFY | Read-only typed inspection; authorized recovery only inside convergence. |
| `src/codex/inject.ts` | MODIFY | Receipt-gated internal apply/restore mechanics; remove filename-based deletion authority. |
| `src/codex/sync.ts` | MODIFY | Remove the remaining alternate native orchestration; delegate to `convergeCodex`. |
| `src/codex/catalog/sync.ts` | MODIFY | Report post-images and perform provenance-authorized restoration behind convergence. |
| `src/server/index.ts` | MODIFY | Remove unconditional cache invalidation at current line 403. |
| `src/cli/index.ts`, `src/service.ts` | MODIFY | Route startup, ensure, explicit restore/eject, stop, uninstall, and recovery through `convergeCodex`. |
| `src/server/management/config-routes.ts` | MODIFY | Call `convergeCodex` and the contract response adapter only. |
| `tests/codex-ownership-authority.test.ts`, `tests/codex-artifact-provenance.test.ts`, `tests/codex-observed-state.test.ts`, `tests/codex-convergence-order.test.ts`, `tests/codex-models-cache-restore.test.ts` | NEW | Authority, provenance, observation, ordering, and current-byte drift. |
| `tests/codex-journal.test.ts`, `tests/codex-sync-api.test.ts`, `tests/service.test.ts`, `tests/uninstall.test.ts`, `tests/codex-convergence-contract.test.ts` | MODIFY | Recovery, fresh intent, fail-closed service behavior, and production funnel. |
| `docs-site/src/content/docs/reference/cli/lifecycle.md`, `docs-site/src/content/docs/reference/configuration.md` | MODIFY | Refusal/recovery and persisted intent; link route behavior to the contract adapter. |

OUT:

- `src/codex/ownership-convergence.ts` — deleted from the plan. There is one entry
  module, `src/codex/convergence.ts`.
- Ownership of `src/codex/integration-record.ts`, its path/schema/validators, or
  `/api/sync` mapping — `005_contract.md` §§1, 5.
- A module named `src/codex/write-lock.ts`; the consumer import is
  `src/codex/codex-write-lock.ts`.
- New request/result/observed-state/provenance section unions. All shared shapes
  come from `convergence-types.ts`.
- GUI, Grok, Claude Code/Desktop, six file integrations, provider transport,
  release/publish/deploy actions, and the live proxy on 10100.
- The Pi required-nonempty file-client incident. The third baseline class is
  removed and remains `FOLLOWUP-FILECLIENT-01` (`005_contract.md` §9).

## Tri-state service-home authority

The service preflight owns evidence collection, not the shared convergence result.
Its implementation may use a private/local discriminated union so it can explain
why an `AdmissionSnapshot.ownership` is `owned | foreign | unknown`; it must not
export a second convergence outcome.

Truth table:

| Registration evidence | Mirror evidence | Admission ownership |
|---|---|---|
| absent | all absent | `owned` |
| installed | all required mirrors valid and canonical pairs match current | `owned` |
| any | decisive valid mirror names another pair | `foreign` |
| installed | all absent | `unknown` |
| any | corrupt, unreadable, conflicting mirrors | `unknown` |
| unknown | no decisive valid foreign claim | `unknown` |
| any | any required path cannot be canonicalized | `unknown` |

Corrupt/unreadable/conflicting evidence wins over a convenient absent sibling. A
false refusal leaves inspectable residue; a false success can destroy newer user
state. Only `owned` reaches a native write.

`src/service.ts:165-175` becomes an all-mirror read that distinguishes absent,
valid, corrupt, and unreadable. Registration probes remain read-only and return
unknown when the platform cannot establish presence. Existing diagnostics may keep
a compatibility “first valid state” view; mutation admission may not use it.

```diff
-export function assertNativeTeardownOwned(): { ok: boolean; message?: string } {
-  try { assertServiceEnvironmentMatchesInstall(); return { ok: true }; }
-  catch (error) {
-    if (isServiceOwnershipError(error)) return { ok: false, message: error.message };
-    return { ok: true };
-  }
-}
+export function inspectNativeCodexOwnership(): NativeCodexOwnershipEvidence {
+  return inspectAllServiceRegistrationAndMirrors();
+}
```

`NativeCodexOwnershipEvidence` is phase-internal evidence projected to
`AdmissionSnapshot.ownership`; it is not a public shared result family.

## One admission order — exact `AdmissionSnapshot`

Every startup, ensure branch, management mutation, explicit sync/restore/eject,
stop, uninstall, retry, and observe uses this sequence. No caller selects a subset:

1. Resolve existing canonical `CODEX_HOME`, `OPENCODEX_HOME`, config/profile,
   catalog/cache, journal, history, rollouts, and integration-record targets without
   creating anything.
2. Read all service registration/mirror evidence. Foreign/unknown refuses.
3. Read effective project `model_provider`. External refuses separately.
4. Inspect journal/liveness without cleanup. Invalid/unknown-version, live writer,
   or unknown liveness refuses.
5. Read/validate the contract integration record without creating it. Missing is
   legal only when no residue needs provenance proof; corrupt/lost/conflicting
   provenance refuses.
6. Authoritatively read persisted config, config generation, intent, and ownership;
   return the contract's complete `AdmissionSnapshot`. The five-field object printed
   here before round 4 was wrong: it silently dropped the external-provider veto,
   target identity, journal/provenance identity, and the authority ID, so WP11 could
   not compare the authority it claimed to admit.

```ts
import type {
  AdmissionSnapshot,
  ConvergeCodex,
  ConvergeOutcome,
  ConvergeRequest,
} from "./convergence-types";

declare const configRead: Pick<
  AdmissionSnapshot,
  "config" | "configDigest" | "intent"
> & { readonly generation: { readonly value: AdmissionSnapshot["generation"] } };
declare const serviceRead: Pick<AdmissionSnapshot, "ownership">;
declare const routingRead: Pick<AdmissionSnapshot, "externalProvider">;
declare const targetRead: AdmissionSnapshot["canonicalTargets"];
declare const journalRead: { readonly identity: AdmissionSnapshot["journalIdentity"] };
declare const provenanceRead: { readonly identity: AdmissionSnapshot["provenanceIdentity"] };
declare const authorityRead: { readonly id: AdmissionSnapshot["authoritySnapshotId"] };

const admission: AdmissionSnapshot = {
  config: configRead.config,
  configDigest: configRead.configDigest,
  intent: configRead.intent,
  generation: configRead.generation.value,
  ownership: serviceRead.ownership,
  externalProvider: routingRead.externalProvider,
  canonicalTargets: {
    codexHome: targetRead.codexHome,
    opencodexHome: targetRead.opencodexHome,
    config: targetRead.config,
    profile: targetRead.profile,
    catalog: targetRead.catalog,
    cache: targetRead.cache,
    journal: targetRead.journal,
    integrationRecord: targetRead.integrationRecord,
    catalogBackups: targetRead.catalogBackups,
    historyDb: targetRead.historyDb,
    historyManifest: targetRead.historyManifest,
    historyRollouts: targetRead.historyRollouts,
  },
  journalIdentity: journalRead.identity,
  provenanceIdentity: provenanceRead.identity,
  authoritySnapshotId: authorityRead.id,
};
```

This object is not a WP12 approximation of the type. `AdmissionSnapshot` is imported
from `convergence-types.ts`, and the contract compilation fixture rejects either a
missing field or a locally invented replacement.

Concrete read/API ownership is fixed here so an implementer cannot fill the object
from a resident server cache:

| Field | Reader/API owner |
|---|---|
| `config`, `configDigest`, `intent`, `generation` | `src/config.ts` `readConfigDiagnostics()` plus `readConfigGeneration()`; digest is over the exact persisted bytes represented by that diagnostic result. |
| `ownership` | `src/integrations/native/ownership-preflight.ts` `inspectNativeCodexOwnership()`, projected only after `src/service.ts` has inspected every registration/mirror. |
| `externalProvider` | `src/codex/inject.ts` `externalCodexModelProvider()` over the exact persisted config bytes above. |
| `canonicalTargets` | `src/codex/convergence.ts` `resolveCanonicalCodexTargets()`; it composes the canonical path owners once, without creating a target. |
| `journalIdentity` | `src/codex/journal.ts` `inspectJournal()`; identity hashes the preserved envelope plus liveness verdict, not merely its path. |
| `provenanceIdentity` | `src/codex/integration-record.ts` `readIntegrationRecord()`; identity covers the validated provenance section and its unknown-key-preserving envelope. |
| `authoritySnapshotId` | `src/codex/convergence.ts` `hashAdmissionAuthority()` over the canonical encoding of every preceding authority field. |

The native `{nativeGeneration,currentTxId}` pair is deliberately not smuggled into
`provenanceIdentity`. WP12 reads it separately through
`src/codex/transition-state.ts` `readCodexTransitionState()`. That owner opens the
final path from `resolveCodexCoordinatorDatabasePath(identity,
canonicalCodexHome)`, so the pair belongs to the CODEX_HOME-keyed coordinator row,
not to `integrations/codex.json`.

7. If intent is ON, WP9 gather receives `admission.config` — **that exact object**.
   OFF does not gather.
8. Call WP11 with `admitted: admission`. WP11 opens native/coordinator transaction
   `N` with `BEGIN IMMEDIATE`, then acquires config transaction `C` **while holding
   N**. With both held, authoritatively re-read steps 1-6 into a second
   `AdmissionSnapshot` and compare digest, generation, intent, ownership, external
   provider, canonical targets, journal identity, provenance identity, and the
   recomputed authority snapshot ID.
9. Still inside `N -> C`, reclassify every artifact whose classification can
   authorize a write, recover an authorized dead journal, establish baselines,
   commit apply/remove, persist provenance, and conditionally install the expected
   native generation/`txId` plus pending history schedule. Every transition-row
   read/write uses the **already-open N connection**; opening a second coordinator
   connection inside this section would contend with its own `BEGIN IMMEDIATE`.
   Release `C`, then `COMMIT N`, and only afterward inspect/log/shape HTTP output.
10. Run WP10 history afterward under its sibling lock with the same
    `CommitExpectation` and authority snapshot identity; stale jobs are rejected.

Testable invariant:

> Before steps 1-6 return an authorizing `AdmissionSnapshot`, there is no new lock
> namespace/database/sidecar, integration record, journal, catalog backup, catalog,
> cache, config, profile, history manifest/row, or rollout line.

### Prevention and detection are different claims

For cooperating writers, stale commit is **prevented**: the config coordinator is
held through authoritative re-read and synchronous native commit. This is available
because `withConfigMutationLockSync` is synchronous (`src/config.ts:1767-1818`) and
`mutatePersistedConfig` already reruns against fresh snapshots
(`src/config.ts:1853-1913`).

For non-cooperating writers, portable conditional rename is unavailable
(`src/config.ts:1853-1859`). Bounded post-commit generation/target/current-byte
checks **detect** interference and return `deferred`; they do not retroactively
claim prevention. Regather/retry ends at `deadlineMs`, after which unresolved work
is named. This distinction is the correction required by audit #5 and
`005_contract.md` §3.

### Every classify-then-write path uses the same exclusion

The old plan protected the final config comparison but left other validation
results usable after their exclusion had ended. That was wrong: a classification
is write authority only for the bytes and coordinator state observed while the
writer still excludes cooperating mutation.

The invariant applies to every WP12 sequence, not only adoption:

1. Open native/coordinator transaction `N` with `BEGIN IMMEDIATE`.
2. Acquire config transaction `C` while holding `N` whenever config bytes,
   generation, routing, canonical targets, or config-derived authority participate.
3. On the already-open `N` connection, authoritatively reread the transition row;
   then reread/reclassify service authority, external routing, journal liveness,
   integration-record/provenance identity, artifact baselines, current post-images,
   and structural-removal evidence immediately before the writes they authorize.
4. Under that same `N -> C` exclusion, perform the provenance update, journal
   recovery, baseline capture, apply/restore/unlink, and transition-row operation.
   Release `C`, then `COMMIT N`. Failure or disagreement rolls back `N` and writes
   nothing; logging, retries, history dispatch, and response shaping happen later.

Thus pre-gather admission and any operator-facing pre-lock classification are only
candidate observations. They may refuse early, but they never authorize a write.
Baseline capture -> provenance write -> artifact write, current-post-image
classification -> restore/unlink, dead-journal classification -> recovery, and
authority/provenance classification -> any JSON/native write all repeat their final
classification inside the transaction above. This is the common exclusion required
for every classify-then-write sequence in this phase.

## External `model_provider` is a separate veto — C9

Service-home ownership answers who claims this OpenCodex installation. It does not
answer who owns effective `config.toml` routing. A matching service can coexist
with a newly selected external provider; that provider blocks apply, restore,
journal recovery/deletion, catalog/cache/history/rollout mutation, provenance
adoption, and lock creation.

Remove journal deletion from the external branch:

```diff
 const activeProvider = externalCodexModelProvider(rawContent);
 if (activeProvider) {
-  removeJournal();
   return externalAuthorityRefusal(activeProvider);
 }
```

External is projected through the contract's `refused` authority/result. It is not
“already converged.”

## Contract-owned provenance record

Delete the former `CodexIntegrationRecordV1`, transaction, artifact, ledger-row,
and restore unions. Import the section types:

```diff
+import type {
+  CodexProvenanceEntry,
+  CodexProvenanceLedger,
+} from "./convergence-types";
+import {
+  readIntegrationRecord,
+  updateIntegrationRecord,
+} from "./integration-record";
```

WP12 writes only `record.provenance` through `updateIntegrationRecord`. The JSON
record keeps exactly `version`, the provenance ledger, and unknown extension keys
at the record, ledger, entry, artifact, and baseline levels. Passthrough is
recursive: every `CodexArtifactId` object variant and both baseline object variants
(`absent` and `present`) accept unknown keys, validators preserve each unknown value
verbatim (including nested objects/arrays), and an older writer changing a known
field must deep-equal preserve those extensions. The contract currently states and
tests only record/ledger/entry passthrough; audit round 5 #3 requires its artifact
and baseline types/validators to carry the same index-signature and preservation
rule. It does **not** keep
`nativeGeneration`, `currentTxId`, a pending/running history schedule, retry ownership,
or the next due time. Putting those fields here was wrong: two different coordinators
could each serialize their own read/replace and still overwrite one another.

Unparseable or wrong-version JSON fails closed. No WP12 code joins
`getConfigDir()/integrations/codex.json`, validates the top-level schema, or runs a
parallel read/merge/write (`005_contract.md` §1).

### Transition pair and schedule come from the coordinator row

The authoritative transition read is `readCodexTransitionState()` from
`src/codex/transition-state.ts`. It opens the exact SQLite path returned by
`resolveCodexCoordinatorDatabasePath(identity, canonicalCodexHome)`; consumers
append no identity, version, directory, or filename. Its singleton row contains the
native generation, current transaction ID, complete `CodexHistoryState`, and
`historySchedule {direction,authoritySnapshotId}`. `beginCodexTransition` advances
the pair and installs that transition's pending schedule in one `UPDATE ... WHERE
native_generation = ? AND current_tx_id IS ?`; `updateCodexHistoryTransition`
conditionally claims/completes/reschedules that same row and additionally matches
`history_tx_id`. A zero-row update writes nothing.

Audit round 5 #new 6 exposes a contract-schema hole: SQL
`CHECK(history_direction IN ('apply', 'remove'))` accepts `NULL`. WP12's producing
invariant is stricter: every row with `native_generation > 0` carries a non-null
`history_direction` of `apply` or `remove`, and terminal history updates retain that
direction together with the matching transaction/authority metadata. The contract's
positive-generation `CHECK` in `005_contract.md` must be tightened to require
`history_direction IS NOT NULL` as well as membership in the two-value set. Until
that contract correction lands, convergence still refuses to produce or accept a
positive-generation row with a null direction. Scheduling is a SQLite transition-row
operation; it never writes scheduling state to the integration record.

That row is the transition/scheduling authority. `readIntegrationRecord()` supplies
only provenance needed to prove an artifact baseline/post-image. Observation joins
the coordinator pair/schedule with the JSON provenance at read time; neither source
is copied into the other. Two `OPENCODEX_HOME` installations sharing one canonical
Codex home therefore see one pair and one pending owner instead of two generation
counters that both call themselves current.

## When provenance entries are written

1. After pre-lock admission and authoritative under-lock re-read, read every
   artifact baseline.
2. Before the first native write, persist contract `CodexProvenanceEntry` rows for
   every artifact this transition may touch, with this `txId` and one of the two
   contract baselines.
3. Commit one artifact.
4. Read current bytes after the successful write and persist its `postImage` hash.
5. Repeat; then conditionally write the expected native generation/`txId` plus the
   pending history schedule to the coordinator row and observe both stores.

A filename, marker, slug, mtime, backup name, or location is not creation proof. A
crash after native write but before `postImage` leaves unknown provenance and cannot
authorize automatic deletion.

## Two baseline classes, no third

Consume exactly `005_contract.md` §9:

- `absent` — no baseline artifact existed;
- `present` — the contract representation carries the exact baseline needed for
  restoration plus its hash.

There is no `present-required-nonempty`. The Pi `models.json {}` incident belongs
to `FOLLOWUP-FILECLIENT-01`; a Codex artifact phase has no file-client schema or
validator with which to implement that class.

Restoration:

- present + current bytes match our post-image -> restore exact contract baseline,
  then verify baseline hash;
- absent + current bytes match our post-image -> unlink, then verify absence;
- current bytes differ -> preserve; remove only exact provenance-owned structure
  when the format and ledger make that operation unambiguous, then report
  operational absence with historical drift;
- unparseable/ambiguous drift, missing/null post-image, wrong transaction, or lost/
  corrupt ledger -> write nothing and refuse on provenance.

### C10 is current-byte drift, not historical no-edit proof

A SHA-256 comparison proves only that the bytes observed **now** equal the recorded
post-image. It cannot prove the artifact was never edited and reverted between
observations. C10 is therefore narrowed to current-byte drift detection and safe
restoration from current evidence. No test or documentation may claim detection of
an edit-and-revert ABA that leaves identical bytes.

## Lost/corrupt ledger operator recovery — carried #10, round-4 E1

Automatic convergence always refuses lost/corrupt provenance and preserves native
bytes. “Start a fresh record” is not recovery; it silently turns unknown artifacts
into owned artifacts. The prior adoption design did exactly that to a worse input: it
called whatever bytes happened to be present “native.” After a crash mid-apply those
bytes may still route through OpenCodex, so OFF would later restore the routed bytes
as the baseline forever. That mechanism was wrong.

**INFERRED operator-recovery UX:** keep the explicit operator-only command, but make
adoption a serialized proof-and-provenance transaction:

```text
ocx restore --adopt-current-codex-baseline
```

The flag is rejected in service/agent-driven/automatic contexts and requires an
interactive confirmation naming the canonical Codex home. It requires the proxy
stopped, owned service authority, no external provider, no journal envelope, and a
pre-lock read-only classification of every target as `native-clean | ocx-residue |
ambiguous`. That first observation exists to inform/refuse before lock acquisition;
it is not write authority. **Only all `native-clean` may proceed to the locked
revalidation.** `ocx-residue` and `ambiguous` both abort before quarantine or record
replacement; the command prints the exact surface and evidence and asks the operator
to clean/inspect it outside this flow. There is no automatic “salvage by filename”
fallback in WP12.

The ledger is unavailable here, so positive residue proof comes only from the
artifact's own structure:

| Surface | Structural residue proof without the ledger | Native-clean gate |
|---|---|---|
| `config.toml` | The `# Auto-injected by opencodex` marker immediately owns a root `openai_base_url` (`src/codex/injected-marker.ts:53-60`); or the same marker immediately precedes the complete legacy table grammar emitted at `src/codex/inject.ts:119-134` and the root selector is `model_provider = "opencodex"`; managed subagent values are owned only by the exact markers in `src/codex/subagent-defaults.ts:10-11`. The recovery detector is stricter than the ordinary routing predicate at `src/codex/injected-marker.ts:68-71`, which does not by itself prove legacy creation. | TOML parses; none of those marker/value pairs or the exact legacy selector+owned-table structure exists; routing class is `native`. A bare local URL, malformed marker adjacency, or unowned `opencodex` table is ambiguous, not clean. |
| generated profile | File content matches one complete generated profile grammar: the OpenCodex banner plus its routing keys/provider block; `src/codex/inject.ts:436-460` is the generator. | Path absent, or readable content does not select OpenCodex and contains no generated banner. The basename `opencodex.config.toml` alone proves nothing; a partial signature is ambiguous. |
| catalog/cache | A row has both a namespaced slug and the stable `Routed via opencodex -> ` description signature used by `isOcxAuthoredRoutedEntry` (`src/codex/catalog/sync.ts:334-347`). | Every readable row lacks that paired signature and no active catalog/cache points to an OpenCodex-only routed slug. A filename, `owned_by`, or `comp_hash` alone is never proof. |
| history DB/manifest/rollouts | A valid manifest pre-image and its exact DB row/rollout identity jointly prove the OpenCodex transform. | The DB, manifest, and rollouts parse and the joint probe finds no owned transform. A lone `model_provider = opencodex`, path, or manifest entry is ambiguous because it cannot reconstruct the pre-image by itself. |
| journal/backups/partial transaction | Any journal envelope or validated partial-transaction marker is residue; a valid backup is evidence to inspect, not authority to restore. | Journal is absent and every backup/partial artifact is either structurally foreign or absent. An unreadable envelope, backup named by convention only, missing companion, or hashless partial is ambiguous. |

The ASCII `->` above is the documentation spelling; implementation compares the
exact Unicode prefix already emitted at `src/codex/catalog/sync.ts:283,346`.

The previous version validated native-clean state and wrote provenance across an
unlocked gap. A CLI convergence could change an artifact after final validation but
before JSON replacement or transition-row initialization, permanently recording a
baseline for a state that no longer existed. OFF could later “restore” those wrong
bytes. That mechanism was unsafe and is replaced by this exact order:

1. Acquire native/coordinator transaction `N` with `BEGIN IMMEDIATE`.
2. While holding `N`, acquire config transaction `C` where the all-surface proof
   reads config/generation/routing (the normal adoption path does).
3. Using the **already-open N connection**, authoritatively reread the transition
   row and every canonical target, then repeat the complete structural table above,
   config/authority/journal checks, target identities, digests, and baseline bytes.
4. Only if that under-lock result is still exactly all `native-clean` and agrees
   with the pre-lock observation may `integration-record.ts` quarantine unreadable
   JSON, `updateIntegrationRecord` write exact current `present`/`absent` baselines,
   and the same N connection initialize a missing row as contract `{0,null}` with
   `history.status:"unknown"`. Release `C`, then `COMMIT N`.

If any under-lock classification, identity, digest, authority, row state, or baseline
disagrees with the pre-lock observation, adoption refuses, rolls back/releases the
locks, reports the changed surface and both observations, and writes nothing. It does
not reclassify the new state as an acceptable baseline in the same invocation and does
not retry adoption automatically.

A ready transition row is preserved byte-for-byte, including its pair, direction,
authority metadata, and complete history state/schedule. A lost record has no
quarantine source. Adoption changes no Codex artifact and never imports a positive
pair from OPENCODEX_HOME-local legacy JSON. A subsequent explicit `convergeCodex`
performs apply/remove from the verified clean baseline. The command prints the
quarantine path and adopted provenance identity, never a newly invented `txId`.
Tests never auto-confirm this action.

This is a recovery path, not a second native mutation entry point: adoption establishes
provenance only; every Codex artifact mutation still goes through `convergeCodex`.

## Journal inspection and recovery

`src/codex/journal.ts` gains a read-only inspection result local to the journal
module. Corrupt/unknown-version bytes are preserved. PID `EPERM`/unknown is not
dead. A markerless version-1 journal may be structurally valid but lacks post-image
proof and blocks automatic replay.

```diff
-export function reconcileJournal(): boolean {
-  const journal = readJournal();
-  // read may delete malformed journal; dead PID may replay automatically
-}
+export function inspectJournal(): JournalInspection {
+  // Read/validate/liveness only; no delete, rename, repair, or replay.
+}
+
+function reconcileJournalUnlocked(
+  inspection: AuthorizedDeadJournal,
+): RestoreJournalResult {
+  // Called only after convergence re-inspects under N -> C, before C release/N commit.
+}
```

No log is emitted while locks are held.

## Observed state consumes contract types — C11

Delete `CodexObservedState`, `CodexConvergenceResult`, and
`CodexSyncConvergenceResult` from this document. `inspectCodexObservedState`
returns the contract's `CodexObservedState`; `convergeCodex` returns the contract's
`ConvergeOutcome`.

The observer reads service/external authority, managed config fragments, profile,
catalog/cache and routed slugs, journal/liveness, JSON provenance, the coordinator
row's generation/tx pair and history schedule, history DB/manifest/rollouts, backups,
and partial transaction residue. It performs no repair. Only the coordinator row
explains history status or may own/clear a pending schedule; JSON provenance cannot
override a newer coordinator transaction.

Desired ON converges only when the contract observer says applied. Desired OFF
converges only when residue is removed/restored. External/refused/partial remains
non-converged. Current-byte structural preservation can be operationally removed
while still reporting historical drift; it cannot be described as byte-exact
restoration.

`mutatePersistedConfig` already distinguishes `unchanged` from `committed`
(`src/config.ts:1837-1839,1877-1913`). `unchanged` intent never skips observation or
work: OFF may retain crash residue; ON may be missing a profile/catalog after an
explicit restore.

## Fresh admission in a long-lived server — C12

The old “one config read” cost claim is withdrawn. WP9 gather uses the exact config
object from the first `AdmissionSnapshot`, but `005_contract.md` §§3-4 requires an
authoritative re-read inside the coordinated commit. These are compatible duties,
not one read:

1. full persisted read before gather -> `AdmissionSnapshot A`; gather uses
   `A.config`;
2. full authoritative persisted re-read under native->config coordination ->
   `AdmissionSnapshot B`; compare B to A before commit;
3. cheap expected-transition checks around/after commit.

No resident watcher or server-captured config is authority. The config reader
returns unknown for missing/unreadable/invalid persisted config; default fallback
ON is not sufficient to mutate.

```diff
+function readCodexAdmissionSnapshot():
+  | AdmissionSnapshot
+  | Extract<ConvergeOutcome, { kind: "refused" | "failed" }> {
+  const diagnostics = readConfigDiagnostics();
+  if (diagnostics.source !== "file") return contractAdmissionRefusal(diagnostics.source);
+  return admittedSnapshotFromPersistedConfig(diagnostics);
+}
```

The helper is module-private and returns only contract shapes; it does not publish
an `AdmissionSnapshotResult` union.

`src/types.ts` adds the one-key client-integrations object; the config schema is
passthrough so unknown future integration keys survive a scoped mutation.

## `/api/sync` calls the contract adapter only

Delete WP12's status logic and custom result adapter. Current route
`src/server/management/config-routes.ts:261-268` becomes:

```diff
 if (url.pathname === "/api/sync" && req.method === "POST") {
-  const result = await syncModelsToCodex(undefined, config, null);
-  return jsonResponse(result, result.ok ? 200 : 500);
+  const outcome = await convergeCodex({
+    action: "converge",
+    scope: "full",
+    reason: "api-sync",
+    mode: "explicit",
+    deadlineMs: EXPLICIT_CODEX_CONVERGENCE_DEADLINE_MS,
+  });
+  return toSyncResponse(outcome);
 }
```

Status, body, and `Retry-After` belong only to
`src/server/management/sync-response.ts` (`005_contract.md` §5).

## One common entry point

`src/codex/convergence.ts` exports the contract's `convergeCodex` and no
`convergeCodexToPersistedIntent`, `inspectCodexMutationAdmission` public receipt,
or WP12-specific request/result type.

```ts
declare const convergeCodexImpl: (
  request: ConvergeRequest,
) => Promise<ConvergeOutcome>;
// Annotated rather than inferred: `ConvergeCodex` resolves through
// `./convergence-types`, which does not exist until WP8b lands, so an
// unannotated parameter compiles as implicit `any` (TS7006) in the excerpt.
export const convergeCodex: ConvergeCodex = (request: ConvergeRequest) =>
  convergeCodexImpl(request);
declare const EXPLICIT_CODEX_CONVERGENCE_DEADLINE_MS: number;
void convergeCodex({
  action: "converge",
  scope: "full",
  reason: "api-sync",
  mode: "explicit",
  deadlineMs: EXPLICIT_CODEX_CONVERGENCE_DEADLINE_MS,
});
```

The bodyless declaration printed here before round 4 was wrong and compiled as
TS2391. WP12 imports the contract's `ConvergeCodex` alias and assigns the real
implementation to it; the phase doc does not redeclare the alias or declare a
function without a body. `convergeCodexImpl` above is the compile-fixture name for
the existing implementation body that WP12 modifies. The compile-only call is the
`/api/sync` request above; omitting `scope:"full"` reproduces TS2345.

Callers say when/reason/mode/deadline. They never supply desired state, ownership,
journal verdict, provenance verdict, or apply/remove direction. `action:"observe"`
is the one read-only public operation; internal admission/observer helpers stay
module-private unless another contract phase explicitly owns them.

Rewire remaining startup/ensure/restore/eject/stop/uninstall paths in the same WP12
commit. Current direct sites include startup/ensure sync
(`src/cli/index.ts:319,367,409`), explicit restore/sync
(`src/cli/index.ts:528,591,756,768,829`), service restore
(`src/service.ts:2587,2625`), and server stop restore
(`src/server/management-api.ts:168-181`). A module-graph test proves none reaches
native writers except through `convergence.ts`.

Remove unconditional `invalidateCodexModelsCache()` from
`src/server/index.ts:403`; cache mutation occurs only in admitted convergence.

## Test plan

All tests use temporary homes, real contract record owner, port `0`, and production
`convergeCodex`. None invokes live CLI lifecycle commands or port 10100.

### Authority and ordering

1. Table-drive owned/foreign/unknown service evidence including corrupt,
   unreadable, conflicting, missing, unknown registration, and unresolvable paths.
2. External provider + dead markerless journal: byte-exact before/after across
   config/profile/catalog/backups/cache/history/rollouts; journal remains; no lock
   or record creation.
3. Foreign/unknown startup, ensure, API sync, teardown, and management mutation end
   before first lock event and preserve full manifests.
4. Invalid/unknown-version journal and unknown liveness preserve bytes and refuse.
5. Trace exact order through `convergeCodex`; OFF omits gather only.

### Bounded interference

1. Gather from snapshot A; cooperating config writer changes generation before
   lock. Under-lock snapshot B rejects before commit — prevention.
2. Inject a non-cooperating byte change after the final coordinated read but before
   post-commit check. Outcome is deferred/preserved and a bounded retry is scheduled
   — detection, not prevention.
3. Exhaust `deadlineMs`; assert typed unresolved outcome and no unbounded loop.
4. Native expected generation with another `txId` at the same number is
   interference in the coordinator row; JSON provenance remains byte-identical.
5. Stale history `CommitExpectation` is rejected before mutation, and its terminal
   conditional row update cannot clear the newer pending schedule.
6. Two distinct `OPENCODEX_HOME` processes sharing one canonical `CODEX_HOME`
   observe one coordinator pair; exactly one expected-row update wins.
7. Instrument lock events for each classify-then-write path and assert
   `BEGIN N -> acquire C -> authoritative classify/read/write on the same N
   connection -> release C -> COMMIT N`; a second coordinator connection is never
   opened inside the callback.
8. Seed a positive-generation row with null direction and require convergence to
   reject it. Valid apply/remove rows retain their non-null direction through every
   terminal history update; the tightened contract CHECK rejects the null fixture.

### Provenance/restoration/recovery

1. Apply from absent and present baselines through `convergeCodex`; verify each
   contract entry precedes native write and post-image follows read-back.
2. Matching current post-image restores exact present baseline or absence.
3. Current-byte drift preserves native additions; exact structural removal occurs
   only with unambiguous provenance. Unparseable drift blocks.
4. Edit then revert to the same bytes: test only that current equality permits the
   contract action; explicitly do **not** assert no edit occurred.
5. Crash between native write and post-image record; restart preserves/refuses.
6. Lost record and corrupt record: every automatic/normal explicit convergence
   refuses and preserves bytes.
7. Operator adoption with no confirmation does nothing. Confirmed adoption with
   one marker-owned config fragment, exact generated profile, routed catalog row,
   jointly owned history transform, or journal envelope refuses and changes neither
   native bytes nor JSON.
8. A markerless/basename-only/partial signature is `ambiguous`, not native-clean;
   adoption refuses instead of guessing. Table-drive every structural-proof row
   above, including exact clean negatives.
9. Only an all-native-clean observation may quarantine a corrupt JSON record and
   write exact current baselines. Pause after the pre-lock observation, mutate one
   target through a cooperating CLI convergence, then resume: under-lock
   revalidation disagrees, so adoption reports/refuses and writes/quarantines/
   initializes nothing. Assert native bytes and the coordinator pair/pending
   schedule belong to the winner; then a fresh, explicitly confirmed adoption may
   start from a new pre-lock observation.
10. Missing transition row + all-native-clean initializes only `{0,null}` with
    unknown history on the already-open N connection; a legacy positive JSON pair
    is never imported.
11. Adoption aborts atomically on one unreadable or changed target, external
    provider, live writer, running proxy, or noninteractive/agent-driven invocation.
12. Seed unknown nested extension values independently on every artifact-id variant
    and on both `absent`/`present` baseline variants. Exercise ordinary provenance
    update, post-image update, restoration, and adoption; require deep-equal
    preservation at record, ledger, entry, artifact, and baseline levels.

### Observed state and fresh intent

1. Drive applied, absent, each one-artifact partial, external/refused, current-byte
   drift, stale rollout, and nonempty manifest states through `action:"observe"`.
2. Persist OFF with one residue at a time; unchanged config mutation still converges.
3. Persist ON with one required artifact missing; unchanged mutation reconstructs
   and re-observes.
4. One running server starts with stale ON in memory; a subprocess persists OFF;
   `/api/sync` removes through fresh admission. Subprocess persists ON; same server
   gathers/applies without restart. Invalid config refuses/no write.
5. Route assertions use `toSyncResponse`; no duplicated status table.

### Production funnel

Walk static/dynamic imports, aliases, wrappers, and re-exports. Every lifecycle and
management native writer must be reachable only through `convergence.ts`. Grepping
for `convergeCodex` alone is insufficient (`005_contract.md` §Test plan).

## Verification

```bash
bun run typecheck
bun test tests/codex-ownership-authority.test.ts
bun test tests/codex-artifact-provenance.test.ts tests/codex-models-cache-restore.test.ts
bun test tests/codex-observed-state.test.ts tests/codex-convergence-order.test.ts
bun test tests/codex-journal.test.ts tests/codex-sync-api.test.ts tests/service.test.ts tests/uninstall.test.ts
bun test tests/codex-convergence-contract.test.ts
bun run test
bun run lint:gui
bun run privacy:scan
```

Round-4 document compile gate: extract every `ts` fence above in document order,
concatenate them, prepend `import type { OcxConfig } from "../types";`, and resolve
`AdmissionSnapshot`, `ConvergeRequest`, and `ConvergeCodex` from their exact
`005_contract.md` definitions (the imported outcome remains opaque because neither
fixture inspects an outcome field).
On 2026-08-04 the installed `bun x tsc --noEmit --strict --skipLibCheck
--moduleResolution bundler --module esnext --target es2022` exited **0 with zero
diagnostics**. The request fixture includes `scope:"full"`; the function surface is
the `ConvergeCodex` alias, not a bodyless declaration.

Live proof is the in-process server/subprocess test bound to port `0` with isolated
homes. Evidence names one server PID, two config-writer PIDs, prevention/deferred
interference traces, recovery quarantine/record hashes, and observed ON/OFF results.
A green response envelope without artifact read-back is insufficient. Never use the
live proxy on 10100.

## Accept criteria

- **C8** — exact `AdmissionSnapshot` authority precedes every artifact; foreign and
  unknown fail closed. Gather uses its config; authoritative re-read occurs inside
  coordinated commit.
- **C9** — external provider remains a separate veto and preserves all bytes.
- **C10 (narrowed)** — two contract baseline classes only. Matching current
  post-images restore; current-byte drift preserves/reports. No hash claims to prove
  absence of edit-and-revert. Lost/corrupt ledger adoption requires a complete
  verified native-clean observation repeated under `N -> C`; disagreement with the
  pre-lock observation refuses and writes nothing. Artifact and baseline extension
  keys survive recursively, not only record/ledger/entry keys.
- **C11** — observed state is the contract `CodexObservedState`; unchanged intent
  still converges and re-observes.
- **C12** — the same running server honors subprocess OFF then ON using a pre-gather
  snapshot and authoritative under-lock re-read; the old one-read cost claim is
  withdrawn.
- `/api/sync` calls only `convergeCodex` + `toSyncResponse`; no WP12 status/header
  owner exists.
- There is one convergence entry point and one shared result family.
- Native pair/pending schedule authority is the canonical-CODEX_HOME coordinator
  row. JSON retains only version, provenance, and extension keys, never transition
  or scheduling authority. Every positive generation has a non-null apply/remove
  direction; the contract SQLite CHECK must enforce that invariant.
- **N2** — WP12 rewires all remaining callers and passes its own typecheck/tests in
  the same commit. WP13 adds composed proof, not missing implementation.

## Explicitly open after WP12

Journal liveness still identifies a writer by PID only, so PID reuse may delay
recovery until a later journal version records a process-instance token. Terminal
provenance retention/compaction still needs a bounded policy after production
evidence. Neither gap permits fail-open mutation; preservation wins.
