# 020 — Phase 2: key-level restore everywhere, compare-and-swap publication (wp3)

Re-verify every anchor against the tree before editing; wp2 adds only the seam calls.

## 1. Byte compare-and-swap for config.toml (MODIFY)

`src/codex/config-write-lock.ts`

- NEW export, beside `ConfigWriteDestinationChanged`:

```ts
/** config.toml no longer holds the bytes a writer decided from; nothing was written. */
export class ConfigWriteContentChanged extends Error {
  readonly retryable = true;
  constructor() {
    super("Codex config.toml changed while OpenCodex was writing it; nothing was overwritten. Retry the command.");
  }
}
```

- NEW module state + export: `const publishedConfigDigests = new WeakMap<LockHandle, string | null>();` and
  `export function publishedConfigDigest(held: LockHandle): string | null | undefined { return publishedConfigDigests.get(held); }`
  (`undefined` = this section never published config.toml).
- `publishConfigWrite` `afterRename`: after `destinations.set(held, after);` add
  `publishedConfigDigests.set(held, fileDigest(canonical));` (sha256 hex of the bytes, `null` on ENOENT). This re-read is only the fallback for writers whose payload this process never sees (`runConfigWriteChild`, `createEmptyCodexConfigInBoundary`).
- NEW export `recordPublishedConfigDigest(held, digest)`: `publishCodexConfigIfUnchanged` calls it from its own `afterRename` with the digest of `next` (audit r2 finding 2: a re-read could capture a foreign in-place write landing right after the rename).
- `withConfigWriteRecovery` catch: first statement inside the outer `try`, before `validateRecovery()`:
  `if (error instanceof ConfigWriteContentChanged && recovery.identity === identity) throw error;`
  — refused before this scope published anything, so there is nothing to recover and no preimage evidence file is written.

`src/codex/inject/config-write-section.ts`

- `CodexConfigPublishSite` gains `"inject" | "compensate"`.
- NEW:

```ts
/**
 * Publish config.toml only while it still holds `expected`, the bytes the caller decided from.
 * The lock's inode witness refuses an atomic rename (how Codex writes); this comparison also
 * refuses an in-place writer that keeps the inode. A refusal writes nothing.
 */
export function publishCodexConfigIfUnchanged(held: LockHandle, site: CodexConfigPublishSite, expected: string, next: string): void {
  publishCodexArtifact(CODEX_CONFIG_PATH, held, (path, hooks) => atomicWriteFile(path, next, undefined, {
    ...hooks,
    validateBeforeRename: target => {
      beforeCodexConfigPublishForTests?.(site);
      if (readFileOrNull(target) !== expected) throw new ConfigWriteContentChanged();
      hooks.validateBeforeRename?.(target);
    },
    afterRename: target => {
      hooks.afterRename?.(target);
      recordPublishedConfigDigest(held, sha256Hex(next));
    },
  }));
}
```

  The seam moves here from the wp2 call sites (remove those three calls).

Call sites (MODIFY):

| Site | Before | After |
|---|---|---|
| `src/codex/journal.ts:434-439` | `publishCodexArtifact(CODEX_CONFIG_PATH, held, … atomicWriteFile(path, fieldRestore ?? comparison.originalConfig …))` unconditionally | compute `restoredConfig`; if it equals `currentConfig` mark restored without writing, else `publishCodexConfigIfUnchanged(held, "journal", currentConfig, restoredConfig)` |
| `src/codex/inject/remove.ts:263` | `publishCodexArtifact(…atomicWriteFile(path, applyEol(finalContent, eol)…))` | `publishCodexConfigIfUnchanged(held, "remove", rawContent, applyEol(finalContent, eol))` |
| `src/codex/inject/remove.ts:65` | same shape | `publishCodexConfigIfUnchanged(held, "retain", rawContent, applyEol(next, eol))` |
| `src/codex/inject.ts:494` | `publishCodexArtifact(CODEX_CONFIG_PATH, heldConfigWriteLock, … plan.content …)` | `publishCodexConfigIfUnchanged(heldConfigWriteLock!, "inject", nativeInput, plan.content)` (same line count; `nativeInput` is the on-disk bytes after the v1 reconcile, `""` after creating a missing file) |

`journal.ts` replacement for lines 434-439:

```ts
  if ((configUnchanged || fieldRestore !== null) && !configRestored && currentConfig !== null) {
    const restoredConfig = fieldRestore ?? comparison.originalConfig;
    if (restoredConfig !== currentConfig) {
      options.beforeWrite?.();
      publishCodexConfigIfUnchanged(held, "journal", currentConfig, restoredConfig);
      configRewritten = true;
    }
    configRestored = true;
  }
```

`src/codex/inject/restore.ts` `restoreCodexConfigInlineImpl` catch: return `retryable: error instanceof ConfigWriteContentChanged` with the failed result.

## 2. Compensation reverts only its own publication (MODIFY)

