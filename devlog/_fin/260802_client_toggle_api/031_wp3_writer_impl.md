# 031 — WP3 bodies: merge/remove and the writer

> **Status: verified by `tools/check-blocks.ts` (see `007_execution_method.md`).**
> The bodies below are compiled as self-contained units by the block checker.
> They remain the paste source; the checker guarantees they parse and are
> internally consistent, while cross-module resolution is settled by the
> repository's own `bun run typecheck` during the implementing phase.



Paste-ready implementation for `030`. Types come from `006_module_contracts.md`
(authoritative). Sub-decade doc per LEXICO-SPLIT-01 overflow; same phase as 030.

**A-gate round-3 corrections folded in — read these before the bodies below:**

1. **A read failure is not absence.** `io.readText` returns a tagged result
   (006 §5). Only `missing` means "no file"; `failed` (EACCES/EPERM/EISDIR)
   is `unsafe` and must never reach parse/merge/write.
2. **A stale refresh removes the previous fragments first.** Apply from
   `stale` deletes the *recorded* paths, then merges the fresh contribution
   into that result. Otherwise a renamed or dropped Kimi model leaves an
   orphan the new record no longer owns, and disable can never remove it.
3. **Restore records what it actually restored**, derived from the restored
   bytes — not the fresh contribution. Recording the fresh one would let a
   later disable delete paths the restored file does not have while leaving
   the ones it does.
4. **Bookkeeping order is file → record → journal**, with compensation and a
   `residual: true` refusal when compensation itself fails (006 §5). All
   bookkeeping goes through the injected seams so the failure is testable.

The bodies in §2-§4 are written against these rules.

## 0. Shared seam — `src/integrations/config-io.ts` is **WP2's** module

`parseConfig`, `loadTarget`, and `defaultIntegrationIO` are owned by WP2 and
documented in `021` §5, because `readIntegrationState` needs them and WP2 must
typecheck with no WP3 file present (006 §8 phase-boundary rule). WP3 imports
them; `merge.ts` does NOT redeclare `parseConfig`. The bodies below are
reproduced here only as the reference WP3 codes against.

```ts
/**
 * Commit the client file, then the record, then the journal row — restoring
 * the file and dropping the record if either bookkeeping step fails.
 */
function commit(io: IntegrationIO, args: {
  configPath: string; before: string | null; nextText: string | null;
  record: OwnershipRecord | null; clientId: IntegrationClientId; entry: JournalEntry;
  snapshotPath?: string; state: IntegrationState;
  /** Ownership as it stood BEFORE this operation; restored on compensation. */
  priorRecord: OwnershipRecord | null;
}): WriteOutcome {
  try {
    if (args.nextText === null) io.removeFile(args.configPath);
    else { io.mkdirp(dirname(args.configPath)); io.writeText(args.configPath, args.nextText); }
  } catch (error) {
    return refuse(args.clientId, "write_failed", args.state, msg(error), args.snapshotPath);
  }
  try {
    if (args.record) io.putRecord(args.record); else io.dropRecord(args.clientId);
  } catch (error) {
    return compensate(io, args, error, "could not record ownership");
  }
  try {
    io.appendJournal(args.entry);
  } catch (error) {
    return compensate(io, args, error, "could not append the journal row");
  }
  return { ok: true, changed: true, state: args.state, clientId: args.clientId,
           opId: args.entry.opId, message: "ok" };
}

function compensate(io: IntegrationIO, args: { configPath: string; before: string | null;
  clientId: IntegrationClientId; state: IntegrationState; snapshotPath?: string;
  priorRecord: OwnershipRecord | null },
  cause: unknown, what: string): WriteRefused {
  // Every compensating step is guarded: a swallowed bookkeeping failure would
  // leave provenance disagreeing with the file, which is exactly what the
  // residual flag exists to announce (A-gate round 4, blocker 5).
  try {
    if (args.before === null) io.removeFile(args.configPath);
    else io.writeText(args.configPath, args.before);
    // Put ownership back the way it was — not merely drop the new record,
    // which would erase a record a refresh/disable/restore had replaced.
    if (args.priorRecord) io.putRecord(args.priorRecord);
    else io.dropRecord(args.clientId);
  } catch {
    // Rollback failed (file or ownership). Say so — a false "rolled back" is
    // worse than the original error.
    return { ok: false, reason: "write_failed", state: args.state, clientId: args.clientId,
      residual: true, snapshotPath: args.snapshotPath,
      message: `${what}, and the change could not be rolled back. The file or its ownership record is in an intermediate state; the backup is at ${args.snapshotPath ?? "(none)"}.` };
  }
  return { ok: false, reason: "write_failed", state: args.state, clientId: args.clientId,
    snapshotPath: args.snapshotPath, message: `${what}; the change was rolled back. Cause: ${msg(cause)}` };
}
```

