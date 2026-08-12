# 030 — WP3: writer path (apply / disable / restore)

Diff-level PRD. Depends on WP1 (`010`) and WP2 (`020`). **Shared types live in
`006_module_contracts.md` and are authoritative — where this document
disagrees, 006 wins.** This is the phase that earns the product's promise:
every mutation is journaled, reversible, and refuses rather than guesses. It
adds no route (WP4) and no UI (WP5).

**A-gate amendments folded in (round 1):**

- The `WriteOutcome` sketch below is **superseded by 006 §4**: the failure
  field is `reason` (not `refused`), literals are snake_case
  (`drift_requires_confirm`, `non_loopback`, …), and `snapshotPath` rides on
  the refusal so 040 can forward it and 060 can offer manual recovery.
- Function signatures are **006 §5**: `applyIntegration(input:
  IntegrationWriteInput)` etc. The `ctx: {...}` placeholders below are not
  signatures. `ManagementContext` is never passed in — it carries neither
  `models` nor `port`; the route builds the input.
- Merge/remove operate on **`ManagedContribution` fragments** (006 §2), so
  Kimi's model entries are removed along with its provider entry, and only
  recorded paths are ever deleted.
- Restore handles `SnapshotRef` tags (006 §3): `none` means restore-to-absence
  (delete the file we created, fingerprint-guarded), `expired` refuses.
- All I/O goes through the injected `IntegrationIO` seam (006 §5), which is
  what makes compare-before-commit and `write_failed` testable without
  monkey-patching `node:fs`.
- The config write, the ownership record, and the journal row must be
  **compensating**: if the record or journal write fails after the config
  write succeeded, restore the pre-write snapshot and report `write_failed`.
  A half-applied state with no journal row would be unrecoverable by design.

## Scope boundary

IN

- `src/integrations/writer.ts` — NEW (apply/disable/restore + preflight).
- `src/integrations/merge.ts` — NEW (additive merge and removal per format).
- `tests/integrations-writer.test.ts` — NEW.

OUT

- No routes, no GUI. No changes to the Grok or Claude Desktop writers — they
  keep their own semantics (004 §5.0); this module never touches their paths.
- No vendor-CLI shelling (003 §5 Option B). File writing only in this phase;
  the CLI-delegation option stays an OPEN QUESTION below.

## 1. Result contract

```ts
export type WriteOutcome =
  | { ok: true; changed: boolean; state: IntegrationState; opId?: string; message: string }
  | { ok: false; reason: RefusalReason; state: IntegrationState; message: string; snapshotPath?: string };

export type RefusalReason =
  | "not_installed"        // detectDir missing
  | "conflict"             // foreign edit or unowned key — never auto-delete
  | "unsafe"               // unparseable / not a regular file
  | "non_loopback"         // loopback-only client on a remote bind (pi/kimi/gajae)
  | "drift_requires_confirm"  // restore would replace post-snapshot edits
  | "snapshot_expired"     // restore target was GC'd
  | "write_failed";        // the atomic write itself threw
```

A refusal is a *result*, not an exception — the Grok precedent
(`skippedReason` with `ok: true`) proved that a policy skip must be actionable
in the UI rather than a 500. The difference here: a refusal sets `ok: false`
because the user asked for a mutation that did not happen, and the GUI must
show why. `snapshotPath` is included on failure paths so a user can finish by
hand — 004 §6.2 rule 3, "a rollback feature that dead-ends silently is worse
than none."

## 2. `src/integrations/merge.ts` (NEW)

Additive merge and surgical removal, per format, preserving unknown fields.

```ts
// `parseConfig` is NOT declared here — it belongs to WP2's config-io.ts, which
// the reader also uses (006 §8). merge.ts imports it.

/** Insert/replace ONLY our recorded fragments. Everything else is preserved. */
export function mergeContribution(doc: unknown, contribution: ManagedContribution): unknown;

/** Remove ONLY our key. Returns { doc, removed } — removed:false means it was not there. */
export function removeOurBlock(doc: unknown, spec: IntegrationClientSpec): { doc: unknown; removed: boolean };
```

Format realities this must respect (from 002 and the WP1 serializers):