`src/codex/inject-coordination.ts` `restoreCodexPreImages`, config surface, before `publishCodexArtifact`:

```ts
      if (name === "config") {
        const current = readOrNull(path);
        if (current === bytes) continue;
        const ours = publishedConfigDigest(held);
        // Nothing this section published: the bytes there are someone else's and stay.
        if (ours === undefined) continue;
        // Someone wrote after our publication; reverting would destroy their write.
        if (digestOrNull(current) !== ours) { unrestored.push(name); continue; }
        if (bytes !== null) { publishCodexConfigIfUnchanged(held, "compensate", current ?? "", bytes); continue; }
      }
```

For every surface, first: \`if (readOrNull(path) === bytes) continue;\` — a surface already holding its preimage needs no publication, and asserting its destination after a foreign atomic rename of config.toml is what made the wp2 rename races throw \`CodexPartialWriteError\` over untouched profile/journal files. The profile \`profilePublish\` rule and the journal ordering stay.

## 3. Recovery uses the key-level restore (MODIFY)

`src/codex/journal.ts` `reconcileJournal`: both `restoreJournalState({ heldConfigWriteLock: handle })` calls (`:581`, `:614`) pass `preserveConfigEdits: true`. Exact-original and hash-matched files still take the lossless replay; any other file takes `restoreJournalConfigFields`, the three-way restore disconnect already uses; a refused three-way keeps today's "incomplete" warning and both files.

## 4. Journal remembers every routing URL it injected (MODIFY, optional field, version stays 1)

Only the two root URL keys. `model_catalog_json` is excluded on purpose: `chooseCatalogPathForInjection` (`src/codex/inject/config-toml.ts:763-777`) keeps a user-owned catalog path and records it as `injectedCatalogPath`, so a catalog history would mark the user's path as ours, strip it on restore, and freeze the snapshot (#477). The URL values are recorded only when OpenCodex wrote them (`src/codex/inject.ts:509-517` journals null for kept user values).

`src/codex/journal-config-restore.ts` — NEW exports (no import of `journal.ts`, which imports this file):

```ts
export type InjectedRootKey = "openai_base_url" | "experimental_realtime_ws_base_url";
export type InjectedRootHistory = Partial<Record<InjectedRootKey, string[]>>;
const INJECTED_ROOT_KEYS: readonly InjectedRootKey[] = ["openai_base_url", "experimental_realtime_ws_base_url"];
export const INJECTED_ROOT_HISTORY_LIMIT = 8;
/** Only string arrays for the known keys count; the journal is read from disk. */
export function parseInjectedRootHistory(recorded: unknown): InjectedRootHistory { … }
/** Append the values this injection wrote, newest last, deduplicated, at most the limit per key. */
export function appendInjectedRootHistory(recorded: unknown, written: Partial<Record<InjectedRootKey, string | null | undefined>>): InjectedRootHistory { … }
```

`Ownership` gains `injectedRootHistory?: unknown`. In `restoreJournalConfigFields`, per key: a PRESENT value that is one of our recorded values counts as injected (`expected` for that key). The pre-injection snapshot is never reinterpreted (audit r2 finding 1: a snapshot value that coincides with a recorded URL may be the user's). Everything else is unchanged.

`src/codex/journal.ts`

- `Journal.injectedRootHistory?: InjectedRootHistory` with a doc comment (stale app rewrites).
- `writeJournal`: the replacement object carries `injectedRootHistory: appendInjectedRootHistory(previous?.injectedRootHistory, { openai_base_url: previous?.injectedOpenaiBaseUrl, experimental_realtime_ws_base_url: previous?.injectedRealtimeWsBaseUrl })` when `previous` exists.
- `markJournalInjectedState`: after the ownership assignments, `journal.injectedRootHistory = appendInjectedRootHistory(journal.injectedRootHistory, { openai_base_url: ownership.injectedOpenaiBaseUrl, experimental_realtime_ws_base_url: ownership.injectedRealtimeWsBaseUrl });`
- NEW export `journaledInjectedRootValues(key, { readOnly })`: latest recorded value first, then history newest first, deduplicated.

Consumers:

- `src/codex/inject.ts:376-382` `journalBaselineIsNative` (net −1 line):

```ts
    // Any root value an injection under this journal wrote is ours, even after an app rewrite.
    const ownsRoot = (key: InjectedRootKey) => {
      const value = rootTomlString(nativeInput, key);
      return value !== null && journaledInjectedRootValues(key, { readOnly: true }).includes(value);
    };
    const looksInjectedByValue = ownsRoot("openai_base_url") || ownsRoot(REALTIME_WS_BASE_URL_KEY);
