# 020 — WP2: ownership core (fingerprint, five-state read-back, journal)

Diff-level PRD. Depends on WP1 (`010`). **Shared types live in
`006_module_contracts.md` and are authoritative — where this document
disagrees, 006 wins.** Adds no writer and no route: this phase answers "what
is on disk and did we put it there?" and records every operation, so WP3 can
mutate safely and WP4 can report honestly.

**A-gate amendments folded in (round 1):**

- `IntegrationClientSpec.ownership: { kind: "provider-key"; path }` below is
  **retired**. Ownership is a set of fragments produced by WP1's
  `buildContribution` (006 §2), because Kimi owns a provider entry *and* one
  model entry per model. `OwnershipRecord` stores the recorded fragment paths;
  removal touches exactly those and never a prefix scan.
- `JournalEntry.snapshot` is a tagged `SnapshotRef` (`none`/`stored`/
  `expired`), not a nullable string — "the file did not exist" and "the
  snapshot was collected" are different facts (006 §3). `resultAbsent` makes
  restore-to-absence representable.
- Snapshot GC runs **after** the journal row commits, and snapshot bytes are
  written through `atomicWriteFile` (0600 + Windows ACL), closing the
  secret-handling open question.
- **Every activation scenario in §3 is rewritten to build fixtures directly**
  (write a config file, write an `OwnershipRecord`, classify). No scenario may
  call apply — it does not exist until WP3, and a phase that cannot verify
  itself is not a phase boundary (PHASE-SPLIT-01).

## Scope boundary

IN

- `src/integrations/registry.ts` — NEW (the integration-side client table:
  config path, detection, capability flags).
- `src/integrations/ownership.ts` — NEW (fingerprint + ownership record).
- `src/integrations/state.ts` — NEW (five-state classifier).
- `src/integrations/journal.ts` — NEW (operation log + snapshot store + GC).
- `tests/integrations-state.test.ts`, `tests/integrations-journal.test.ts` — NEW.

OUT

- No file mutation of client configs (WP3 owns every write). This phase's
  journal writes only under the opencodex config dir.
- No routes (WP4), no GUI (WP5/WP6).

## 1. `src/integrations/registry.ts` (NEW)

The export registry (WP1) says how to *render* a client. This one says where
it lives and what it supports — the 004 §5.0 capability matrix as code.

```ts
import type { ExportClientId } from "../clients/config-export";

/** The six file-toggle clients. Exception clients (codex/claude/grok) are NOT here. */
export type IntegrationClientId = ExportClientId;

export interface IntegrationClientSpec {
  id: IntegrationClientId;
  /** Absolute path of the client's config file, honoring its own env overrides. */
  configPath: (env: NodeJS.ProcessEnv, home?: string) => string;
  /** Directory whose existence is the cheap "is it installed?" signal. */
  detectDir: (env: NodeJS.ProcessEnv, home?: string) => string;
  /**
   * How our block is identified inside the document. Every current client is
   * `provider-key`: an object entry keyed by OPENCODE_PROVIDER_ID. The union
   * exists so a future fenced/text client cannot be bolted on by accident.
   */
  ownership: { kind: "provider-key"; path: readonly string[] };
}
```

`ownership.path` is the JSON path to the map that holds our key:

| Client | path | key |
|---|---|---|
| opencode | `["provider"]` | `opencodex` |
| pi | `["providers"]` | `opencodex` |
| hermes | `["providers"]` | `opencodex` |
| openclaw | `["models","providers"]` | `opencodex` |
| kimi | `["providers"]` | `opencodex` (plus `models` entries prefixed `opencodex/`) |
| gajae | `["providers"]` | `opencodex` |

**Amended (WP2 A-gate, round 2).** The spec above no longer carries a
`loopbackOnly` field, and the "kimi only" value it used to state was wrong.

The real question is not "can this client carry an env reference" but "does
its schema have anywhere to put the dedicated admission header". `/v1/chat/
completions` rejects bearer credentials and requires `x-opencodex-api-key`
(AUTH_MATRIX in `src/server/auth-cors.ts`), so a client with no header field
cannot authenticate against a non-loopback bind at all — we would be writing a
config that 401s. By that test the set is **pi, kimi, gajae**:

| Client | loopback-only | why |
|---|---|---|
| opencode | no | its provider block carries arbitrary headers |
| pi | yes | no header field in the provider block, and the schema is unverified against a real install |
| hermes | no | headers are expressible |
| openclaw | no | headers are expressible |
| kimi | yes | no header field; it also cannot carry an env reference (002 §Kimi) |
| gajae | yes | strict schema with no header field |

The value lives on the **export** registry (`src/clients/config-export.ts`,
`ExportClientSpec.loopbackOnly`, pinned by
`tests/client-config-export-new-clients.test.ts`), because that is where a new
client is declared and where the header shape is already known. WP2's registry
exposes it as a function rather than restating it:

```ts
/**
 * True when the client has nowhere to put the dedicated admission header a
 * non-loopback bind requires, so a generated config would simply be rejected.
 *
 * Read from the export registry rather than restated here: two lists of the
 * same fact drift, and this one decides whether we write a file that 401s.
 */
