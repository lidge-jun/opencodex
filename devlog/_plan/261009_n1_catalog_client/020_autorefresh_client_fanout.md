# 020 — wp2: background catalog refresh reaches already-connected clients (#6784)

Branch `codex/n1-catalog-autorefresh-fanout` from `origin/dev`.
Amended after the wp0 audit (FAIL, five blockers: writer-level cancellation, Desktop ownership,
Desktop mode preservation, Aside owned refresh, hub gate). Every blocker is folded below.

## Current behaviour (730d898457)

- `src/codex/catalog-auto-refresh.ts` tick converges the Codex catalog
  (`createManagementConvergeCodex(config)`), records the outcome and logs; nothing else.
- `/api/sync` and fast-row settings saves call
  `syncEnabledClientIntegrations(port, config, deps)` in
  `src/server/management/config-routes.ts:203`: Grok (toggle on), Claude Desktop (on and not
  first-party; always written in `"static"` mode at :253), then
  `refreshOwnedCatalogIntegrations` for ten file clients.
- That helper is not owned-only: native toggles default on, so it can create a Grok fence and
  create/select a Desktop profile (`desktop-3p.ts:745-762`); Aside can first-apply a newly enabled
  profile (`aside-profiles.ts:278`); Cline is in its list although
  `structure/clients/integrations.md` excludes Cline from unattended refresh. Its native
  predicates do not check `localClientSyncAllowed` (`desired-state.ts:80`), which a hub needs.

## Rule for the unattended path

Refresh only what OpenCodex already wrote and still owns, preserve how it was written, never
first-enroll, and stop before any write once the scheduler generation is no longer current.

## Design

1. MODIFY `src/codex/catalog-auto-refresh.ts` — injectable hook, no new static imports.

```ts
/** Refreshes already-connected client integrations after a changed catalog; set by the server lifecycle. */
export type CatalogChangedClientFanout =
  (isCurrent: () => boolean) => Promise<ReadonlyArray<{ readonly ok: boolean }>>;
let clientFanout: CatalogChangedClientFanout | null = null;
export function setCatalogAutoRefreshClientFanout(fanout: CatalogChangedClientFanout | null): void {
  clientFanout = fanout;
}
```

   In `tick()` after `recordCatalogAutoRefreshOutcome(...)` and the existing change log:

```ts
    const fanout = clientFanout;
    if (outcome.changed && fanout) {
      const current = () => entryGeneration === generation;
      try {
        const failed = (await fanout(current)).filter(result => !result.ok).length;
        // Privacy scan: counts only, never client reasons, paths, or identifiers.
        if (current() && failed > 0) console.warn(`[catalog-auto-refresh] ${failed} client integration(s) were not refreshed; ocx sync retries them`);
      } catch {
        if (current()) console.warn("[catalog-auto-refresh] client integrations were not refreshed; ocx sync retries them");
      }
    }
```

2. MODIFY `src/server/background-lifecycle.ts` — set the hook in `startProcessLoops` before
   `startCatalogAutoRefresh()`; clear it in `stopProcessLoops` and in the start failure path.
   The hook is process-wide, like the loops; it resolves the port from the process runtime record
   at call time, so lease hand-over between in-process servers needs no re-registration.

```ts
/** Unattended fan-out for a changed background catalog; heavy modules load on demand. */
async function refreshConnectedClientsAfterCatalogChange(isCurrent: () => boolean) {
  const [{ readRuntimePort }, { loadConfig }, { localClientSyncAllowed }, { syncEnabledClientIntegrations }] =
    await Promise.all([
      import("../config/process-state"),
      import("../config"),
      import("../codex/desired-state"),
      import("./management/config-routes"),
    ]);
  const runtime = readRuntimePort(process.pid);
  const config = loadConfig();
  // Hub and sibling gate for every local client, independent of why the catalog tick ran.
  if (!runtime || !isCurrent() || !localClientSyncAllowed(config)) return [];
  return syncEnabledClientIntegrations(runtime.port, config, {}, { unattended: { isCurrent } });
}
```