```

- `src/codex/inject/plan.ts:196-200`: replace the single `stripJournaledOpenaiBaseUrl` call with one call per recorded value of each URL key.
- `src/codex/inject/remove.ts` `stripOpencodexConfigResult`: `journaledBaseUrl`/`journaledRealtimeWsBaseUrl` become `readonly string[]`; `hadInjectedBaseUrl` and the strip use every value; `removeCodexConfig` passes `journaledInjectedRootValues(...)` and computes `had` the same way.

## 5. Drift covers the catalog key and reports once (MODIFY)

`src/codex/config-drift-heal.ts`

- `readJournal` result gains `injectedCatalogPath?: string | null`; a recorded path with no root `model_catalog_json` pushes `"model_catalog_json"`; the early return also considers it.
- NEW export:

```ts
/** One clear warning for the first heal in a process; later heals log one quiet line. */
export function codexConfigHealNotice(missingKeys: readonly string[], firstReport: boolean): { level: "warn" | "info"; message: string } {
  if (!firstReport) return { level: "info", message: "[catalog-auto-refresh] injected Codex config keys were rewritten externally; re-injected" };
  return {
    level: "warn",
    message: "[catalog-auto-refresh] Codex rewrote config.toml without OpenCodex's " + missingKeys.join(", ")
      + "; re-injected only those keys and other settings were kept. If this repeats, the Codex app is rewriting"
      + " config.toml from its own copy; run 'ocx sync' after the app settles.",
  };
}
```

`src/codex/catalog-auto-refresh.ts`: `healCodexConfigDrift` returns `{ status, missingKeys }` and passes `injectedCatalogPath: journaledInjectedCatalogPath()` into both `codexConfigDrift` reads; the tick logs `codexConfigHealNotice(missingKeys, !reported)` on `healed` and latches `reported`.

## 6. Docs (MODIFY, line count unchanged in codex-home.md)

- `structure/codex-home.md` journal paragraph (`:75`) and recovery paragraph (`:90-99`): restore never reverts changes made after injection; whole-file replay only on byte-identical first injected bytes; every other journal path is key-level (three-way for recovery and disconnect, owned-field strip for stop); every restore publication of config.toml is compare-and-swap and compensation reverts only its own publication; the journal records the root values it wrote (`injectedRootHistory`); `tests/codex-integration/codex-restore-later-edits.test.ts` enforces it.
- `structure/overview.md`: NEW `INV-RESTORE-02` after `INV-RESTORE-01`, `Enforced by `tests/codex-integration/codex-restore-later-edits.test.ts``.
- `structure/config.md:267-268`: drift detection covers `model_catalog_json`; the first heal per process warns once; recorded earlier values are OpenCodex's own.

## Audit r2 dispositions

1. MAJOR history applied to the snapshot — folded (present value only).
2. MAJOR digest from a re-read — folded (payload digest via `recordPublishedConfigDigest`; re-read stays only for child writers).
3. MINOR refusal message claimed kept evidence — folded (message no longer claims it).
4. MINOR silent journal removal on a byte-unchanged three-way — accepted: it is the existing quiet already-original path; the stale-journal test asserts the journal is gone and neither warning is printed.
5. MINOR client branch gains key-level restore — accepted deliberately: that branch already had whole-file replay authority on a hash match; key-level is strictly narrower. Covered by the client-recovery test.

## Verification for this phase

`bun test tests/codex-integration/codex-restore-later-edits.test.ts tests/codex-integration/codex-app-rewrite-routing.test.ts` all pass; then the neighbours: `codex-journal-recovery`, `codex-journal`, `codex-restore-app-rewrite`, `codex-config-write-lock`, `codex-provider-table-retention`, `codex-inject-integration`, `codex-inject-v1-reconcile`, `codex-config-preservation`, `codex-sync-user-edits`, `client-disconnect-recovery`, `codex-catalog-heal-integration`, `codex-journal-provider-reserialization`, `codex-inject-retained-table`; `bun run typecheck`.

## As built (wp3)

- §2 became a shared `decide` step in `restoreCodexPreImages` (skip / foreign / restore), run once before the held-lock destination check as well. When every surface already holds its preimage, the call returns complete without touching the lock. When the section can no longer publish (a foreign rename of config.toml), it names only the surfaces that still differ, plus the journal as recovery authority. A caller without a held lock keeps the old unconditional config restore.
- In the strip-path rename race, the journal step has already removed the generated profile. The guard that refuses every publication after a destination change is unchanged, so restore reports `CodexPartialWriteError` naming `profile, journal` and keeps Codex's write and the journal; a retry completes. The test asserts exactly that.
- `restoreCodexConfigInlineImpl` marks a `ConfigWriteContentChanged` failure retryable.
- Drift also flags a root URL that holds an earlier injection's value (`injectedRootValues`), so a running proxy heals the app's stale write-back without waiting for the next sync.
- `tests/codex-integration/codex-config-write-lock.test.ts` "retargeting during compensation…": one setup line records that the section published the `post` bytes. Under the new rule an unpublished foreign config is left alone, and this line keeps the test exercising the refused config publication. The assertion is unchanged.