- **JSON/YAML/JSON5**: parse → mutate the one key → re-serialize. Comments and
  key order are lost for YAML/JSON5. That is the same bar Kimi's own CLI sets
  for TOML (002 §Kimi: `smol-toml` rewrites the whole document, losing
  comments), so it is defensible — but it must be **stated in the API
  response** so the GUI can warn before the first apply.
- **TOML (kimi)**: we do NOT round-trip. `Bun.TOML.parse` reads it, and the
  emitted document is rendered by `renderToml` (WP1). Same comment-loss
  caveat, same disclosure.
- **Empty/missing file**: merge onto `{}` and create the parent directory
  (`mkdirSync(dirname(path), { recursive: true, mode: 0o700 })`) — because
  `atomicWriteFile` does not create parents (005 §3).

**Activation scenarios:** merge onto a config carrying an unrelated provider →
that provider survives byte-for-byte in the re-serialized output (assert by
parsing both sides). Remove when our key is absent → `removed: false` and the
file is not written at all (assert mtime unchanged).

## 3. `applyIntegration`

```ts
export function applyIntegration(clientId: IntegrationClientId, ctx: {
  models: readonly ExportModel[]; config: OcxConfig; port: number; env?: NodeJS.ProcessEnv;
}): WriteOutcome;
```

Sequence:

1. **Detect.** `detectDir` missing → refuse `not_installed` (no write, no
   journal row). Installing a client for the user is not our business.
2. **Loopback gate.** `isLoopbackOnly(clientId) && !isLoopbackHostname(config.hostname)`
   → refuse `non_loopback`. This is the Grok reasoning applied to every client
   whose schema has nowhere to put the dedicated admission header — **pi, kimi,
   gajae** (020 amendment). With nowhere to carry `x-opencodex-api-key`, the
   config we would generate simply fails authentication, so we decline instead
   of writing a file that 401s. For Kimi there is a second reason on top: it
   cannot carry an env reference either, so the only way to make it work
   remotely is to serialize the user's real key — which AGENTS.md calls a
   release blocker.
3. **Classify** (WP2). `unsafe` → refuse `unsafe`. `conflict` → refuse
   `conflict` (the switch is locked in the UI; the API must agree).
   `current` → `{ ok: true, changed: false }` — apply is idempotent.
4. **Build + merge.** `buildClientConfig` (WP1) → `mergeOurBlock` → serialize.
5. **Snapshot first.** `captureSnapshot(clientId, opId, currentText)` before
   any write. A missing file records `snapshot: null`.
6. **Compare-before-commit.** Re-read the file and verify its fingerprint
   still equals what step 3 classified. Mismatch → refuse `conflict` and
   delete the just-captured snapshot (nothing happened, so leave no debris).
   This is the lost-update guard 003 §3 caveat 1 demands; the residual race
   inside the re-read/rename window is accepted and documented, not claimed away.
7. **Write** via `atomicWriteFile`. Throw → refuse `write_failed` with
   `snapshotPath` set.
8. **Record + journal.** Write the `OwnershipRecord` (both fingerprints) and
   append the journal entry with `resultFingerprint`.

## 4. `disableIntegration`

```ts
export function disableIntegration(input: IntegrationWriteInput): WriteOutcome;
```

Same preflight, then `removeOurBlock`. Hard rules:

- Allowed **only** from `current` or `stale` — i.e. only while the file
  fingerprint still matches our record (004 §6.2, 003 §3). `conflict` and
  `unsafe` refuse.
- `absent` → `{ ok: true, changed: false }`; disabling nothing is a no-op, not
  an error.
- Removal is surgical: the rest of the document is preserved. After removal
  the ownership record for that client is deleted (a record without a block is
  bookkeeping debris that would later read as `conflict`).

`해제` IS this operation — there is no separate "remove block" action
(004 §6, four-verb vocabulary).

## 5. `restoreIntegration` — the preflight that makes rollback honest

```ts
export function restoreIntegration(opId: string, opts: { confirmDrift?: boolean }): WriteOutcome;
```

1. **Resolve snapshot.** Missing/GC'd → refuse `snapshot_expired`.
2. **Target sanity.** Not a regular writable file → refuse `unsafe` with the
   snapshot path named, so the user can copy it back by hand.
