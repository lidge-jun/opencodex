# WP1 — a snapshot substrate the native clients can use

> **Rev 3** after audit rounds 1 and 2 (`003_audit_synthesis.md`,
> `004_audit_synthesis_r2.md`). Rev 2 introduced compound snapshots, three-state
> outcomes, an async API, a service-ownership preflight, and scoped-down id
> widening. Rev 3 fixes what round 2 found: snapshot members are keyed, never
> path-addressed; the journal uses prepare/commit so a failed append cannot
> silently strand a mutation; `discardSnapshot` has a failure contract.

## Why this phase is first

Every later phase writes through it. Building the routes first would mean four
disable paths that mutate the user's files with no rollback, and rollback is the
non-negotiable of this unit.

## IN

1. `src/integrations/registry.ts` — MODIFY: add the native id union, keep the
   file-client type exactly as it is.
2. `src/integrations/journal.ts` — MODIFY: widen the JOURNAL/SNAPSHOT/MAINTENANCE
   surface to the superset; add compound snapshot capture/read.
3. `src/integrations/store.ts` — MODIFY: widen only the journal-side methods.
4. `src/integrations/native/writer.ts` — NEW: the transactional seam.
5. `src/integrations/native/clients.ts` — NEW: the native client specs.
6. `src/integrations/native/ownership-preflight.ts` — NEW: the service-home check.
7. `tests/native-integration-writer.test.ts` — NEW.