3. MODIFY `src/server/management/config-routes.ts` `syncEnabledClientIntegrations` — fourth
   parameter `options: { unattended?: { isCurrent: () => boolean } } = {}`. Attended callers pass
   nothing and keep today's behaviour byte for byte. With `unattended`:
   - `stale = () => unattended !== undefined && !unattended.isCurrent()`; return the accumulated
     outcomes when `stale()` before each client.
   - **Grok**: skip unless `grokManagedBlockPresent()`. Call `syncGrokConfig` with deps whose
     `injectGrokConfig` wrapper rechecks, immediately before delegating, `!stale()`, the fresh
     `grokIntegrationEnabled(loadConfig())`, and `grokManagedBlockPresent()`; otherwise it returns
     `{ ok: true, changed: false, message: "Grok refresh skipped" }` without writing.
   - **Claude Desktop**: `const mode = desktop3pUnattendedRefreshMode(latest.claudeCode?.desktopProfile?.appliedFingerprint)`
     is evaluated inside `runPickerTransition` on the fresh `latest` read; skip when `null` or
     `stale()`. The writer receives `mode` instead of the literal `"static"` only on this path.
   - **File clients**: list minus `cline` (contract exclusion); pass
     `{ isCurrent, refreshOnly: true }` to `refreshOwnedCatalogIntegrations`.

4. MODIFY `src/claude/desktop-3p.ts` — NEW export:

```ts
/**
 * Unattended refresh gate. Returns the applied profile's own mode only when OpenCodex owns the
 * selected profile and its bytes still match our last write; anything else is null (skip).
 */
export function desktop3pUnattendedRefreshMode(appliedFingerprint: string | null | undefined): Desktop3pConfigMode | null {
  if (!appliedFingerprint) return null;
  const inspected = inspectDesktop3pConfigLibrary({ appliedFingerprint });
  if (inspected.kind !== "gateway_ours" || inspected.ownedProfileActive !== true || !inspected.selectedProfilePath) return null;
  try {
    const profile = JSON.parse(readFileSync(inspected.selectedProfilePath, "utf8")) as Record<string, unknown>;
    if (profile.modelDiscoveryEnabled !== true) return "static";
    return Array.isArray(profile.inferenceModels) ? "hybrid" : "discovery";
  } catch {
    return null;
  }
}
```

   `gateway_ours` requires the selected entry to be owned and the on-disk sha to equal
   `appliedFingerprint`, so a deleted, foreign, reselected, broken or user-edited profile is refused
   and no new profile is allocated or selected (`existing` is always the selected owned entry).

5. MODIFY `src/integrations/catalog-refresh.ts` — third parameter
   `options: { isCurrent?: () => boolean; refreshOnly?: boolean } = {}`:
   - break out of the client loop when `options.isCurrent?.() === false`;
   - pass `revalidate` to `refreshOwnedIntegration(..., { revalidate })` and to Aside, where
     `revalidate` returns `{ ok: false, reason: "superseded_store", state: "current", clientId, message: "Background refresh superseded" }`
     when `isCurrent()` is false (checked under the writer lock, before any side effect,
     `writer.ts:917`); otherwise null.
   - pass `refreshOnly` to `refreshAsideProfiles`.

6. MODIFY `src/integrations/owned-refresh.ts` — none needed: `options` already reaches
   `refreshIntegrationCoordinated`. The models load happens before the lock; the lock-held
   revalidate is the write gate.

7. MODIFY `src/integrations/aside-profiles.ts` `refreshAsideProfiles(input, options?)` with
   `options: { refreshOnly?: boolean; revalidateBeforeWrite?: ... }`: when `refreshOnly` and the
   profile is not owned, `continue` (no first apply); pass `revalidate` into the coordinated
   operation, matching the existing pattern at `aside-profiles.ts:244`.

8. NEW export in `src/grok/inject.ts`:

```ts
/** True when config.toml holds a complete OpenCodex-managed block (refresh-only callers). */
export function grokManagedBlockPresent(grokHome?: string): boolean {
  try {
    const path = join(resolveGrokHome(grokHome), "config.toml");
    if (!existsSync(path)) return false;
    const region = findManagedRegion(applyEol(readFileSync(path, "utf8"), "\n"));
    return region != null && !region.orphaned;
  } catch {
    return false;
  }
}
```

