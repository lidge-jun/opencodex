# WP2 — removing a Claude Desktop profile without breaking Claude Desktop

> **Rev 3** after audit rounds 1 and 2. Rev 2 introduced the compound snapshot,
> proved ownership, and refused the no-survivor case. Rev 3 adds the opencodex
> config member, refuses legacy profiles instead of guessing, separates IO
> failures from ownership refusals, and pulls the schema work into scope.

## The problem, precisely

There is no removal code for Desktop anywhere in the repo (`001` §Claude
Desktop). We are writing the first one, into another application's state
directory, with three specific hazards:

1. **A dangling `appliedId`.** Desktop resolves `appliedId` then opens exactly
   `<appliedId>.json`. Delete our file while `appliedId` still names it and
   Desktop reads a path that does not exist.
2. **No memory of the previous selection.** `writeDesktop3pConfig` sets
   `appliedId` unconditionally (`desktop-3p.ts:358`) and never records what was
   there. The information to "put it back" was never captured.
3. **Auto-apply resurrection.** `desktopAutoApply` defaults ON while a stored
   `desktopProfile` exists, so a later provider change rewrites the file we just
   removed.

## IN

1. `src/claude/desktop-3p.ts` — MODIFY: add `removeDesktop3pConfig`.
2. `src/integrations/native/clients.ts` — MODIFY: add `CLAUDE_DESKTOP_SPEC`.
3. `tests/desktop-3p-removal.test.ts` — NEW.

OUT: `generateDesktop3pConfig`, the registry builder, `desktop-profile.ts` —
all pure, none involved in removal.

## What we snapshot

**All of it**: `_meta.json`, the profile, and the `.bak`.