OUT: `writer.ts`, `merge.ts`, `serialize.ts`, `state.ts` — the file-client
parse/merge path is untouched. `config-io.ts` is reused as-is.
**`ownership.ts` is now OUT too** (audit #10): `OwnershipRecord` proves ownership
of merged fragments, which no native client has. Widening it would create a
persisted shape with no valid native value and push narrowing into every
file-client caller. `JournalEntry.priorRecord` stays `OwnershipRecord | null`
and native rows carry `null` — no widening needed for that.

## The id widening

`IntegrationClientId` stays exactly what it is — the six `ExportClientId`s —
because `INTEGRATION_CLIENTS`, the registry, `isLoopbackOnly`, and every
file-client call site are keyed by it, and widening it would make those records
non-exhaustive.

Add a parallel union and a superset:

```ts
// src/integrations/registry.ts (append)

/**
 * Clients whose integration is NOT a merged config fragment: Codex owns a
 * journal, Grok owns a fenced region, Desktop owns a profile in another app's
 * library, and Claude Code is a flag in our own config. They share the
 * snapshot/journal substrate and nothing else, which is why they are a separate
 * union rather than six-plus-four in one.
 */
export type NativeIntegrationClientId = "codex" | "claude" | "claudeDesktop" | "grok";

export const NATIVE_INTEGRATION_CLIENT_IDS: readonly NativeIntegrationClientId[] =
  ["codex", "claude", "claudeDesktop", "grok"] as const;

export function isNativeIntegrationClientId(value: string): value is NativeIntegrationClientId {
  return (NATIVE_INTEGRATION_CLIENT_IDS as readonly string[]).includes(value);
}

/** Anything the journal/snapshot substrate may key on. */
export type JournalClientId = IntegrationClientId | NativeIntegrationClientId;

export function isJournalClientId(value: string): value is JournalClientId {
  return isIntegrationClientId(value) || isNativeIntegrationClientId(value);
}
```

The ids match the GUI's `OverviewClientId` values already shipped in
`gui/src/pages/integrations/overview-clients.ts`, so no mapping layer is needed
between the card and the route.

### Journal widening (scoped down per audit #10)

`journal.ts`: replace `IntegrationClientId` with `JournalClientId` on
`JournalEntry.clientId`, `captureSnapshot`, `listOperations`, `readSnapshot`,
`countSnapshots`, `pruneSnapshots`, `markPruneFailure`, `clearPruneFailure`,
`snapshotDir`, and `MaintenanceState.pruneFailures`.

`ownership.ts` and `store.readRecords/putRecord/dropRecord` keep
`IntegrationClientId`. The cast at `store.ts:90-93` narrows explicitly.

One behavioral line changes, at `journal.ts:263`:

```diff
-          if (!isIntegrationClientId(key)) continue;
+          if (!isJournalClientId(key)) continue;
```

That guard drops unknown keys out of persisted maintenance state. Left as-is, a
native client's prune-failure row would be silently discarded on every read and
retention failures would go unreported for exactly the four clients this unit
adds.

`assertSafeComponent` already refuses separators and `..`, and the new ids are
plain identifiers, so the path-escape guard needs no change — but the test below
pins it for a native id anyway.

## Compound snapshots

The single-file `capture()` of rev 1 was the unit's most serious design error
(audit #1, #4). Neither Desktop nor Codex is a one-file operation, and a restore
that returns one file of a three-file mutation reconstructs a *broken* state —
for Desktop, precisely the dangling `appliedId` this unit exists to avoid.

```ts
// src/integrations/journal.ts (append)

/**
 * A snapshot of SEVERAL files taken as one unit.
 *
 * `text: null` means the file was absent, and restore of an absent member means
 * DELETE — the same tagged-absence rule `SnapshotRef` already carries, applied
 * per member. `order` is the restore order the client requires; Desktop needs
 * profiles back before the metadata that references them.
 */
export interface CompoundSnapshotMember {
  /** Stable key, not a path. */
  key: string;
  text: string | null;
}
```

**Members carry no path.** Rev 2 persisted `absPath` and restore wrote to it,
which made a snapshot file into a list of write destinations: a corrupted or
hand-edited snapshot could name any user-writable path and restore would
overwrite or delete it (audit r2 #1 — Critical). The store's containment guards
protect the snapshot file itself, not what it points at.

So restore resolves every key through the CURRENT spec, and a key the spec does
not define is refused. The snapshot supplies bytes; only code supplies
destinations.

```ts
export interface NativeIntegrationSpec {
  /** The only source of truth for where a member lives. */
  resolveMember(key: string, ctx: NativeMutateContext): string | null;
}

/** Refuses unknown, duplicate, or missing keys before writing anything. */
export function resolveRestoreTargets(
  spec: NativeIntegrationSpec,
  members: readonly CompoundSnapshotMember[],
  ctx: NativeMutateContext,
): { ok: true; targets: { absPath: string; text: string | null }[] }
  | { ok: false; reason: "snapshot_schema_mismatch"; message: string } { ... }

export function captureCompoundSnapshot(
  clientId: JournalClientId,
  opId: string,
  members: readonly CompoundSnapshotMember[],
  dir: string = integrationsDir(),
): SnapshotRef {
  // One JSON document under the existing snapshot path, so retention, pruning
  // and the path-escape guards keep working unchanged.
  const payload = JSON.stringify({ v: 1, members }, null, 2);
  return captureSnapshot(clientId, opId, payload, dir);
}

export function readCompoundSnapshot(entry: JournalEntry, dir?: string):
  | { kind: "none" } | { kind: "expired" }
  | { kind: "stored"; members: CompoundSnapshotMember[]; path: string } { ... }

/**
 * Delete a snapshot no committed operation references (audit #3).
 *
 * Returns a result rather than throwing: a cleanup failure must not turn a
 * clean refusal into an error, and it must not be swallowed either — the bytes
 * may hold credentials and no journal row exists for retention to find them by
 * (audit r2 #9). A failure is recorded as orphan-snapshot maintenance, which
 * surfaces as retention degradation on the client's card.
 */
export function discardSnapshot(ref: SnapshotRef, clientId: JournalClientId, opId: string,
  dir?: string): { ok: true } | { ok: false; error: string } { ... }
```

Storing it as one JSON blob under the existing snapshot file means retention,
the `assertSafeComponent` guard, 0600 and Windows ACL hardening all keep working
with no changes. A member list is not a new store.

## The native writer seam

```ts
// src/integrations/native/writer.ts — NEW

/**
 * Snapshot first, then let the client do its own thing.
 *
 * The file clients share one write algorithm — parse, merge fragments,
 * serialize — so `writer.ts` can own the whole operation. The native four share
 * nothing except the requirement that the bytes they are about to change are
 * recoverable afterwards. So this seam owns exactly that requirement and
 * delegates the rest.
 *
 * Ordering is the same as `writer.ts` and for the same reason: the snapshot is
 * committed BEFORE the mutation, so a crash between the two leaves a recoverable
 * file rather than a changed one nobody can undo.
 */
import { fingerprint, type OwnershipRecord } from "../ownership";
import { newOpId, type JournalEntry, type OperationKind } from "../journal";
import { defaultStore, type IntegrationStateStore } from "../store";
import type { NativeIntegrationClientId } from "../registry";

export type NativeRefusalReason =
  | "not_installed"
  | "orphaned_marker"
  | "home_mismatch"
  | "foreign_owner"
  | "non_loopback"
  | "no_safe_desktop_fallback"
  | "write_failed";

/**
 * Three outcomes, because two were a lie (audit #2).
 *
 * Rev 1 had ok/refused, and every thrown error became "refused" — including one
 * thrown AFTER a file had already changed. `removeDesktop3pConfig` catches
 * everything into `removed: false`, so a metadata write that succeeded followed
 * by a delete that failed would have told the user nothing happened while their
 * library sat half-changed. `writer.ts` already models this with `compensate()`
 * and a `residual` flag; this is the same idea named explicitly.
 */
export type NativeWriteOutcome =
  | { status: "unchanged"; clientId: NativeIntegrationClientId; message: string }
  | { status: "committed"; clientId: NativeIntegrationClientId; message: string;
      opId: string; snapshotPath?: string }
  | { status: "refused"; clientId: NativeIntegrationClientId;
      reason: NativeRefusalReason; message: string }
  /**
   * Some artifacts changed and compensation did not fully restore them. This
   * ALWAYS carries a journal row and a snapshot path: the residual state is
   * exactly when the user most needs the Rollback Centre to have an entry.
   */
  | { status: "partial"; clientId: NativeIntegrationClientId; message: string;
      opId: string; snapshotPath: string; residualPaths: readonly string[] };

/**
 * What a native client must tell the substrate.
 *
 * `capture()` returns the bytes to snapshot, or `null` when there is nothing on
 * disk — the same `null`-means-absent contract the file clients use, so restore
 * of an absent original means "delete", not "write an empty file".
 */
export interface NativeIntegrationSpec {
  id: NativeIntegrationClientId;
  /** Primary path, for display and the journal row. */
  targetPath: (ctx: NativeMutateContext) => string;
  /**
   * Non-mutating gate, run BEFORE any snapshot (audit #3, #5).
   *
   * Every refusal that can be known in advance belongs here, so the common case
   * never writes a credential-bearing snapshot it then has to delete. The
   * shared service-ownership check runs here for Codex and Grok, which is what
   * makes `home_mismatch` reachable at all.
   */
  preflight: (enabled: boolean, ctx: NativeMutateContext) =>
    Promise<{ ok: true } | { ok: false; reason: NativeRefusalReason; message: string }>;
  /** Every artifact this operation may change, in RESTORE order. */
  members: (ctx: NativeMutateContext) => Promise<readonly CompoundSnapshotMember[]>;
  mutate: (enabled: boolean, ctx: NativeMutateContext) => Promise<
    | { ok: true; changed: boolean; message: string }
    /** `mutated` names what already changed, so compensation is targeted. */
    | { ok: false; reason: NativeRefusalReason; message: string;
        mutated?: readonly string[] }>;
  /** Put a captured member set back, in the order given. Absent means delete. */
  restore: (members: readonly CompoundSnapshotMember[], ctx: NativeMutateContext) => Promise<void>;
}

export interface NativeMutateContext {
  env: NodeJS.ProcessEnv;
  port: number;
  config: OcxConfig;
}

export async function runNativeOperation(input: {
  spec: NativeIntegrationSpec;
  enabled: boolean;
  ctx: NativeMutateContext;
  store?: IntegrationStateStore;
}): Promise<NativeWriteOutcome> {
  const { spec, enabled, ctx } = input;
  const store = input.store ?? defaultStore();

  // 1. Preflight FIRST — a knowable refusal must not write a snapshot it then
  //    has to clean up, and a cleanup that itself fails would leak credentials.
  const gate = await spec.preflight(enabled, ctx);
  if (!gate.ok) {
    return { status: "refused", clientId: spec.id, reason: gate.reason, message: gate.message };
  }

  const opId = newOpId();
  const before = await spec.members(ctx);
  // 2. Snapshot BEFORE mutating: a crash after this point is recoverable.
  const snapshot = captureCompoundSnapshot(spec.id, opId, before, store.root);

  /*
   * 3. PREPARE the journal row before touching anything (audit r2 #4).
   *
   * Rev 2 appended the row after a successful mutation, so an append that threw
   * left the artifacts changed, the snapshot present, and NOTHING in the
   * Rollback Centre pointing at it — the same "committed work with no handle"
   * failure as round 1 #2, moved one boundary later. A prepared row is written
   * first and resolved afterwards, so the worst case is a row that says
   * `prepared` and names its snapshot, which is exactly what recovery needs.
   *
   * If the PREPARE append fails, nothing has been mutated yet: discard the
   * snapshot and refuse. That is the one honest place to give up.
   */
  const prepared = store.appendJournal({ ...entryShell(opId, spec, enabled, ctx), phase: "prepared", snapshot });
  if (!prepared.ok) {
    discardSnapshot(snapshot, spec.id, opId, store.root);
    return { status: "refused", clientId: spec.id, reason: "write_failed",
      message: `could not record the operation before starting it: ${prepared.error}` };
  }

  let result: Awaited<ReturnType<typeof spec.mutate>>;
  try {
    result = await spec.mutate(enabled, ctx);
  } catch (error) {
    // A throw past preflight may have left artifacts changed. Treat it as
    // partial unless compensation proves otherwise.
    return await compensate(spec, ctx, store, opId, snapshot, before, messageOf(error), enabled);
  }

  if (!result.ok) {
    if (result.mutated?.length) {
      return await compensate(spec, ctx, store, opId, snapshot, before, result.message, enabled);
    }
    // A clean refusal changed nothing, so the snapshot references an operation
    // that never happened. Discard it: retention prunes from journal rows, so
    // an unreferenced snapshot would never be collected (audit #3).
    discardSnapshot(snapshot, store.root);
    return { status: "refused", clientId: spec.id, reason: result.reason, message: result.message };
  }
  if (!result.changed) {
    discardSnapshot(snapshot, store.root);
    return { status: "unchanged", clientId: spec.id, message: result.message };
  }

  const after = await spec.members(ctx);
  const primaryKey = spec.primaryKey;
  const primary = after.find(member => member.key === primaryKey) ?? null;
  /*
   * 4. RESOLVE the prepared row. A failure here cannot strand the mutation:
   *    the prepared row already names the snapshot, so the Rollback Centre has
   *    its handle either way. Report it honestly rather than claiming a clean
   *    commit the journal never recorded.
   */
  const resolved = store.appendJournal({
    ...entryShell(opId, spec, enabled, ctx), phase: "committed", snapshot,
    resultFingerprint: primary?.text == null ? "" : fingerprint(primary.text),
    resultAbsent: primary?.text == null,
    priorRecord: null,   // native clients own no merged fragments
  });
  const stored = store.readSnapshot({ opId, snapshot } as JournalEntry);
  const snapshotPath = stored.kind === "stored" ? stored.path : undefined;
  if (!resolved.ok) {
    return { status: "partial", clientId: spec.id, opId, snapshotPath: snapshotPath!,
      message: `the change succeeded but could not be recorded: ${resolved.error}`,
      residualPaths: [] };
  }
  return { status: "committed", clientId: spec.id, message: result.message, opId,
    ...(snapshotPath ? { snapshotPath } : {}) };
}
```

`compensate` attempts `spec.restore(before, ctx)`. If it succeeds the operation
becomes a `refused` with the original reason and the snapshot is discarded. If
it does NOT, the outcome is `partial`: the journal row is written anyway, so the
Rollback Centre has an entry pointing at the pre-operation bytes, and
`residualPaths` names the artifacts left inconsistent. That is the one case
where a journal row for a failed operation is correct — it is the user's only
handle on the mess.

## The service-ownership preflight

```ts
// src/integrations/native/ownership-preflight.ts — NEW

/**
 * Refuse shared teardown when an installed service belongs to another home.
 *
 * `ocx stop` has honored this for both Codex and Grok since it started catching
 * `ServiceOwnershipError` (`src/cli/index.ts:464`), but nothing on the HTTP side
 * did — so a route that called `restoreNativeCodex`/`stripGrokConfig` directly
 * would pull shared config out from under a service running from a different
 * `CODEX_HOME`/`OPENCODEX_HOME`. Rev 1 declared the refusal without wiring the
 * check, which made it dead by construction (audit #5).
 */
export function assertNativeTeardownOwned():
  | { ok: true }
  | { ok: false; reason: "home_mismatch"; message: string; recordedHome: string; currentHome: string }
```

It reads the installed service state and compares normalized homes, the same
comparison `src/service.ts:216` makes. Codex and Grok call it in `preflight`
for the DISABLE direction only — enabling writes our own block and does not tear
down shared state.

## The specs

All async. Codex's member set is the real blast radius (audit #4):

```ts
export const CODEX_SPEC: NativeIntegrationSpec = {
  id: "codex",
  targetPath: () => codexConfigPath(),
  preflight: async (enabled) => {
    if (enabled) return { ok: true };
    const owned = assertNativeTeardownOwned();
    if (!owned.ok) return owned;
    const external = currentExternalCodexModelProvider();
    return external
      ? { ok: false, reason: "foreign_owner",
          message: `Codex is routed through ${external}, not opencodex.` }
      : { ok: true };
  },
  /*
   * Four members, because `restoreNativeCodex` touches four things. The
   * opencodex journal is included deliberately: a complete restore DELETES it
   * (`src/codex/journal.ts:109-141`), so without capturing it here the
   * mechanism a later undo would need is gone by the time it is needed.
   *
   * `state_5.sqlite` is deliberately EXCLUDED: it is a live database touched
   * only by legacy history retagging, copying it without holding its lock is
   * its own hazard, and it already has a separate backup. The dialog says the
   * resume-history tag is not covered rather than implying it is.
   */
  members: async () => [
    { key: "config", text: readTextOrNull(codexConfigPath()) },
    { key: "profile", text: readTextOrNull(CODEX_PROFILE_PATH) },
    { key: "catalog", text: readTextOrNull(readCodexCatalogPath()) },
    { key: "ocx-journal", text: readTextOrNull(codexJournalPath()) },
  ],
  resolveMember: key => ({
    config: codexConfigPath(), profile: CODEX_PROFILE_PATH,
    catalog: readCodexCatalogPath(), "ocx-journal": codexJournalPath(),
  }[key] ?? null),
  mutate: async (enabled, ctx) => { ... },
  /*
   * File members go back by key, then history is reconciled SEMANTICALLY
   * (audit r2 #7). `restoreNativeCodex` always retags resume history, so a
   * file-only restore returns proxy-routed config beside native-tagged threads
   * — a real inconsistency, not just a missing backup. We do not copy the live
   * SQLite database; we call the existing history sync in the matching
   * direction using its own backup manifest, and report `partial` if it fails.
   */
  restore: async (members, ctx) => {
    for (const target of resolveRestoreTargets(CODEX_SPEC, members, ctx).targets) {
      writeOrRemove(target.absPath, target.text);
    }
    await syncCodexHistoryProvider(routingKindAfterRestore(members), ...);
  },
};
```

Grok keeps one member (`config.toml` — the fence is the only thing it touches).
Claude Code keeps one member (opencodex's own `config.json`); the claim that it
writes "nothing on disk" was wrong and is corrected in `001` (audit #12) — it
writes OUR config, just no external client's.

## Acceptance

- [ ] A committed operation captures every member BEFORE mutating; a test
      asserts each member's pre-mutation bytes are in the snapshot.
- [ ] Snapshot members carry NO path; a snapshot whose members are hand-edited
      to name `/etc/passwd` or `../../x` is refused as
      `snapshot_schema_mismatch` and writes nothing (audit r2 #1).
- [ ] Unknown, duplicate, or missing member keys are all refused before any
      write.
- [ ] Restore of a member captured as `null` DELETES that file.
- [ ] A journal PREPARE failure discards the snapshot and mutates nothing.
- [ ] A journal RESOLVE failure returns `partial` with the snapshot path — never
      `committed` and never a throw (audit r2 #4).
- [ ] Codex restore reconciles resume history rather than leaving it native-
      tagged against restored proxy config (audit r2 #7).
- [ ] `discardSnapshot` failure records orphan maintenance and surfaces as
      retention degradation, without turning a refusal into an error.
- [ ] Codex's member set is exactly config + profile + catalog + ocx-journal; a
      test asserts a disable→restore round trip returns all four.
- [ ] Every refusal and every no-op leaves the snapshot directory byte-identical
      to before the call — no leaked snapshot (audit #3).
- [ ] A refusal appends no journal row; a `partial` DOES, with `snapshotPath`
      and non-empty `residualPaths`.
- [ ] Failure injected at each mutate boundary yields `partial`, not `refused`,
      whenever an artifact already changed.
- [ ] `home_mismatch` is reachable: a temp install-state fixture with a foreign
      home makes Codex and Grok disable refuse, and NOTHING is written.
- [ ] Every `GrokInjectResult.skippedReason` maps to its own reason;
      `orphaned-marker` is `orphaned_marker`, never `write_failed`.
- [ ] `isJournalClientId` accepts all ten ids; maintenance state for a native id
      survives a round trip.
- [ ] `OwnershipRecord` still refuses a native id at the type level.
- [ ] `assertSafeComponent` still refuses a crafted id containing a separator.
- [ ] The six file clients' tests stay green untouched.
- [ ] `bun run typecheck` clean.