`io.appendJournal` commits the row and nothing else; snapshot pruning is
post-commit best-effort inside `journal.ts` and can never surface as an append
failure (006 §5). That is what makes "no phantom row" true rather than hoped.

## 1. `src/integrations/merge.ts` (NEW)

```ts
import type { ConfigFormat, ManagedContribution, ManagedFragment } from "../clients/config-export";
import { renderToml, renderYaml, serializeDocument } from "./serialize";
import { parseConfig, PARSE_FAILED } from "./config-io";

// parseConfig lives in WP2's config-io.ts (006 §8) — merge.ts imports it
// rather than declaring a second copy that could drift.

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Write `value` at `path`, creating intermediate objects. Returns a new document. */
export function setPath(doc: unknown, path: readonly string[], value: unknown): unknown {
  const root: Record<string, unknown> =
    typeof doc === "object" && doc !== null && !Array.isArray(doc)
      ? (clone(doc) as Record<string, unknown>)
      : {};
  let cursor = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = clone(value);
  return root;
}

/** Delete `path`. Returns whether anything was removed. Prunes emptied parents we created. */
export function deletePath(doc: unknown, path: readonly string[]): { doc: unknown; removed: boolean } {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { doc, removed: false };
  const root = clone(doc) as Record<string, unknown>;
  const chain: Record<string, unknown>[] = [root];
  let cursor: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) return { doc: root, removed: false };
    cursor = next as Record<string, unknown>;
    chain.push(cursor);
  }
  const leaf = path[path.length - 1]!;
  if (!(leaf in cursor)) return { doc: root, removed: false };
  delete cursor[leaf];
  // Prune containers that we emptied, but never the document root: a client
  // that legitimately has an empty `providers: {}` should keep it.
  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const node = chain[i]!;
    if (Object.keys(node).length > 0) break;
    delete chain[i - 1]![path[i - 1]!];
  }
  return { doc: root, removed: true };
}

/** Insert every fragment. Everything else in the document is preserved. */
export function mergeContribution(doc: unknown, contribution: ManagedContribution): unknown {
  let next = doc;
  for (const fragment of contribution.fragments) next = setPath(next, fragment.path, fragment.value);
  return next;
}

/**
 * Remove exactly the RECORDED paths — never a prefix scan. A user's own
 * `models["opencodex/foo"]` that we did not write has no recorded path, so it
 * survives (and the classifier reports conflict, which is the honest answer).
 */
export function removeFragments(
  doc: unknown, paths: readonly (readonly string[])[],
): { doc: unknown; removed: boolean } {
  let next = doc;
  let removed = false;
  for (const path of paths) {
    const result = deletePath(next, path);
    next = result.doc;
    removed = removed || result.removed;
  }
  return { doc: next, removed };
}

export { serializeDocument, renderToml, renderYaml };
```

## 2. `src/integrations/writer.ts` (NEW) — apply