## Tests (NEW sibling files; register each in `scripts/test-layout/layout.json` explicit and
`tests/fixtures/test-layout-expected.json`)

- `tests/codex-integration/catalog-auto-refresh-client-fanout.test.ts`: hook called once when the
  converge reports `changed`; not on unchanged; rejection/failed result swallowed with a
  count-only log; stop during converge prevents the call; `isCurrent` false after stop during the
  hook.
- `tests/clients/sync-client-integrations-unattended.test.ts` (isolated homes):
  Grok skipped without a managed block, refreshed with one, and not written when the block is
  removed or generation stops during discovery; Desktop skipped with no marker, a stale marker,
  a foreign selection or a deleted profile, and an applied hybrid/discovery/static profile keeps
  its mode; `cline` never reaches the owned refresher; a stale `isCurrent` refuses under the lock;
  attended call unchanged.
- `tests/integrations/aside-profiles-refresh-only.test.ts` (or the nearest existing Aside domain):
  refreshOnly skips an unowned enabled profile and refreshes an owned one.
- Background lifecycle: hook registered on start, cleared on last release; hub without loopback
  listener and sibling return `[]`; missing runtime record returns `[]`.

Verification adds `tests/lab/core-lab-boundary.test.ts` and
`tests/usage/quota-reset-core-boundary.test.ts` to the focused set.

## Docs

- `structure/catalog.md:102` — append to the scheduler paragraph (same line).
- `structure/clients/integrations.md` — extend the Cline unattended sentence to name the
  background refresh rule (no net new lines; file at 598/600).
- `docs-site/src/content/docs/reference/configuration/server.md` catalogAutoRefresh section —
  which clients follow a background refresh and why others need `ocx sync`.

## Out of scope

Convergence `beforeCommit` generation guard for a stale tick's Codex commit (existing behaviour);
triggering on roster changes that leave Codex bytes unchanged; a Grok writer lock.

## Amendment after audit round 2 (supersedes items 3, 4, 5 and 7 where they differ)

Round 2 left two blockers: an await gap between `revalidate` and the file mutation, and a
Desktop precondition evaluated outside the Desktop writer's locks. Both are closed with a
synchronous final guard that runs under the relevant lock with no await before the write.

A. MODIFY `src/integrations/writer.ts` — `CoordinatedIntegrationOptions` gains

```ts
  /**
   * Synchronous last word, evaluated with no await between it and the transaction (after
   * `revalidate` and any lock acquisition). A non-null result refuses without writing.
   */
  guard?: (frozen: IntegrationWriteInput) => WriteOutcome | null;
```

   `coordinatedWrite` wraps its operation once:
   `const guarded = (frozen) => options?.guard?.(frozen) ?? operation(frozen);` and uses
   `guarded` on all three paths (no writer lock, absent client home, `withClientLocks`). Restore is
   unchanged. Attended callers pass no guard.

B. `src/integrations/catalog-refresh.ts` third parameter becomes
   `options: { refreshOnly?: boolean; admit?: () => boolean } = {}`. It stops the client loop when
   `admit?.() === false` and passes
   `guard: frozen => admit() ? null : supersededRefusal(frozen.clientId)` (typed `WriteOutcome`,
   `reason: "superseded_store"`, `state: "current"`) into `refreshOwnedIntegration(..., { guard })`
   and `refreshAsideProfiles(..., { refreshOnly, guard })`.