export function isLoopbackOnly(clientId: IntegrationClientId): boolean {
  return EXPORT_CLIENTS[clientId].loopbackOnly;
}
```

A second copy on `IntegrationClientSpec` is what this amendment removes: two
lists of the same security fact drift, and the half that drifts decides whether
a user's key lands on disk or a config silently 401s. `030` and `031` are
amended to match: the gate reads `isLoopbackOnly(clientId)`.

## 2. `src/integrations/ownership.ts` (NEW)

```ts
import { createHash } from "node:crypto";

/** 16 hex chars, same shape as the Claude Desktop applied fingerprint. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * What opencodex remembers about one client between operations. Persisted in
 * the opencodex config dir (never in the client's own file), because the
 * client file must stay a faithful copy of what the client expects.
 */
export interface OwnershipRecord {
  clientId: IntegrationClientId;
  /** Hash of the WHOLE file as we left it. Detects foreign edits after us. */
  fileFingerprint: string;
  /** Hash of just our block, canonically serialized. Detects catalog drift. */
  blockFingerprint: string;
  configPath: string;
  appliedAt: string;
  /** Operation that produced this record — links state to the journal. */
  opId: string;
}
```

Two hashes, because the two axes of 003 §3 are genuinely independent: the
file hash answers *did anyone touch this after us*, the block hash answers
*is our content still what we would write today*. One hash cannot do both,
which is precisely the bug the round-4 audit caught in the design doc.

## 3. `src/integrations/state.ts` (NEW)

```ts
export type IntegrationState =
  | "absent"    // no opencodex entry
  | "current"   // ours, untouched, and equal to a fresh regeneration
  | "stale"     // ours, untouched, but the catalog/port moved
  | "conflict"  // file changed after us, or our key exists with no record
  | "unsafe";   // unparseable, or the path is not a regular writable file