```ts
export function applyIntegration(input: IntegrationWriteInput): WriteOutcome {
  const store = input.store ?? createIntegrationStateStore();
  store.retryPendingPrunes();   // before any write; logged no-op on failure
  const io = input.io ?? defaultIntegrationIO(store);
  const clientId = input.clientId;
  const spec = INTEGRATION_CLIENTS[clientId];
  const exportSpec = EXPORT_CLIENTS[clientId];
  const configPath = spec.configPath(input.env);

  if (io.statKind(spec.detectDir(input.env, input.home)) !== "dir") {
    return refuse(clientId, "not_installed", "absent", `${clientId} is not installed`);
  }
  if (isLoopbackOnly(clientId) && !isLoopbackHostname(input.config.hostname)) {
    return refuse(clientId, "non_loopback", "absent",
      `${clientId} has nowhere to put the admission header a non-loopback bind requires, so a generated config would be rejected. Configure it by hand instead.`);
  }

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return refuse(clientId, "unsafe", "unsafe",
      target.why === "read-failed"
        ? `${configPath} exists but could not be read`
        : `${configPath} is not a regular file`);
  }
  const before = target.before;

  const parsed = parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return refuse(clientId, "unsafe", "unsafe", `${configPath} could not be parsed`);
  }

  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = store.readRecords()[clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: before, fileIsRegular: true, parsed, record, contribution,
  });
  if (state === "conflict") {
    return refuse(clientId, "conflict", "conflict",
      reason === "foreign-edit"
        ? `${configPath} changed after opencodex wrote it`
        : `${configPath} already contains an opencodex block we did not write`);
  }
  if (state === "current") {
    return { ok: true, changed: false, state, clientId, message: "already applied" };
  }

  // A stale refresh must first drop the fragments the PREVIOUS record owned.
  // Merging alone would strand a renamed/removed model (e.g. a Kimi selector
  // that left the catalog) as an orphan the new record no longer owns, so a
  // later disable could never remove it.
  const base = state === "stale" && record
    ? removeFragments(parsed, record.fragmentPaths).doc
    : parsed;
  const merged = mergeContribution(base, contribution);
  const text = serializeDocument(merged, exportSpec.format);
  const opId = newOpId();

  // Compare-before-commit: re-read immediately before writing. A mismatch
  // means someone wrote between classify and now — abort rather than lose it.
  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while applying`);
  }

  const snapshot = store.captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  return commit(io, {
    configPath, before, nextText: text, clientId, state: "current",
    snapshotPath: snapshotAbsPath(snapshot),
    priorRecord: record,
    record: {
      clientId, configPath, fileFingerprint: fingerprint(text),
      blockFingerprint: fingerprint(canonicalContribution(contribution)),
      fragmentPaths: fragmentPathsOf(contribution), appliedAt: at, opId,
    },
    entry: { opId, clientId, kind: state === "stale" ? "refresh" : "apply", at, configPath,
             snapshot, resultFingerprint: fingerprint(text), resultAbsent: false,
             priorRecord: record },
  });
}
```

## 3. disable

```ts
export function disableIntegration(input: IntegrationWriteInput): WriteOutcome {
  const store = input.store ?? createIntegrationStateStore();
  store.retryPendingPrunes();
  const io = input.io ?? defaultIntegrationIO(store);
  const clientId = input.clientId;
  const spec = INTEGRATION_CLIENTS[clientId];
  const exportSpec = EXPORT_CLIENTS[clientId];
  const configPath = spec.configPath(input.env);

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return refuse(clientId, "unsafe", "unsafe",
      target.why === "read-failed"
        ? `${configPath} exists but could not be read`
        : `${configPath} is not a regular file`);
  }
  const before = target.before;
  const parsed = parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return refuse(clientId, "unsafe", "unsafe", `${configPath} could not be parsed`);
  }

  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = store.readRecords()[clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: before, fileIsRegular: true, parsed, record, contribution,
  });
  if (state === "absent") {
    return { ok: true, changed: false, state, clientId, message: "not applied" };
  }
  if (state === "conflict") {
    return refuse(clientId, "conflict", "conflict",
      reason === "foreign-edit"
        ? `${configPath} changed after opencodex wrote it; disable would discard that edit`
        : `${configPath} contains an opencodex block we did not write`);
  }
  // current | stale only — the file fingerprint still matches our record, so
  // the recorded paths are exactly what we put there.
  const { doc, removed } = removeFragments(parsed, record!.fragmentPaths);
  if (!removed) {
    return { ok: true, changed: false, state: "absent", clientId, message: "nothing to remove" };
  }
  const text = serializeDocument(doc, exportSpec.format);

  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while disabling`);
  }

  const opId = newOpId();
  const snapshot = store.captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  // record: null drops it — a record with no block would later read as conflict.
  return commit(io, {
    configPath, before, nextText: text, clientId, state: "absent", record: null,
    snapshotPath: snapshotAbsPath(snapshot), priorRecord: record,
    entry: { opId, clientId, kind: "disable", at, configPath, snapshot,
             resultFingerprint: fingerprint(text), resultAbsent: false,
             priorRecord: record },
  });
}
```