C. `src/integrations/aside-profiles.ts` `refreshAsideProfiles(input, options?: { refreshOnly?: boolean; guard?: CoordinatedIntegrationOptions["guard"] })`:
   skip an unowned profile when `refreshOnly`; pass `guard` into the coordinated operation; the
   outcome keeps `profileId` from the loop (the guard's refusal has none).

D. `config-routes.ts` builds `admit = () => unattended.isCurrent() && localClientSyncAllowed(loadConfig())`
   (fresh read; hub/sibling permission rechecked at every write) and passes it to B, the Grok
   wrapper and the Desktop writer.

E. MODIFY `src/claude/desktop-3p.ts` `writeDesktop3pConfig` — new trailing parameter
   `refreshOnly?: { appliedFingerprint: string; admit: () => boolean }`. Inside the existing
   `withClientLifecycleSync(withConfigMutationLockSync(...))` callback (synchronous), after the
   desired-state and remote-store checks, a refresh-only call:
   1. returns `{ written: false, reason: "desktop_refresh_only_skipped" }` unless `admit()`,
      `latest.config.claudeCode?.desktopProfile?.appliedFingerprint === refreshOnly.appliedFingerprint`,
      `inspectDesktop3pConfigLibrary({ appliedFingerprint }).kind === "gateway_ours"`, and the metadata's
      applied entry satisfies `isOwnedDesktopGatewayEntry`;
   2. derives the mode from the selected profile bytes read under the same lock
      (`modelDiscoveryEnabled !== true` → static; with an `inferenceModels` array → hybrid; else
      discovery) and ignores the caller's `mode`;
   3. calls `writeDesktop3pConfigWithGenerator(generate, { requiredId: appliedId })`, which refuses
      (`desktop_refresh_only_skipped`) instead of allocating or selecting when the applied gateway
      entry is not `requiredId`.
   Item 4's standalone `desktop3pUnattendedRefreshMode` helper is dropped; the gate lives inside the
   writer. `config-routes.ts` keeps a cheap pre-check (no marker → skip before model discovery) and
   omits a `desktop_refresh_only_skipped` result from the outcomes (not touched ≠ failed).

F. Grok wrapper (item 3) is unchanged: `injectGrokConfig` is synchronous, so the wrapper's
   `admit()`, fresh toggle and `grokManagedBlockPresent()` checks run with no await before the write.

Added tests: writer guard refuses with no file change on each of the three coordinated paths;
admit turning false between `revalidate` and the mutation refuses; Desktop refresh-only refuses a
standard/foreign selection, a stale marker, a deleted profile and an edited profile, preserves
static/hybrid/discovery, and never allocates a new profile; Aside refresh-only skips unowned.

## Audit round 3 notes folded (PASS)

- B attaches `guard` only when `options.admit` is supplied; attended callers never invoke it.
- Every Desktop refresh-only refusal returns the required `path` field
  (`resolveDesktop3pConfigLibraryPath()`), like the existing refusals.
- `refreshOnly` is the ninth parameter of `writeDesktop3pConfig`, after `lifecycleLockDeps`, so the
  existing test seam keeps its position.

## P re-verification and implementation-review amendments (wp2 entry)

`origin/dev` is now `c1a360993f` (#6823 landed wp1; #6734). Neither touches this unit's files
except `structure/clients/integrations.md`, in a different paragraph. The implementation was
prepared against `37e9294125` and reviewed in three rounds by an independent sol reviewer and a
sol security reviewer (both PASS on round 3). Their findings changed the design as follows:

- **Config freshness.** Unattended `admit()` also requires the fresh config to equal the snapshot
  used for projection, ignoring only `claudeCode.desktopProfile.appliedFingerprint/appliedAt`.
  An exclusion saved during discovery can no longer be undone by the background write.
- **Grok.** `injectGrokConfig` takes `refreshOnly: { admit }` (threaded through `syncGrokConfig`).
  Inside its synchronous transaction it refuses without a complete fence, on a symlinked
  `config.toml` or backup, or when not admitted. It writes no backup and publishes with
  `atomicWriteFileNoFollow`. Its `validateBeforeRename` re-reads the file and refuses on drift.
- **Desktop.** Refresh-only publication writes no backup and leaves `_meta.json` untouched, so a
  concurrent native selection is never undone. It publishes with `atomicWriteFileNoFollow`.
  `validateBeforeRename` rechecks `admit()`, the selected owned gateway entry, a regular-file
  profile, and the applied fingerprint. Symlinked library, metadata, profile or backup refuses.
- **Shutdown.** `ServerBackgroundLifecycleLease.revokeClientFanout()` is the first statement of the
  `server.stop` override in `src/server/index.ts` (one line; 888/893). A delivery binds to the owner
  captured at its start and stops when that owner is revoked or released.
- **Docs.** `structure/clients/claude-desktop.md` gains the refresh-only contract.

Residual risk accepted by both reviewers: a non-cooperating native process (Claude Desktop, Grok)
can still change bytes in the synchronous interval between `validateBeforeRename` and the rename.
This is the same trust assumption the attended writers already make.