3. **Snapshot the current file first.** Restore is itself journaled as an
   operation with its own snapshot, so a restore can be undone. Rollback that
   cannot be rolled back is a trap.
4. **Drift check.** If the current file's fingerprint differs from the
   `resultFingerprint` of the operation being undone, someone edited it after
   us. Without `confirmDrift` → refuse `drift_requires_confirm`. With it →
   proceed, having already preserved those edits in step 3's snapshot.
5. **Write** the snapshot text via `atomicWriteFile`, then journal
   (`kind: "restore"`) and recompute the ownership record from the restored
   content (the restored file may or may not contain our block — classify and
   store accordingly, or delete the record when it does not).

**Activation scenarios (every branch):**

| Branch | Trigger | Observable proof |
|---|---|---|
| `not_installed` | apply with no `detectDir` | `reason === "not_installed"`, no journal row |
| `non_loopback` | apply kimi with `hostname: "0.0.0.0"` | `reason === "non_loopback"`, file unchanged |
| `conflict` (apply) | apply, append a comment, apply again | refused; file still has the user's comment |
| idempotent apply | apply twice unchanged | second returns `changed: false`, mtime unchanged |
| compare-before-commit | stub the re-read to return different bytes | refused `conflict`; snapshot dir has no orphan |
| `write_failed` | inject a throwing writer (desktop-3p test precedent) | `reason === "write_failed"`, `snapshotPath` set |
| disable from `conflict` | apply, hand-edit, disable | refused; our block still present (no auto-delete) |
| disable `absent` | disable on a clean config | `ok: true, changed: false` |
| `snapshot_expired` | 11 ops then restore the oldest | `reason === "snapshot_expired"` |
| `drift_requires_confirm` | apply, hand-edit, restore without confirm | refused; then with `confirmDrift` it succeeds AND the hand edit is recoverable from the newest snapshot |
| restore onto a directory | point config path at a dir | `reason === "unsafe"`, message names the snapshot path |

## 6. Tests — `tests/integrations-writer.test.ts`

One `mkdtempSync` home per test with `rmSync` cleanup (the
`tests/grok-config-inject.test.ts` shape). Beyond the activation table:

- **No secret ever reaches disk**: apply every client with a config carrying a
  real-looking admission key; assert the written file contains neither the key
  nor `sk-`, and that kimi's file contains the loopback placeholder.
- **Unrelated content survives**: seed each client's config with a foreign
  provider + a top-level unknown field; after apply and after disable, both
  are still present and parse identically.
- **Round-trip parse**: every written file parses with its format's parser
  (`Bun.TOML.parse` for kimi — the same proof `grok-config-inject.test.ts` uses).
- **Undo path end-to-end**: apply → restore(latest op) → the file equals its
  pre-apply bytes exactly.

## 7. Accept criteria

1. `bun run typecheck` clean.
2. `bun test tests/integrations-writer.test.ts` green, plus WP1/WP2 suites
   still green.
3. Every row of the §5 activation table has a test that triggers it.
4. No test leaves a temp directory behind (teardown receipts).
5. Grep proof: `src/integrations/writer.ts` writes only through
   `atomicWriteFile`; no `writeFileSync` on a client path.
6. `bun run privacy:scan` clean.

## OPEN QUESTIONS

- **Vendor-CLI delegation** (003 §5 Option B/C) — `openclaw config set/unset`,
  `kimi provider add/remove`, `gjc setup provider` — is deliberately deferred.
  File writing is uniform and testable without a client binary on PATH; the
  CLI path buys cascade cleanup and comment preservation but adds a version
  dependency we cannot verify in CI. Revisit at WP7 with evidence.
- **Comment loss disclosure**: the API response should carry a
  `formatCaveat: "comments-not-preserved"` flag for YAML/JSON5/TOML clients so
  the GUI can warn before the first apply. Exact field name is WP4's to fix.
- **Concurrency across processes**: single-flight in WP4 covers one server
  process; a user editing the file in an editor at the same moment is caught
  by compare-before-commit, but two opencodex instances writing the same
  client config simultaneously is out of scope and should be documented.