## 4. restore

```ts
export function restoreIntegration(input: IntegrationRestoreInput): WriteOutcome {
  const store = input.store ?? createIntegrationStateStore();
  store.retryPendingPrunes();
  const io = input.io ?? defaultIntegrationIO(store);
  const entry = store.findOperation(input.opId);
  if (!entry) throw new Error(`unknown operation ${input.opId}`);   // route maps to 404
  if (entry.clientId !== input.clientId) throw new Error("client mismatch");

  const spec = INTEGRATION_CLIENTS[entry.clientId];
  const configPath = spec.configPath(input.env);
  const snapshot = store.readSnapshot(entry);
  if (snapshot.kind === "expired") {
    return refuse(entry.clientId, "snapshot_expired", "absent", "that backup has expired");
  }

  // Resolve current bytes through the SAME seam every other operation uses,
  // so an unreadable file can never be mistaken for an absent one here either.
  const target = loadTarget(io, configPath);
  const backupHint = snapshot.kind === "stored" ? snapshot.path : undefined;
  if (!target.ok) {
    return refuse(entry.clientId, "unsafe", "unsafe",
      target.why === "read-failed"
        ? `${configPath} exists but could not be read; the backup is at ${backupHint ?? "(none)"}`
        : `${configPath} is not a regular file; the backup is at ${backupHint ?? "(none)"}`,
      backupHint);
  }
  const current = target.before;   // string | null

  // Drift: the file changed after the operation we are undoing.
  const drifted = fingerprint(current ?? "") !== entry.resultFingerprint;
  if (drifted && !input.confirmDrift) {
    return refuse(entry.clientId, "drift_requires_confirm", "conflict",
      "this file changed after that operation; confirm to replace it (the current version is backed up first)");
  }

  // Restore is itself journaled and itself undoable: snapshot the CURRENT file
  // first, so a confirmed drift-restore never destroys the newer edits.
  const opId = newOpId();
  const preSnapshot = store.captureSnapshot(entry.clientId, opId, current);
  const restoredText = snapshot.kind === "none" ? null : snapshot.text;
  // NOTE: no write happens here. `commit` below performs the ONE mutation, so
  // a failure can never leave an unjournaled change (A-gate round 4, blocker 3).
  const exportSpec = EXPORT_CLIENTS[entry.clientId];
  const fresh = exportSpec.buildContribution(exportContextOf(input));

  /**
   * Provenance is RESTORED, never re-derived. `entry.priorRecord` is the
   * ownership record as it stood when that snapshot was taken, so the record
   * and the bytes always describe the same thing.
   *
   * The earlier attempt read the restored document and claimed every
   * `opencodex/...` key as ours. That silently adopted a user's own entry and
   * let a later disable delete it — the exact invariant this feature exists to
   * protect (A-gate round 4, blocker 4). Ownership is never inferred from a
   * prefix; `extractContribution` is deleted.
   */
  const restoredRecord = entry.priorRecord;
  const state: IntegrationState =
    restoredRecord === null
      ? (restoredText === null ? "absent" : "conflict")
      : restoredRecord.blockFingerprint === fingerprint(canonicalContribution(fresh))
        ? "current"
        : "stale";

  const at = new Date(io.now()).toISOString();
  return commit(io, {
    configPath, before: current, nextText: restoredText, clientId: entry.clientId, state,
    snapshotPath: snapshotAbsPath(preSnapshot),
    // The restored record IS the prior one, with the file fingerprint refreshed
    // to the bytes we just put back. Its fragmentPaths and blockFingerprint are
    // carried verbatim — they described these bytes when the snapshot was taken.
    record: restoredRecord === null ? null : {
      ...restoredRecord,
      fileFingerprint: restoredText === null ? "" : fingerprint(restoredText),
      appliedAt: at,
      opId,
    },
    priorRecord: store.readRecords()[entry.clientId] ?? null,
    entry: { opId, clientId: entry.clientId, kind: "restore", at, configPath,
             snapshot: preSnapshot,
             resultFingerprint: restoredText === null ? "" : fingerprint(restoredText),
             resultAbsent: restoredText === null,
             priorRecord: store.readRecords()[entry.clientId] ?? null },
  });
}

```