Rev 1 snapshotted `_meta.json` alone, reasoning that the profile is regenerable
from config. The audit killed that (finding #1) and it was right: regenerable
is not the same as *restorable*. Restore puts back a `_meta.json` whose
`appliedId` names a profile that restore did not recreate — a dangling pointer,
which is exactly the corruption this phase exists to prevent. The Rollback
Centre would have manufactured the failure mode.

Member order is the restore order, and it is the inverse of the removal order:

| # | key | path | Why this position |
|---|---|---|---|
| 1 | `profile` | `<library>/<id>.json` | Must exist before anything references it |
| 2 | `bak` | `<library>/<id>.json.bak` | Inert; restored with its profile |
| 3 | `meta` | `<library>/_meta.json` | Written LAST, so a reference only appears once its target is back |

Removal writes metadata first and deletes second; restore does the reverse. Both
directions keep the same invariant: **at no instant does `_meta.json` name a
file that is not there.**

## Proving the profile is ours

Rev 1 identified our rows by `name === "opencodex"` and deleted every match.
That is the display name in another app's registry — a user can create a profile
with that name, and we would delete it (audit #7).

Two independent proofs are now required before removal touches a row:

1. **A persisted id.** Apply records the id it wrote into
   `config.claudeCode.desktopProfile.appliedProfileId`. Removal only considers
   that id.
2. **A provenance marker in the payload.** The profile JSON must parse and carry
   our gateway shape — `inferenceProvider: "gateway"` plus an
   `inferenceGatewayBaseUrl` pointing at loopback. This mirrors how Grok proves
   fence ownership conjunctively (`src/grok/inject.ts:154`) rather than trusting
   a name.

Rows named `opencodex` that are NOT the persisted id are left alone and reported
as a conflict for the user to resolve. We do not adopt what we cannot prove we
wrote.

### Legacy profiles are refused, not guessed

A profile applied before `appliedProfileId` existed has no persisted id. Rev 2
fell back to the name plus the payload marker and called that two proofs; the
audit was right that it is not (r2 #5). Both are user-constructible: anyone can
name a profile `opencodex`, and `inferenceProvider: "gateway"` with a loopback
URL is what any local-gateway profile looks like. Neither proves we wrote it.

Refusing every legacy install outright would be its own trap — the user cannot
disable until they re-apply, which is a strange thing to demand before allowing
an un-apply. So legacy removal returns `legacy_profile_unverified`, a refusal
that names the situation and offers the one action that resolves it:

> 이 Claude Desktop 프로필은 소유권 기록이 도입되기 전에 적용돼, 이 설치가 만든
> 것인지 확인할 수 없습니다. 한 번 다시 적용하면 기록이 남고, 그 뒤로는 해제할
> 수 있습니다.

Re-apply writes the id; the id makes removal provable. The user is never stuck
and we never delete on a guess.

## The no-survivor case: refuse, do not guess

Rev 1 deleted the `appliedId` key when no other entry survived. The research
itself says an absent `appliedId` is unproven behavior (`001` §What the repo
does NOT prove), so shipping it would be guessing with another app's state
(audit #8).

New rule: if our profile is the applied one and no other entry survives,
**refuse** with `no_safe_desktop_fallback` and change nothing. The dialog tells
the user to pick or create another profile in Desktop first. A refusal that
leaves the user in a working state beats a deletion that might not.

## `removeDesktop3pConfig`

```ts
// src/claude/desktop-3p.ts (append)

export type Desktop3pRemoveResult =
  | { status: "removed"; path: string; appliedIdAfter: string | null }
  | { status: "nothing-to-do"; path: string; message: string }
  | { status: "refused"; path: string; reason: "no_safe_desktop_fallback" | "unowned_profile";
      message: string }
  /** Metadata was rewritten but deletion failed: the caller must compensate. */
  | { status: "partial"; path: string; message: string; residualPaths: readonly string[] };

/**
 * Take our profile out of Claude Desktop's config library without leaving the
 * library pointing at a file that is gone.
 *
 * Ordering is deliberate and is the inverse of the write path: metadata is
 * repaired FIRST, the profile is deleted second. `writeDesktop3pConfig` writes
 * the profile then the metadata, because a metadata row naming a missing file
 * is the dangerous half. Removal has the same dangerous half, so it eliminates
 * the reference before eliminating the target — a crash in between leaves an
 * unreferenced file, which is inert, rather than a reference to nothing, which
 * is what Desktop chokes on.
 */
export function removeDesktop3pConfig(ownedId: string | null): Desktop3pRemoveResult {
  const libraryPath = resolveDesktop3pConfigLibraryPath();
  const metadataPath = join(libraryPath, "_meta.json");
  let configPath = libraryPath;
  try {
    if (!existsSync(metadataPath)) {
      return { status: "nothing-to-do", path: libraryPath,
        message: "no Claude Desktop config library to change" };
    }
    const metadata = parseMetadata(metadataPath);
    /*
     * Ownership is PROVED, not inferred from a display name a user can also
     * choose. The persisted id says which row we wrote; the payload marker
     * confirms the file on disk is still the gateway profile we generated.
     * Either one alone is guessable — the id could be stale after a hand-edit,
     * the name could be coincidence — so both must agree.
     */
    const ours = resolveOwnedEntry(metadata, libraryPath, ownedId);
    if (ours.kind === "absent") {
      return { status: "nothing-to-do", path: libraryPath,
        message: "no opencodex profile is registered" };
    }
    if (ours.kind === "unowned") {
      return { status: "refused", path: libraryPath, reason: "unowned_profile",
        message: `a profile named opencodex exists but was not written by this install (${ours.why})` };
    }
    configPath = join(libraryPath, `${ours.id}.json`);
    const entries = metadata.entries.filter(entry => entry?.id !== ours.id);

    /*
     * `appliedId` repair.
     *
     * - It pointed at us and something survives → hand Desktop the first
     *   surviving entry whose profile file actually EXISTS. Checking existence
     *   matters: a registry row whose file is already missing would just move
     *   the dangling pointer rather than fix it.
     * - It pointed at us and nothing usable survives → REFUSE. An absent
     *   `appliedId` is unproven behavior in someone else's app, and guessing
     *   with it is not ours to do (audit #8).
     * - It pointed at someone else, or was absent → untouched. Our removal is
     *   not a reason to change the user's selection.
     */
    const pointedAtUs = metadata.appliedId === ours.id;
    const survivor = entries.find(entry =>
      typeof entry?.id === "string" && existsSync(join(libraryPath, `${entry.id}.json`)))?.id ?? null;
    if (pointedAtUs && survivor === null) {
      return { status: "refused", path: configPath, reason: "no_safe_desktop_fallback",
        message: "opencodex is the only Claude Desktop profile; removing it would leave Desktop with none" };
    }
    const appliedIdAfter = pointedAtUs ? survivor : (metadata.appliedId ?? null);

    const next: Record<string, unknown> = { ...metadata, entries };
    if (appliedIdAfter === null) delete next.appliedId;
    else next.appliedId = appliedIdAfter;

    // Reference first, target second — a crash between them leaves an
    // unreferenced file (inert) rather than a reference to nothing (broken).
    atomicWriteFile(metadataPath, JSON.stringify(next, null, 2) + "\n");
    try {
      rmSync(configPath, { force: true });
      // The `.bak` holds a gateway API key and nothing else would ever clean
      // it up.
      rmSync(`${configPath}.bak`, { force: true });
    } catch (deleteError) {
      /*
       * Metadata is already rewritten. Reporting "nothing happened" here would
       * be the lie audit #2 named: the registry no longer lists a profile whose
       * file is still on disk. Surface it as partial so the caller compensates
       * from the compound snapshot and the user gets a journal row.
       */
      return { status: "partial", path: configPath,
        message: `metadata updated but the profile could not be deleted: ${messageOf(deleteError)}`,
        residualPaths: [configPath, `${configPath}.bak`] };
    }
    return { status: "removed", path: configPath, appliedIdAfter };
  } catch (error) {
    /*
     * Thrown before the metadata write — nothing changed. But the REASON
     * matters: rev 2 mapped every failure here to `unowned_profile`, which
     * tells a user to sort out ownership when their `_meta.json` is actually
     * unreadable or corrupt (audit r2 #10). An unreadable library is an
     * `unsafe` condition, not an ownership question.
     */
    return { status: "refused", path: configPath, reason: "unsafe",
      message: `the Claude Desktop config library could not be read safely: ${messageOf(error)}` };
  }
}
```

Unknown top-level fields survive through the spread, exactly as the write path
preserves them.

## The spec, and the bookkeeping that must ride with it

```ts
export const CLAUDE_DESKTOP_SPEC: NativeIntegrationSpec = {
  id: "claudeDesktop",
  targetPath: ctx => join(libraryPath(ctx), "_meta.json"),
  preflight: async (enabled, ctx) => {
    if (enabled) return { ok: true };
    // Ownership is decided here, before any snapshot is written, so an
    // unowned-profile refusal never leaves credential-bearing bytes behind.
    const owned = resolveOwnedEntry(readMetadata(ctx), libraryPath(ctx), ownedIdOf(ctx.config));
    if (owned.kind === "unowned") {
      return { ok: false, reason: "unowned_profile", message: owned.why };
    }
    return { ok: true };
  },
  /*
   * FIVE members, not three (audit round 2 #3).
   *
   * The external library is only half the operation: disable also clears
   * appliedFingerprint/appliedAt and persists desktopAutoApply=false in OUR
   * config. Snapshotting only Desktop's files means a restore hands back the
   * library while opencodex still believes the integration is off and keeps
   * auto-apply suppressed — a restore that produces a state the user never had.
   *
   * Restore order: profile and .bak first, then the metadata that references
   * them, then our own config. Our config is last because it is the only
   * member whose correctness depends on the others already being in place.
   */
  members: async ctx => [
    { key: "profile", absPath: profilePath(ctx), text: readTextOrNull(profilePath(ctx)) },
    { key: "bak", absPath: `${profilePath(ctx)}.bak`, text: readTextOrNull(`${profilePath(ctx)}.bak`) },
    { key: "meta", absPath: join(libraryPath(ctx), "_meta.json"), text: readTextOrNull(join(libraryPath(ctx), "_meta.json")) },
    { key: "ocx-config", absPath: configPath(), text: readTextOrNull(configPath()) },
  ],
  mutate: async (enabled, ctx) => {
    if (!enabled) {
      const result = removeDesktop3pConfig(ownedIdOf(ctx.config));
      if (result.status === "nothing-to-do") {
        return { ok: true, changed: false, message: result.message };
      }
      if (result.status === "refused") {
        return { ok: false, reason: result.reason, message: result.message };
      }
      if (result.status === "partial") {
        // Metadata is already rewritten. Name what changed so the runner
        // compensates from the compound snapshot instead of reporting a refusal.
        return { ok: false, reason: "write_failed", message: result.message,
          mutated: result.residualPaths };
      }
      /*
       * Bookkeeping, or the toggle lies and then un-toggles itself.
       *
       * `applied` in /status is literally `savedFingerprint !== null`, so a
       * kept fingerprint keeps reporting the integration as applied after we
       * removed it. And `desktopAutoApply` defaults ON while `desktopProfile`
       * exists, so the subagent-model route would recreate the file.
       * Persisting `desktopAutoApply: false` is what makes the removal stick.
       *
       * `desktopProfile` itself is KEPT: it holds the user's model
       * assignments, and throwing those away would cost far more than the
       * toggle implies.
       */
      const desktopProfile = { ...(ctx.config.claudeCode?.desktopProfile ?? {}) };
      delete desktopProfile.appliedFingerprint;
      delete desktopProfile.appliedAt;
      delete desktopProfile.appliedProfileId;
      ctx.config.claudeCode = {
        ...(ctx.config.claudeCode ?? {}), desktopProfile, desktopAutoApply: false,
      };
      saveConfigPreservingClaudeCode(ctx.config);
      return { ok: true, changed: true, message: `removed ${result.path}` };
    }
    // Enable re-applies through the existing write path, records the id it
    // wrote as `appliedProfileId`, and clears the auto-apply suppression the
    // disable set.
    ...
  },
  restore: async (members, ctx) => { for (const m of members) writeOrRemove(resolveMember(m, ctx), m.text); },
};
```

## Scope this pulls in

The `appliedProfileId` ownership proof is not free (audit round 2 #6): the
profile parser accepts a fixed key set and reconciliation carries only
fingerprint and timestamp forward, so a new field would be dropped on the next
reload. WP2 therefore also owns:

- `src/types.ts` — `appliedProfileId?: string` on the desktop profile.
- `src/claude/desktop-profile.ts` — accept and carry the field through
  `parseDesktopProfile` and `reconcileDesktopProfile`.
- A test for apply → reload → edit an assignment → disable, proving the id
  survives every step. Without it the ownership proof evaporates in normal use.

## Tests

`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` redirects the library verbatim
(`desktop-3p-paths.ts:69`), so every case runs against a `mkdtempSync` dir. The
model is `tests/claude-desktop-config-path.test.ts`, which already injects
arbitrary `_meta.json` states.

| Case | Assertion |
|---|---|
| Ours applied, a `Default` sibling exists | `appliedId` becomes Default's id; Default's row and file untouched |
| Ours is the only entry | REFUSES `no_safe_desktop_fallback`; nothing deleted |
| Survivor row exists but its file is missing | REFUSES; the pointer is not moved to another dangling target |
| `appliedId` points at someone else | `appliedId` unchanged; only our row and file go |
| A row named `opencodex` that is not the persisted id | REFUSES `unowned_profile`; untouched |
| Persisted id present, payload marker missing | REFUSES `unowned_profile` |
| Legacy: no persisted id | REFUSES `legacy_profile_unverified`; re-apply is offered |
| `_meta.json` unreadable or unparseable | REFUSES `unsafe`, NOT `unowned_profile` |
| `.bak` present | deleted with the profile |
| Unknown top-level fields | preserved identically after re-parse |
| **Round trip** | apply → disable → restore → profile, `.bak`, `_meta.json` AND opencodex config all byte-identical to the capture |
| **Config member** | after restore, `desktopAutoApply`, `appliedFingerprint`, `appliedAt` and `appliedProfileId` are all back to their pre-disable values |
| **Schema survival** | apply → reload config → edit an assignment → disable: `appliedProfileId` survives every step |
| **Invariant** | after ANY restore, `appliedId` resolves to a profile file that exists |
| Delete fails after metadata write | `partial` with both residual paths; compensation restores all three members |
| No library at all | `nothing-to-do`, no throw, no journal row |
| `_meta.json` unparseable | refuses, deletes NOTHING |
| Auto-apply | after disable, `desktopAutoApply === false` and the subagent-model route does not recreate the profile |

That last row is the one that proves the toggle stays toggled.

## Acceptance

- [ ] Every table row above passes.
- [ ] The compound snapshot holds all FOUR members (profile, `.bak`, `_meta.json`,
      opencodex config); restore returns all four, config last.
- [ ] The invariant test holds: no restored `_meta.json` ever names a missing
      profile file.
- [ ] Removal repairs `appliedId` before deleting, proven by stubbing deletion
      to throw and asserting metadata contents.
- [ ] A stubbed deletion failure yields `partial`, never `nothing-to-do`.
- [ ] Ownership needs BOTH the persisted id and the payload marker; a name-only
      match refuses, and a legacy profile refuses `legacy_profile_unverified`.
- [ ] A corrupt `_meta.json` refuses `unsafe`, never `unowned_profile`.
- [ ] `appliedProfileId` survives parse and reconciliation — the ownership proof
      does not evaporate on the next config reload.
- [ ] `.bak` never survives its profile.
- [ ] `/api/claude-desktop/status` reports `applied: false` after a disable.
- [ ] An unparseable `_meta.json` deletes nothing.
- [ ] `bun run typecheck` and the existing Desktop tests stay green.