export interface IntegrationStatus {
  clientId: IntegrationClientId;
  state: IntegrationState;
  installed: boolean;
  configPath: string;
  /** Present only when a record exists. Never echoes user content. */
  appliedAt?: string;
  lastOpId?: string;
  /** Why `unsafe`/`conflict` — a stable enum the GUI maps to copy. */
  reason?: "unparseable" | "not-regular-file" | "foreign-edit" | "unowned-key";
  /** Snapshot files currently retained for this client. */
  snapshotCount: number;
  /**
   * True when pruning is behind, so old (possibly credential-bearing)
   * snapshots may still exist. Derived from the count, with the maintenance
   * marker as a retry hint only — a durable claim must not depend on a write
   * that can fail (006 §5).
   */
  retentionDegraded: boolean;
}
```

### Classifier (the two-axis rule from 003 §3, verbatim)

```ts
export function classifyIntegration(input: {
  spec: IntegrationClientSpec;
  fileText: string | null;          // null = file missing
  fileIsRegular: boolean;
  parsed: unknown | typeof PARSE_FAILED;
  record: OwnershipRecord | null;
  freshBlockFingerprint: string;    // what we WOULD write now
}): IntegrationState {
  if (input.fileText !== null && !input.fileIsRegular) return "unsafe";
  if (input.parsed === PARSE_FAILED) return "unsafe";
  const ourKey = readOurBlock(input.parsed, input.spec);   // undefined when absent
  if (ourKey === undefined) return "absent";               // record, if any, is stale bookkeeping
  if (!input.record) return "conflict";                    // our key with no ownership proof
  if (fingerprint(input.fileText ?? "") !== input.record.fileFingerprint) return "conflict";
  return input.record.blockFingerprint === input.freshBlockFingerprint ? "current" : "stale";
}
```

Order matters and is asserted by tests: an unreadable file can never be
reported as `absent`, and a foreign edit can never be reported as `stale`
(reporting drift as stale would let disable delete a user's edits).

**Activation scenarios (C-ACTIVATION-GROUNDING-01):**

| Branch | How C triggers it | Observable proof |
|---|---|---|
| `unsafe` / not-regular | point `configPath` at a directory in a temp home | `state === "unsafe"`, `reason === "not-regular-file"` |
| `unsafe` / unparseable | write `{{{` to the config | `reason === "unparseable"` |
| `absent` | fresh temp home, valid empty config | `state === "absent"` |
| `conflict` / unowned-key | write a provider block by hand, no record | `reason === "unowned-key"` |
| `conflict` / foreign-edit | write a config containing our fragments, write a record whose `fileFingerprint` is of that text, then append a comment to the file | `reason === "foreign-edit"` |
| `stale` | write config + a record whose `fileFingerprint` matches the file but whose `blockFingerprint` differs from the fresh one | `state === "stale"` |
| `current` | write config + a record whose both fingerprints match | `state === "current"` |

Every fixture is built by writing bytes and a record **directly** — WP2 never
calls the writer, which does not exist until WP3 (006 §7).

## 4. `src/integrations/journal.ts` (NEW)

Layout, all under the opencodex config dir (so `recordOwnedConfigPath`
accepts it and uninstall can clean it up):

```
<ocx config dir>/integrations/
  records.json                  # OwnershipRecord per client
  journal.jsonl                 # append-only operation log
  snapshots/<clientId>/<opId>   # pre-write copies of the client file
```

```ts
export type OperationKind = "apply" | "disable" | "refresh" | "restore";

/** Tagged so "the file did not exist" and "the snapshot was collected" stay
 *  distinguishable — `null` conflated them (006 §3). */
export type SnapshotRef =
  | { kind: "none" }
  | { kind: "stored"; relPath: string }
  | { kind: "expired" };

export interface JournalEntry {
  opId: string;                 // crypto.randomUUID()
  clientId: IntegrationClientId;
  kind: OperationKind;
  at: string;                   // ISO
  configPath: string;
  /** The file as it was BEFORE this operation. Never content, only a tag+path. */
  snapshot: SnapshotRef;
  /** Fingerprint of the file AFTER this operation — undo binds to it. */
  resultFingerprint: string;
  /** True when the operation left no file; restore then means "delete". */
  resultAbsent: boolean;
  /** Ownership as it stood before this operation, so restore puts back the
   *  provenance that matched the bytes instead of inferring it (006 §3). */
  priorRecord: OwnershipRecord | null;
}

export function appendOperation(entry: JournalEntry): void;
export function listOperations(clientId?: IntegrationClientId, limit?: number): JournalEntry[];
export function findOperation(opId: string): JournalEntry | null;
/** Resolves the tag against what is on disk NOW: a stored ref whose file is
 *  gone reads as expired. */
export function readSnapshot(entry: JournalEntry):
  | { kind: "none" }
  | { kind: "stored"; text: string; path: string }
  | { kind: "expired" };
export function captureSnapshot(
  clientId: IntegrationClientId, opId: string, text: string | null,
): SnapshotRef;
/** Structured, so a prune failure is marked and retried rather than swallowed
 *  (006 §5) — snapshots can hold the user's own credentials. */
export function pruneSnapshots(clientId: IntegrationClientId): { ok: true } | { ok: false; error: string };
```

### Retention (10 per client) and GC

`captureSnapshot` writes `snapshots/<clientId>/<opId>` then prunes that
directory to the 10 newest by journal order. A pruned entry keeps its journal
row — `readSnapshot` returns `null` and the GUI renders `백업 만료됨`
(004 §6.1). The row is history; only the action expires.

**Activation scenario:** create 11 operations for one client; assert the
oldest snapshot file is gone, its journal row still parses, and
`readSnapshot(oldestOpId) === null`.

### Undo binding

`listOperations` returns newest-first. Undo eligibility is computed by WP3,
not stored: an entry is undoable when it is the newest for its client AND the
file's current fingerprint still equals `resultFingerprint`. Storing a boolean
would go stale the moment anything else wrote the file.

**Activation scenario:** append a journal row whose `resultFingerprint` is of
a known text, write that text to the config, and assert undo eligibility is
`true`; then append one byte to the file and assert it flips to `false` while
the snapshot stays `stored`, so the row degrades to a restore offer.

## 5. Journal durability

`journal.jsonl` is append-only via `appendFileSync` with `0600`; a torn final
line is tolerated by skipping unparseable lines on read (a crash mid-append
must not brick the surface). `records.json` is written with `atomicWriteFile`
because it is read-modify-write. Both live under the opencodex config dir, so
they are covered by existing ownership/uninstall behavior.

**Activation scenario:** append a truncated line manually, then
`listOperations` returns the valid rows and drops the torn one without throwing.

## 6. Tests

`tests/integrations-state.test.ts`

- One test per row of the activation table in §3 (7 tests), each on a
  `mkdtempSync` home with `rmSync` cleanup.
- `classify never reports absent for an unreadable file` — ordering guard.
- `classify never reports stale after a foreign edit` — the audit's blocker,
  pinned as a regression test.

`tests/integrations-journal.test.ts`

- append/list round-trip preserves order (newest first).
- retention prunes to 10 and keeps rows.
- `readSnapshot` returns null for a pruned op.
- torn final line is skipped.
- snapshot capture of a missing file records `snapshot: null` (apply onto a
  fresh install has nothing to back up, and that is not an error).

## 7. Accept criteria

1. `bun run typecheck` clean.
2. `bun test tests/integrations-state.test.ts tests/integrations-journal.test.ts` green.
3. Every branch in the §3 activation table has a test that triggers it.
4. Nothing in this phase writes to a client config file (grep the diff for
   `atomicWriteFile` outside the journal/records paths — must be none).
5. `bun run privacy:scan` clean: the journal stores paths and hashes, never
   file content beyond the snapshot files themselves, and never a credential.

## OPEN QUESTIONS

- Snapshot files inherit the client config's own secrets (a user's key may sit
  in the same file we back up). They are written `0600` under the opencodex
  config dir; whether they additionally need Windows ACL hardening via the
  `atomicWriteFile` `harden` path is a WP3 decision when the writer lands.
- Whether `records.json` should be per-client files instead of one map is
  deferred; one file is simpler and the write is atomic, but concurrent
  multi-client applies would serialize on it.