**No prefix is consulted anywhere in this module.** Ownership comes from a
record — the live one for apply/disable, `entry.priorRecord` for restore — and
removal touches only recorded paths. A user's own `opencodex/...` entry is
therefore never owned, never removed, and correctly reads as `conflict`
because no record covers it.

## 5. IO seam (WP2-owned)

`defaultIntegrationIO` and `loadTarget` live in `src/integrations/config-io.ts`,
which WP2 owns because `readIntegrationState` needs them too (006 §8). Their
bodies are in `021` §6; WP3 imports them and declares neither.

Every test substitutes the seam wholesale — no `node:fs` monkey-patching — and
the `now` member is what makes WP4's stale-flight branch reachable.

## 6. Activation table (superset of 030 §5)

| Branch | Trigger | Observable proof |
|---|---|---|
| `not_installed` | `statKind(detectDir)` returns `missing` | `reason === "not_installed"`, no journal row |
| `non_loopback` | kimi + `hostname: "0.0.0.0"` | refused; file untouched |
| `unsafe` not-regular | config path is a directory | `reason === "unsafe"` |
| `unsafe` unparseable | config contains `{{{` | `reason === "unsafe"` |
| conflict foreign-edit | record present, file appended to | refused; user bytes intact |
| conflict unowned-key | fragments present, no record | refused |
| idempotent apply | apply twice | second `changed === false`, no new journal row |
| compare-before-commit | `readText` returns A then B | refused `conflict`; snapshot dir gains nothing |
| `write_failed` | `writeText` throws | `reason === "write_failed"`, `snapshotPath` set |
| compensating rollback (record) | `putRecord` throws | file restored to `before`; refusal returned; no record persisted |
| compensating rollback (journal) | `appendJournal` throws | file restored to `before`; the record just written is dropped; **no phantom row** |
| residual failure | `appendJournal` throws AND the rollback `writeText` also throws | `residual === true`, message names the snapshot path, no false "rolled back" claim |
| unreadable existing file | `statKind` = `file`, `readText` returns `{kind:"failed",code:"EACCES"}` | `reason === "unsafe"`; file bytes unchanged; no snapshot captured |
| stale refresh drops orphans | apply kimi with models A+B, then re-apply after B leaves the catalog | B's `models["opencodex/B"]` is gone; an unrelated user `models["opencodex/x"]` written by hand survives |
| restore records actual ownership | restore a snapshot taken under an older catalog | the new record's `fragmentPaths` match the restored file, and the next classify is `stale` (not `conflict`, not a false `current`) |
| disable `absent` | disable a clean config | `ok`, `changed === false` |
| disable removes only ours | seed a foreign `opencodex/x` model entry | it survives; our recorded paths are gone |
| restore-to-absence | apply onto a missing file, restore that op | file no longer exists; `resultAbsent === true` |
| `snapshot_expired` | 11 ops, restore the oldest | refused `snapshot_expired` |
| `drift_requires_confirm` | apply, edit, restore without confirm | refused; with confirm succeeds and the edit is in the newest snapshot |
| restore reclassifies | restore a file containing our block | subsequent classify is `current`, not `conflict` |

## 7. Tests

`tests/integrations-writer.test.ts` — one test per row above, plus the four
cross-cutting checks from 030 §6 (no secret on disk, unrelated content
survives, round-trip parse per format, undo end-to-end byte equality). All use
`mkdtempSync` + `rmSync` and a fake `IntegrationIO` where the row calls for it.
