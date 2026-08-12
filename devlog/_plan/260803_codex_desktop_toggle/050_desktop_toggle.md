# WP6 — Claude Desktop toggle: pivot to standard mode, then remove credentials

Research: `002_desktop_standard_mode.md`. Read it first; this doc is the diff.
The official contract is Anthropic's
[Claude Desktop configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration).
The page itself supports the standard-mode and read-once-at-launch semantics used
below; this document no longer asserts a `lastmod` date the page does not show.

The first concrete failure mode is a disable that deletes `<id>.json` while
`_meta.json.appliedId` still names that id: Desktop opens the selected file by id,
so the next launch points at something missing. The superseded `030` correctly
noticed that pointer hazard, but concluded that exact restoration of the previous
selection was required and therefore removal needed a durable operation-state
engine. That joined two different requirements. Exact restoration is still
impossible because apply overwrites `appliedId` without recording its previous
value (`src/claude/desktop-3p.ts:345-358`); returning to standard Claude is
documented and achievable. This phase writes and selects a present, readable,
credential-free `{}` profile first, then removes the old opencodex profile and
its credential-bearing backup. It does not add an operation-state engine.

The audit exposed a second, more basic failure in the first revision of this
phase: **its status read and OFF path could install a filesystem footprint.**
`writeDesktop3pConfig()` calls `mkdirSync(libraryPath, { recursive: true })`
before reading metadata (`src/claude/desktop-3p.ts:343-345`), while the first
revision hard-coded `installed: true` and treated missing metadata as permission
to create a standard profile. On a machine that never created a Claude Desktop
config library, merely reading status or requesting OFF would manufacture one.
That position is reversed here plainly: reads never write; an absent library is
`not_installed`; OFF with no owned Desktop state is a successful idempotent no-op;
only an explicit setup/apply/enable action may create the library.

The audit also rejected our bookkeeping as observed truth. A saved
`appliedFingerprint` says only what opencodex last intended to write. The user can
select another Desktop profile, edit/delete the selected profile, or return to
standard mode while that marker remains. Every status below therefore starts at
`_meta.json.appliedId`, proves the selected file exists and parses as an object,
classifies its `inferenceProvider` and credential-field shape, and only then uses
the fingerprint to distinguish current from drifted. Desired state remains a
separate required field.

## IN / OUT

IN:

- `src/claude/desktop-3p.ts` — MODIFY: add the standard-mode remover and make
  apply prefer the selected opencodex row when an interrupted cleanup left two;
  add the read-only installation/library and selected-profile inspector.
- `src/cli/claude-desktop.ts` — MODIFY: explicit CLI apply is the enable
  direction and persists WP3 desired ON plus `desktopAutoApply: true` first.
- `src/server/management/agent-settings-routes.ts` — MODIFY: gate auto-apply on
  WP3 desired state, join WP3's per-client flight, re-read persisted intent after
  its await, expose desired and observed state in `/status`, and make explicit
  `/apply` an enable action.
- `src/server/management/native-integration-routes.ts` — MODIFY: add
  `claude-desktop` status and `PUT` toggle using the existing typed
  success/refusal/single-flight pattern (`:31-86`, `:164-174`, `:371-445`).
- `gui/src/pages/integrations/native-api.ts` — MODIFY: consume WP3's complete
  four-client native contract and WP5's Codex additions, then extend only the
  Desktop reason allowlist/residual detail. WP6 adds no competing union or envelope.
- `gui/src/pages/integrations/integration-api.ts` — MODIFY: parse Desktop desired
  state from the existing rich status route.
- `gui/src/pages/integrations/overview-clients.ts` — MODIFY: give
  `claudeDesktopRow` a toggle and keep desired switch state separate from observed
  `applied` state.
- `gui/src/pages/integrations/IntegrationsOverview.tsx` — MODIFY: route the toggle,
  select Desktop dialog copy, and render localized partial/refusal outcomes.
- `gui/src/pages/integrations/refusal-copy.ts` — MODIFY: translate Desktop's
  metadata refusal and incomplete credential cleanup.
- `gui/src/pages/ClaudeDesktop.tsx` — MODIFY: show desired OFF honestly and label
  Save + Apply as an enable action while OFF.
- `gui/src/i18n/{en,ko,ja,zh,de,ru}.ts` — MODIFY: exact keys below.
- `tests/desktop-3p-removal.test.ts` — NEW: filesystem and crash-boundary cases.
- `tests/native-claude-desktop-toggle.test.ts` — NEW: route, ordering, persistence,
  refusal, and auto-apply cases.
- `tests/claude-messages-endpoint.test.ts` — MODIFY: shared transport remains live.
- `gui/tests/integrations-overview-rows.test.ts` — MODIFY: desired/observed mapping.
- `gui/tests/integrations-surfaces.test.tsx` — MODIFY: switch, dialog, and outcome.
- `gui/tests/claude-desktop-locale.test.ts` — MODIFY: six-locale parity.

OUT:

- `src/types.ts` and `src/config.ts` — WP3 already owns
  `clientIntegrations["claude-desktop"]`, default-ON parsing,
  `clientIntegrationEnabled`, `mutateClientIntegrationEnabled`, the complete native
  status/success/refusal contract, its status helpers, per-client single-flight,
  startup reconciliation, and field-scoped persistence. WP6 consumes those owners
  and does not open-code the map, redefine an envelope, or replace the whole
  `claudeCode` subtree (`020_desired_state.md`; `src/config.ts:1846-1884`).
  The existing `desktopAutoApply` field is at `src/types.ts:458-459`, not line 456.
- `src/claude/desktop-3p-paths.ts` — path resolution is already one tested owner;
  the remover consumes `resolveDesktop3pConfigLibraryPath()` unchanged (`:67-78`).
- `src/claude/desktop-profile.ts` — assignments/defaults are preserved as-is; no
  new profile field is needed.
- `/v1/messages` and `src/server/claude-messages.ts` — shared transport is not a
  Desktop lifecycle switch. Claude Code must continue using it.
- `inferenceProvider: "anthropic"` — this means direct Claude API billing, not
  normal subscription mode, so it is not a disable fallback.
- A native Desktop "return to standard" button — UNPROVEN and not called.
- Recording the previous `appliedId` — explicitly deferred. It would enable exact
  restoration of another prior third-party selection, not standard-mode disable.
- The user's live Claude Desktop config library — no implementation or C-gate
  command mutates it without a separate, explicit approval.

## Composition order — this phase is after WP5

The first revision called WP5 and WP6 parallel siblings. That is wrong wherever
they touch the same route and GUI contract. WP5 adds `codex` to
`NativeIntegrationClientId`, the server GET list, `native-api.ts`'s runtime
allowlists, the overview merge, refusal reasons, and Codex restore detail
(`040_codex_toggle.md:230-366,416-545`). WP6 is **sequential after WP5** for those
files and its diffs apply to WP5's output, not today's three-client tree.

WP3 remains the shared-contract owner. By the time WP6 starts, the shared client
union is already the complete `"codex" | "claude" | "claude-desktop" | "grok"`
contract; `NativeStatus` and every successful toggle response already require
`desiredEnabled`; the refusal envelope and status constructors are already
defined; and both GUI runtime allowlists already admit all four clients and shared
reasons. WP6 imports/uses those definitions. It does **not** repeat the old diff
from `"claude" | "grok"`, because that would delete WP5's `codex` entry.
Feature-specific Desktop reason literals extend WP3's existing reason union; the
envelope itself and its required fields are not re-declared.

## What we depend on and what we refuse to depend on

We depend on one official contract: third-party mode activates only when
`inferenceProvider` and that provider's required credentials are valid; otherwise
Desktop launches in standard mode. Desktop reads the configuration once at launch
([configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration),
`002:27-46`). Therefore `{}` is deliberate: valid JSON, no
`inferenceProvider`, no credential fields.

We refuse to depend on all four UNPROVEN behaviors:

1. absent `appliedId` being safe;
2. dangling `appliedId` being tolerated;
3. a `Default` entry being guaranteed;
4. a native "return to standard" UI action existing.

The algorithm never removes `appliedId`, never points it at an unreadable or
missing file, never chooses by `name === "Default"`, and never automates Desktop's
UI. The local evidence makes the third refusal load-bearing: this machine's real
`_meta.json` has a `Default` row whose `<id>.json` does not exist (`002:60-63`).

## Core diff — probe first, then select a safe target before cleanup

MODIFY `src/claude/desktop-3p.ts`. Add `unlinkSync` to the existing fs import,
export the read-only observation and removal vocabulary beside
`Desktop3pConfigLibraryOptions`, and place the inspector/remover after
`writeDesktop3pConfig` and before `atomicReplaceDesktopConfig`:

```diff
-import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
+import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
@@
+export type Desktop3pObservedKind =
+  | "not_installed"
+  | "no_owned_state"
+  | "standard"
+  | "gateway"
+  | "foreign"
+  | "unsafe";
+
+export interface Desktop3pLibraryObservation {
+  kind: Desktop3pObservedKind;
+  libraryPath: string;
+  metadataPath: string;
+  selectedId: string | null;
+  selectedProfilePath: string | null;
+  selectedOwned: boolean;
+  fingerprint: string | null;
+  reason?: "metadata_unreadable" | "selected_missing" | "profile_unreadable"
+    | "provider_credentials_invalid" | "ambiguous_owned_rows";
+}
+
+export type Desktop3pRemoveReason =
+  | "unsafe_metadata"
+  | "write_failed"
+  | "cleanup_incomplete"
+  | "desired_state_changed"
+  | "desired_state_unavailable";
+
+export interface Desktop3pRemoveResult {
+  ok: boolean;
+  changed: boolean;
+  libraryPath: string;
+  standardProfilePath?: string;
+  reason?: Desktop3pRemoveReason;
+  message?: string;
+  residualPaths?: string[];
+}
+
+export type Desktop3pIntentGuardResult =
+  | { ok: true }
+  | { ok: false; reason: "desired_state_changed" | "desired_state_unavailable" };
+
+export interface Desktop3pRemoveDeps {
+  randomId?: typeof randomUUID;
+  writeFile?: typeof atomicWriteFile;
+  unlinkFile?: typeof unlinkSync;
+  beforeWrite?: () => Desktop3pIntentGuardResult;
+}
```

`inspectDesktop3pConfigLibrary(options)` is the one read-only probe used by both
status routes and the remover. It resolves the path but never calls `mkdirSync`,
`atomicWriteFile`, `copyFileSync`, or `unlinkSync`:

```diff
+export function inspectDesktop3pConfigLibrary(
+  options: Desktop3pConfigLibraryOptions = {},
+): Desktop3pLibraryObservation {
+  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
+  const metadataPath = join(libraryPath, "_meta.json");
+  // Operational installation means the config library already exists as a
+  // directory. This does not claim to detect every installed-but-never-launched
+  // Desktop bundle; it is the filesystem boundary opencodex can safely prove.
+  if (!existsSync(libraryPath) || !statSync(libraryPath).isDirectory()) {
+    return { kind: "not_installed", libraryPath, metadataPath,
+      selectedId: null, selectedProfilePath: null, selectedOwned: false,
+      fingerprint: null };
+  }
+  if (!existsSync(metadataPath)) {
+    return { kind: "no_owned_state", libraryPath, metadataPath,
+      selectedId: null, selectedProfilePath: null, selectedOwned: false,
+      fingerprint: null };
+  }
+
+  // Parse metadata, resolve ONLY appliedId, require its entry and file to exist,
+  // parse that file as a non-array object, and inspect field NAMES/TYPES only.
+  // Never return profile JSON or any credential value.
+  // - a selected non-opencodex row is foreign;
+  // - selected opencodex + no inferenceProvider and no credential fields is standard;
+  // - selected opencodex + gateway provider + required gateway URL/key fields is gateway;
+  // - dangling/unreadable/invalid provider-credential combinations are unsafe.
+  // Compute the fingerprint only after the selected file passes those checks.
+}
```

`not_installed` is deliberately an operational/library result, not proof that no
Claude Desktop application bundle exists anywhere. An installed app that has never
created its 3P library is indistinguishable without platform-specific bundle
guessing; the safe answer for status and OFF is still “no manageable Desktop state”
and no write. Tests inject `options` and never inspect the user's real library.

The function signature is fixed here, and it lives in
`src/claude/desktop-3p.ts` because `parseMetadata`, metadata ownership, atomic
writes, and profile-path construction already live there:

```ts
export function removeDesktop3pConfig(
  options: Desktop3pConfigLibraryOptions = {},
  deps: Desktop3pRemoveDeps = {},
): Desktop3pRemoveResult
```

`options` gives tests the same pure path seam used by
`resolveDesktop3pConfigLibraryPath`; `deps` gives failure tests deterministic ids,
atomic-write failure, and unlink failure without patching globals. Production
passes neither. The function does not accept or return credential values and
never logs profile contents.

The implementation is this ordered state machine, expressed against the current
writer:

```diff
 export function writeDesktop3pConfig(/* existing args */) {
@@
-    const existing = metadata.entries.find(entry => entry?.name === "opencodex" && typeof entry.id === "string");
+    // If disable was interrupted after selecting its replacement, reuse the
+    // selected opencodex row, not an older non-selected cleanup row.
+    const existing = metadata.entries.find(entry =>
+      entry?.name === "opencodex" && entry.id === metadata.appliedId
+    ) ?? metadata.entries.find(entry =>
+      entry?.name === "opencodex" && typeof entry.id === "string"
+    );
@@
 }
+
+export function removeDesktop3pConfig(
+  options: Desktop3pConfigLibraryOptions = {},
+  deps: Desktop3pRemoveDeps = {},
+): Desktop3pRemoveResult {
+  const libraryPath = resolveDesktop3pConfigLibraryPath(options);
+  const metadataPath = join(libraryPath, "_meta.json");
+  const randomId = deps.randomId ?? randomUUID;
+  const writeFile = deps.writeFile ?? atomicWriteFile;
+  const unlinkFile = deps.unlinkFile ?? unlinkSync;
+  const beforeWrite = deps.beforeWrite;
+  const observed = inspectDesktop3pConfigLibrary(options);
+  // 0. An absent library, missing metadata, or metadata with no owned row is an
+  // idempotent success/no-op. OFF must not call mkdirSync or create a standard
+  // profile when no opencodex Desktop state exists.
+
+  // 1. Parse and validate before the first Desktop-library write. A non-string
+  // id, path separator, duplicate non-selected opencodex row, or malformed
+  // entries array is unsafe_metadata: desired OFF is already persisted by the
+  // caller, but this function touches no Desktop bytes.
+
+  // 2a. If appliedId already selects an opencodex row whose file parses exactly
+  // as a credential-free object with no inferenceProvider, this is a retry.
+  // Reuse it; do not allocate another replacement.
+  // 2b. Otherwise allocate randomId(), atomically write "{}\n" to the fresh
+  // <id>.json, and verify it can be read and parsed before publishing the id.
+
+  // 3. Atomically write metadata with BOTH rows still present and appliedId set
+  // to the new standard row. From here on Desktop's selected id always resolves.
+  // Call beforeWrite() immediately before the fresh profile write, metadata
+  // pivot, each unlink, and final metadata write. A changed/unavailable desired
+  // state returns a typed refusal and performs no later mutation.
+
+  // 4. Remove the old <id>.json.bak FIRST, then old <id>.json through
+  // unlinkFile. Keep the old metadata row until both deletions succeed: it is
+  // the retry locator after a crash. Missing files count as already cleaned;
+  // no file content is printed.
+
+  // 5. Atomically remove the old metadata row LAST. Preserve every unrelated
+  // entry and every unknown top-level/entry field byte-semantically through
+  // object spreads, as writeDesktop3pConfig does today.
+
+  // Any failure after step 3 returns cleanup_incomplete plus residualPaths.
+  // appliedId remains on the readable standard profile; the caller does not
+  // clear appliedFingerprint/appliedAt until a retry completes steps 4-5.
+}
```

The existing writer also receives an optional WP3 intent guard; a route-level
check before model discovery is not close enough to either atomic commit:

```diff
 export function writeDesktop3pConfig(
   /* existing parameters */,
+  deps: { beforeWrite?: () => Desktop3pIntentGuardResult } = {},
 ): { written: boolean; path: string; reason?: string; fingerprint?: string } {
@@
+    const beforeProfile = deps.beforeWrite?.();
+    if (beforeProfile && !beforeProfile.ok) {
+      return desiredStateWriteRefusal(configPath, beforeProfile.reason);
+    }
     const { backupPath } = atomicReplaceDesktopConfig(configPath, configJson);
     try {
+      const beforeMetadata = deps.beforeWrite?.();
+      if (beforeMetadata && !beforeMetadata.ok) {
+        return desiredStateWriteRefusal(configPath, beforeMetadata.reason);
+      }
       atomicWriteFile(metadataPath, /* ... */);
```

Explicit apply, native enable, and auto-apply pass
`() => requirePersistedClientIntent("claude-desktop", true)`. The remover passes
the same helper with `false` before every profile write, metadata write, and
unlink. `desired_state_changed` and `desired_state_unavailable` map through WP3's
shared refusal serializer; they never become a generic green no-op.

Path validation is deletion policy, not format cleanup. The old id must be one
path component: reject `/`, `\\`, `..`, NUL, or a resolved path outside
`libraryPath`. Multiple non-selected `name === "opencodex"` rows are ambiguous and
REFUSE `unsafe_metadata`; the function does not guess which user-visible row to
delete. **Reversal from the first revision:** a missing library, missing
`_meta.json`, or metadata with no opencodex-owned row does not create a standard
file or metadata. Removal returns `{ ok: true, changed: false }`; a dangling
unrelated `Default` row is preserved untouched. Only `writeDesktop3pConfig` reached
from an explicit setup/apply/enable action retains permission to `mkdirSync`.

The standard file is exactly `{}` plus a newline. Do not send
`inferenceProvider: "anthropic"`; do not copy any old field into the replacement;
do not call `atomicReplaceDesktopConfig` for the fresh target, because that would
create another `.bak` the disable then has to explain.

## Persist intent before touching Desktop

WP3 provides desired state, the per-client coordinator, startup reconciliation,
and the shared response constructors. Both CLI apply and the existing POST apply
become explicit enable actions. **The earlier `saveConfigPreservingClaudeCode`
examples are withdrawn.** They mutate a request snapshot and save a whole object,
which can overwrite a concurrent sibling-field update. Every persistence below
uses `mutatePersistedConfig()` (`src/config.ts:1846-1884`); its callback changes
only `clientIntegrations["claude-desktop"]`,
`claudeCode.desktopAutoApply`, and the named `desktopProfile` fields.

```diff
 // src/cli/claude-desktop.ts:45-83
+import { loadConfig, mutatePersistedConfig } from "../config";
+import { requirePersistedClientIntent, runClientIntegrationFlight } from "../integrations/desired-state";
@@
   const config = loadConfig();
   const state = await buildClaudeDesktopState(config, profile);
-  config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: state.profile };
-  saveConfigPreservingClaudeCode(config);
+  // A live daemon owns persistence + writing inside POST /apply's Desktop flight.
+  // Do not save locally first: that would be outside the daemon's OFF ordering.
   const live = await (deps.findLiveProxyImpl ?? findLiveProxy)();
   if (live) { /* existing POST delegation, carrying state.profile */ }
+  return runClientIntegrationFlight("claude-desktop", "explicit-apply", async () => {
+    const persisted = mutatePersistedConfig(next => {
+      next.clientIntegrations = { ...next.clientIntegrations, "claude-desktop": true };
+      next.claudeCode ??= {};
+      next.claudeCode.desktopAutoApply = true;
+      next.claudeCode.desktopProfile = state.profile;
+      return { changed: true, value: undefined };
+    });
+    if (persisted.status === "unavailable") {
+      return { ok: false, path: "", reason: "config unavailable" };
+    }
+    const permit = requirePersistedClientIntent("claude-desktop", true);
+    if (!permit.ok) return { ok: false, path: "", reason: permit.reason };
+    return writeDesktop3pConfig(/* existing values from permit.config */, {
+      beforeWrite: () => requirePersistedClientIntent("claude-desktop", true),
+    });
+  });
```

```diff
 // src/server/management/agent-settings-routes.ts:735-738
-      const state = await buildClaudeDesktopState(config, profileOverride);
-      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: state.profile };
-      saveConfigPreservingClaudeCode(config);
+      return runClientIntegrationFlight("claude-desktop", "explicit-apply", async () => {
+      const persisted = mutatePersistedConfig(next => {
+        next.clientIntegrations = { ...next.clientIntegrations, "claude-desktop": true };
+        next.claudeCode ??= {};
+        next.claudeCode.desktopAutoApply = true;
+        if (profileOverride) next.claudeCode.desktopProfile = profileOverride;
+        return { changed: true, value: next };
+      });
+      if (persisted.status === "unavailable") {
+        const desiredEnabled = clientIntegrationEnabled(loadConfig(), "claude-desktop");
+        return jsonResponse({
+          error: `Desktop desired state was not saved: ${persisted.reason}`,
+          desiredEnabled,
+        }, persisted.reason === "conflict" ? 409 : 500);
+      }
+      const state = await buildClaudeDesktopState(persisted.value, profileOverride);
+      // Continue to the guarded writer below; close the flight after marker commit.
@@
-      if (!result.written) return jsonResponse({ error: result.reason, saved: true, path: result.path }, 500);
+      if (!result.written) return jsonResponse({
+        error: result.reason ?? "Claude Desktop apply failed",
+        saved: true, path: result.path, desiredEnabled: true,
+      }, 500);
@@
-      return jsonResponse({ ok: true, saved: true, applied: true, path: result.path, fingerprint: result.fingerprint });
+      return jsonResponse({ ok: true, saved: true, applied: true,
+        desiredEnabled: true, path: result.path, fingerprint: result.fingerprint });
+      });
```

The disable endpoint follows `native-integration-routes.ts` rather than inventing
a second response grammar. There is intentionally **no client-union or envelope
diff here**. WP3's four-client contract already includes `claude-desktop`, the
`residualPaths` extension, and required `desiredEnabled` on status, success, and
refusal/failure responses. WP6 appends `unsafe_metadata` and
`cleanup_incomplete` only to `NativeRefusalReason`, calls WP3's
`withDesiredState` and widened `refusal({ ... })` helpers, and adds the Desktop PUT
after WP5's Codex route.

```diff
 export type NativeRefusalReason =
   /* WP3 shared reasons + WP5 Codex reasons */
+  | "unsafe_metadata"
+  | "cleanup_incomplete";
@@
 export interface NativeStatus {
   /* WP3 required fields + WP5 Codex detail */
-  reason?: "external_provider_preserved";
+  reason?: "external_provider_preserved" | "not_installed";
 }
```

Add the GET row with desired and observed fields kept separate. It reports the
library path, not a guessed `Default` profile path:

```diff
+function desktopStatus(): NativeStatus {
+  const persisted = loadConfig();
+  const observed = inspectDesktop3pConfigLibrary(); // read-only; never mkdir/write
+  const saved = persisted.claudeCode?.desktopProfile?.appliedFingerprint ?? null;
+  const fingerprintMatches = observed.kind === "gateway"
+    && saved !== null && observed.fingerprint === saved;
+  return withDesiredState(persisted, {
+    clientId: "claude-desktop",
+    state: fingerprintMatches ? "current"
+      : observed.kind === "unsafe" || observed.kind === "gateway" ? "unsafe"
+      : "absent",
+    installed: observed.kind !== "not_installed",
+    configPath: observed.libraryPath,
+    disableBlocked: null,
+    ...(observed.kind === "not_installed" ? { reason: "not_installed" as const } : {}),
+  });
+}
@@
-      clients: [codexStatus(ctx), claudeStatus(config, getConfigPath()), grokStatus(config)],
+      clients: [
+        codexStatus(ctx),
+        claudeStatus(config, getConfigPath()),
+        desktopStatus(),
+        grokStatus(config),
+      ],
```

`disableBlocked` is null intentionally. The read-only inspector can classify
malformed state as `unsafe`, but the PUT remains available so desired OFF can be
recorded. An absent library returns `installed:false`, `state:"absent"`, reason
`not_installed`, and the actual required `desiredEnabled` without creating a
directory. A malformed file is returned by PUT as desired OFF + observed unsafe,
not hidden as an unavailable action.

Disable body, in this exact order:

```ts
// PUT { enabled: false }
return runClientIntegrationFlight("claude-desktop", "disable", async () => {
  // 1. Persist BOTH suppressors from the newest on-disk snapshot. The callback
  // patches named fields only; it never assigns a replacement claudeCode subtree.
  const persisted = mutatePersistedConfig(next => {
    next.clientIntegrations = { ...next.clientIntegrations, "claude-desktop": false };
    next.claudeCode ??= {};
    next.claudeCode.desktopAutoApply = false;
    return { changed: true, value: undefined };
  });
  if (persisted.status === "unavailable") {
    return refusalFromDesiredFailure("claude-desktop", persisted);
  }

  // 2. Probe only after intent commits. With no library/metadata/owned row this is
  // a successful no-op and MUST NOT create a directory, profile, or _meta.json.
  const before = inspectDesktop3pConfigLibrary();
  const permitRemoval = requirePersistedClientIntent("claude-desktop", false);
  if (!permitRemoval.ok) {
    const desiredEnabled = clientIntegrationEnabled(loadConfig(), "claude-desktop");
    return refusal({
      status: 409, clientId: "claude-desktop", reason: "config_busy",
      desiredEnabled, observedState: desktopStatus().state,
      message: `Desktop removal was skipped: ${permitRemoval.reason}.`,
    });
  }
  const removed = removeDesktop3pConfig({}, {
    beforeWrite: () => requirePersistedClientIntent("claude-desktop", false),
  });
  if (!removed.ok) {
    // unsafe_metadata: 409 refused; no Desktop bytes changed.
    // write_failed/cleanup_incomplete: 500 failed. Every post-commit envelope has
    // desiredEnabled:false; cleanup_incomplete includes residualPaths only.
    const desiredStateReason = removed.reason === "desired_state_changed"
      || removed.reason === "desired_state_unavailable";
    return refusal({
      status: removed.reason === "unsafe_metadata" || desiredStateReason ? 409 : 500,
      clientId: "claude-desktop",
      reason: desiredStateReason ? "config_busy" : removed.reason ?? "write_failed",
      desiredEnabled: false,
      observedState: desktopStatus().state,
      message: removed.message ?? "Claude Desktop cleanup did not complete.",
      residualPaths: removed.residualPaths,
    });
  }

  // 3. Only complete cleanup clears marker fields, again from a fresh snapshot.
  // Assignments/defaults and every sibling Claude field remain untouched.
  mutatePersistedConfig(next => {
    const profile = next.claudeCode?.desktopProfile;
    if (!profile) return { changed: false, value: undefined };
    delete profile.appliedFingerprint;
    delete profile.appliedAt;
    return { changed: true, value: undefined };
  });

  const after = inspectDesktop3pConfigLibrary();
  return jsonResponse({
    ok: true,
    clientId: "claude-desktop",
    changed: removed.changed,
    state: "absent",
    desiredEnabled: false,
    reason: before.kind === "not_installed" || before.kind === "no_owned_state"
      ? "not_installed" : "desktop_standard_mode",
    message: after.kind === "not_installed" || after.kind === "no_owned_state"
      ? "No Claude Desktop-managed state exists; nothing was created or removed."
      : "Claude Desktop is configured for standard mode; restart required",
  } satisfies NativeToggleEnvelope);
});
```

The endpoint does not stop, restart, or reconfigure the proxy. Enable persists
desired `true` and `desktopAutoApply: true` first, then runs the same state build
and `writeDesktop3pConfig` path as POST apply, and finally records fingerprint/time.
If generation fails, desired ON remains visible while observed state remains off;
the response is a failure, not false green. No enable or disable branch touches
`config.claudeCode.enabled`, so Claude Code's use of `/v1/messages` is unchanged.

All four writers enter the **same WP3 per-client flight**: automatic apply,
`POST /api/claude-desktop/apply`, native PUT enable, and native PUT disable. The
CLI delegates to POST when a daemon is live; its no-daemon fallback uses the same
coordinator. WP3 joins an identical operation and refuses a competing direction;
it does not coalesce ON and OFF. Whichever direction owns the flight reaches a
whole outcome while the competitor receives a typed contention/refusal and may
retry. Immediately before every irreversible
`writeDesktop3pConfig` or `removeDesktop3pConfig` call, the operation reloads
persisted desired state. Auto-apply skips unless it is still ON; explicit enable
is allowed only after its own ON commit; removal runs only while OFF. A stale
request-scoped `config` object is never the authority for that final check.

WP3's in-process promise map is backed by its per-client SQLite coordinator, so a
cooperating CLI/startup process and the server cannot write Desktop concurrently
(`020_desired_state.md:486-515`). This still cannot exclude the user, Claude
Desktop, or a non-cooperating process editing the library; the post-write
inspector and drift response expose those changes rather than calling them current.

The enable branch is concrete, not an internal HTTP call back into the same
server. Dynamic imports preserve `management-api.ts`'s current cycle boundary
(`native-integration-routes.ts:176-183`):

```diff
+    return runClientIntegrationFlight("claude-desktop", "enable", async () => {
+      const persisted = mutatePersistedConfig(next => {
+        next.clientIntegrations = { ...next.clientIntegrations, "claude-desktop": true };
+        next.claudeCode ??= {};
+        next.claudeCode.desktopAutoApply = true;
+        return { changed: true, value: undefined };
+      });
+      if (persisted.status === "unavailable") {
+        return refusalFromDesiredFailure("claude-desktop", persisted);
+      }
+
+    const { buildClaudeDesktopState } = await import("../management-api");
+    const { desktopVisibleNativeSlugs } = await import("../../codex/catalog");
+    const { writeDesktop3pConfig } = await import("../../claude/desktop-3p");
+    const fresh = loadConfig();
+    const state = await buildClaudeDesktopState(fresh);
+    const routed = state.models
+      .filter(model => model.available && !model.route.startsWith("native/"))
+      .map(model => {
+        const slash = model.route.indexOf("/");
+        return {
+          provider: model.route.slice(0, slash),
+          id: model.route.slice(slash + 1),
+          contextWindow: model.contextWindow,
+        };
+      });
+    // Re-read immediately before the irreversible writer, inside the same flight.
+    // A queued OFF cannot cross this point unnoticed.
+    const permitWrite = requirePersistedClientIntent("claude-desktop", true);
+    if (!permitWrite.ok) {
+      const desiredEnabled = clientIntegrationEnabled(loadConfig(), "claude-desktop");
+      return refusal({ status: 409, clientId: "claude-desktop", reason: "config_busy",
+        desiredEnabled, observedState: desktopStatus().state,
+        message: `Desktop enable was skipped: ${permitWrite.reason}.` });
+    }
+    const beforeWrite = permitWrite.config;
+    const written = writeDesktop3pConfig(
+      Number(ctx.url.port) || beforeWrite.port,
+      [...desktopVisibleNativeSlugs(beforeWrite)],
+      routed,
+      beforeWrite.apiKeys?.[0]?.key,
+      "static",
+      state.profile,
+      { beforeWrite: () => requirePersistedClientIntent("claude-desktop", true) },
+    );
+    if (!written.written) return refusal({
+      status: 500, clientId: "claude-desktop", reason: "write_failed",
+      desiredEnabled: true, observedState: desktopStatus().state,
+      message: written.reason ?? "Claude Desktop apply failed.",
+    });
+    mutatePersistedConfig(next => {
+      next.claudeCode ??= {};
+      next.claudeCode.desktopProfile = {
+        ...state.profile,
+        appliedFingerprint: written.fingerprint,
+        appliedAt: new Date().toISOString(),
+      };
+      return { changed: true, value: undefined };
+    });
+    return jsonResponse({
+      ok: true, clientId: "claude-desktop", changed: true,
+      state: "current", desiredEnabled: true,
+      message: "Claude Desktop gateway profile applied; restart required.",
+    } satisfies NativeToggleEnvelope);
+    });
```

The implementation should extract the repeated state-to-routed-model mapping
from the existing POST apply into one local helper in
`agent-settings-routes.ts` only if that avoids byte-for-byte duplication without
creating a cross-module cycle. It must not call the management endpoint over
loopback or invent another transport.

`POST /api/claude-desktop/apply` returns `desiredEnabled: true` on success and on
every failure after the ON commit. A failure before persistence reports the
current persisted desired state through WP3's refusal helper. The native enable
and disable successes, native GET row, rich status GET, startup reconciliation
diagnostic, and all post-commit refusals follow the same rule: no response shape
omits `desiredEnabled`, and no caller reconstructs it from `applied`.

## Crash-safety: exact residual state at every boundary

There is no transaction across opencodex `config.json`, Desktop `_meta.json`, and
three profile paths. The ordering preserves a valid selected pointer; it does not
make the whole disable transactional. WP3 now treats desired OFF as a **converge
instruction**, not merely a gate: startup reconciliation enters the same
`claude-desktop` flight and re-runs this remover while OFF. That reverses the first
revision's false claim that persisting a boolean alone survived a crash.

The remover must be idempotent from every state it can inherit, including states
created by older builds or a hand edit:

| State at startup/retry | Read-only classification | What the idempotent re-run does |
|---|---|---|
| Library directory absent | `not_installed` | Returns unchanged success. It does not call `mkdirSync`, create `_meta.json`, or create a profile. Startup reconciliation is complete for this client. |
| Library exists, metadata absent, or metadata has no opencodex-owned row | `no_owned_state` or `foreign` | Returns unchanged success and preserves all files. OFF is already converged because there is no owned gateway state to remove. |
| Desired OFF persisted; old opencodex gateway is still selected | `gateway` (desired/observed drift) | Creates and verifies one fresh `{}` target, pivots `appliedId`, then performs cleanup. This closes “crash after persist, before mutate.” |
| Fresh `{}` file exists but metadata still selects the old gateway | `gateway`; orphan id is not discoverable | Creates another target and proceeds. The first credential-free orphan may remain; without a journal it cannot be identified safely. This leak is acknowledged, not called full cleanup. |
| Metadata selects standard; old row + `.bak` + `.json` remain | `standard`, with retry locator | Reuses the selected standard row, deletes `.bak`, then `.json`, then the old row. It allocates no second selected profile. |
| Metadata selects standard; `.bak` is already absent | `standard`, with retry locator | Missing backup is already-clean; deletes old `.json`, then the old row. |
| Metadata selects standard; both old files are absent but old row remains | `standard`, with retry locator | Removes exactly the stale old row; unrelated rows survive. |
| Old row is gone; selected standard is valid; apply markers remain | `standard`; markers are not observed truth | Performs no Desktop write, then field-scoped persistence deletes only `appliedFingerprint`/`appliedAt`. Status already reports standard/absent before marker cleanup. |
| Selected standard and markers are clean | `standard` | Returns unchanged success. A Desktop process already running may still use launch-time state until restart. |
| Selected owned id is missing/unreadable, provider/credentials conflict, metadata is malformed, or cleanup rows are ambiguous | `unsafe` | Refuses without a Desktop write on every retry, leaves desired OFF durable, and emits only typed reason/path evidence. Startup records the non-secret reconciliation failure for user action; it never guesses or deletes. |

Startup reconciliation does not run apply while desired ON; existing startup/auto
paths remain separately gated. It invokes only the OFF converger, and a failure
does not flip desired state back to ON. Explicit OFF, startup OFF reconciliation,
explicit enable, POST apply, and auto-apply all share the same flight, so the
startup remover cannot overlap an explicit writer in the same process.

Desktop is the exception to WP3's generic `trigger: "status"` convergence hook.
For `claude-desktop`, status-triggered reconciliation performs inspection only and
returns the unresolved/resolved diagnostic without invoking the remover. Startup
and ensure re-run the remover; an explicit OFF request runs it; GET never does.
Otherwise a status read with desired OFF could create the standard pivot or delete
credential files, violating the audit's non-negotiable “read never writes” rule.

The first metadata write contains both rows and points at the new one. Cleanup
deletes the `.bak` first because it is an otherwise unmanaged credential copy,
then the old config, then its metadata row. Removing the row first would lose the
only crash-retry locator; deleting either file before the pointer pivot would
recreate the original dangling-selection bug.

## The `.bak` is a security obligation

`atomicReplaceDesktopConfig` copies the prior profile to `<id>.json.bak`
(`src/claude/desktop-3p.ts:371-380`), and the profile contains
`inferenceGatewayApiKey`. Nothing removes it today (`002:13-15`). A successful
disable MUST end with both old `<id>.json` and `<id>.json.bak` absent. A response
cannot say success when either remains: return `cleanup_incomplete`, include only
residual file paths, keep desired OFF, and keep the old metadata row as the retry
locator. Never include file contents, parsed credential fields, or credential
values in logs, errors, tests, screenshots, or the API envelope.

## Auto-apply suppression

The located automatic caller is `PUT /api/subagent-models`: after saving and two
other refreshes, it awaits `autoApplyDesktopBestEffort()`
(`agent-settings-routes.ts:518-528`). Its current guard checks only
`desktopAutoApply === false` before `fetchAllModels` (`:130-151`). Persisting OFF
first prevents later calls; a second check after the await closes the already
started in-process race:

```diff
 async function autoApplyDesktopBestEffort(): Promise<void> {
   try {
+    await runClientIntegrationFlight("claude-desktop", "auto-apply", async () => {
+      const initial = loadConfig();
+      const library = inspectDesktop3pConfigLibrary();
+      if (!clientIntegrationEnabled(initial, "claude-desktop")) return;
+      if (initial.claudeCode?.desktopAutoApply === false) return;
+      if (!initial.claudeCode?.desktopProfile) return;
+      // Auto-apply is reconciliation, not setup. Only explicit apply/enable may
+      // create a missing library or first owned profile.
+      if (library.kind === "not_installed" || library.kind === "no_owned_state"
+        || library.kind === "foreign") return;
@@
     const allModels = await fetchAllModels(initial);
     const routed = /* existing mapping */;
+      // The toggle can persist OFF while fetchAllModels was awaiting. Re-read
+      // persisted config immediately before the irreversible writer.
+      const permitWrite = requirePersistedClientIntent("claude-desktop", true);
+      if (!permitWrite.ok) return;
+      const beforeWrite = permitWrite.config;
+      if (beforeWrite.claudeCode?.desktopAutoApply === false) return;
+      if (inspectDesktop3pConfigLibrary().kind === "not_installed") return;
+      const result = writeDesktop3pConfig(/* values from beforeWrite */, {
+        beforeWrite: () => requirePersistedClientIntent("claude-desktop", true),
+      });
+      // Persist markers with mutatePersistedConfig, changing marker fields only.
+    });
```

If auto-apply has already entered the synchronous writer, JavaScript completes
that guarded write before the competing OFF flight can acquire the coordinator;
the later disable then pivots away and cleans it. If auto-apply is awaiting model
discovery and desired state changes through a non-overlapping committed path, the
last-moment guard stops it. The WP3 coordinator covers cooperating processes;
post-write status still detects Desktop/user/non-cooperating edits.

Replace `/api/claude-desktop/status`'s bookkeeping inference with the shared
read-only inspector. The old route makes `applied` equal
`savedFingerprint !== null` (`agent-settings-routes.ts:797-804`); that is the
stale-by-construction behavior being removed:

```diff
- const libraryPath = resolveDesktop3pConfigLibraryPath();
- /* first name === "opencodex" lookup + direct profile hash */
- const stale = savedFingerprint !== null && onDiskFingerprint !== null
-   && savedFingerprint !== onDiskFingerprint;
+ const persisted = loadConfig();
+ const observed = inspectDesktop3pConfigLibrary();
+ const desiredEnabled = clientIntegrationEnabled(persisted, "claude-desktop");
+ const savedFingerprint = persisted.claudeCode?.desktopProfile?.appliedFingerprint ?? null;
+ const applied = observed.kind === "gateway";
+ const fingerprintMatches = applied && savedFingerprint !== null
+   && observed.fingerprint === savedFingerprint;
+ const stale = applied && !fingerprintMatches;
+ const drift = desiredEnabled
+   ? !fingerprintMatches
+   : applied || observed.kind === "unsafe";
@@
 return jsonResponse({
+  desiredEnabled,
+  installed: observed.kind !== "not_installed",
+  observedKind: observed.kind,
+  applied,
   appliedAt,
   savedFingerprint,
+  onDiskFingerprint: observed.fingerprint,
+  configPath: observed.selectedProfilePath,
+  activeProfile: observed.selectedOwned,
   stale,
+  drift,
+  driftReason: !drift ? null
+    : observed.kind === "unsafe" ? observed.reason
+    : desiredEnabled ? "desired_on_not_current" : "desired_off_gateway_selected",
   health,
 });
```

There is no fallback to the first `name === "opencodex"` row. During interrupted
cleanup both rows have that name, and only `_meta.json.appliedId` identifies what
Desktop will read. If the selected row/file is missing, unreadable, non-object, or
has an invalid provider/credential combination, status is `unsafe`; it does not
hash an old non-selected profile and does not expose parsed contents. A selected
foreign row or valid standard profile is observed `applied:false` even if our
saved fingerprint remains. A selected valid gateway profile is `applied:true`;
only a matching saved fingerprint is current. That ordering makes fingerprint a
last corroborating check, never the source of observed state.

`desiredEnabled` drives the switch. `observedKind`, `applied`, `stale`,
`activeProfile`, and `drift` drive badge/count/detail. A user-selected foreign
profile, hand-edited gateway, deleted selected file, standard-mode pivot, and
desired-OFF/gateway-selected conflict therefore remain distinguishable instead of
collapsing into “applied because our marker exists.”

## GUI — one switch, one consequence dialog

`claudeDesktopRow` currently hard-codes `toggle: null`
(`gui/src/pages/integrations/overview-clients.ts:240-277`). Give it the native id
and a separate optional `toggleOn` so the summary count does not become desired
state by accident:

```diff
 export interface OverviewRow {
@@
   applied: boolean;
+  /** Desired switch position; absent means use observed `applied`. */
+  toggleOn?: boolean;
@@
 function claudeDesktopRow(
   payload: ClaudeDesktopPayload | null,
+  native: NativeStatus | undefined,
+  nativeSettled: boolean,
 ): OverviewRow {
@@
-    toggle: null,
-    toggleBlocked: null,
-    togglePath: null,
+    toggle: "claude-desktop",
+    toggleBlocked: native?.disableBlocked ?? null,
+    togglePath: native?.configPath ?? null,
+    toggleOn: native?.desiredEnabled,
```

`OverviewCard` renders `on={row.toggleOn ?? row.applied}`. The Desktop row is
unknown and non-actionable until both its rich status and native status settle.
Once settled, a missing/non-boolean `desiredEnabled` is a contract parse failure,
not permission to infer ON from `applied` or an old marker. The fallback in
`OverviewCard` remains for client rows that do not have a desired-state contract;
the Desktop row always supplies the required field.
Desired OFF + an actually selected gateway (or unsafe selected state) is amber,
not green; a stale marker beside a selected standard/foreign profile is not
treated as applied. Desired ON + no current selected gateway is absent/drifted
with the switch ON and `integrations.detail.desktopDesiredOnNotApplied`.

MODIFY `gui/src/pages/integrations/integration-api.ts` to consume the required
rich-status shape, without recreating the native union from WP3:

```diff
 export interface ClaudeDesktopPayload {
+  desiredEnabled: boolean;
+  installed: boolean;
+  observedKind: "not_installed" | "no_owned_state" | "standard"
+    | "gateway" | "foreign" | "unsafe";
   applied: boolean;
   stale: boolean;
+  drift: boolean;
+  driftReason: string | null;
@@
+  if (typeof value.desiredEnabled !== "boolean"
+    || typeof value.installed !== "boolean"
+    || typeof value.observedKind !== "string"
+    || typeof value.drift !== "boolean") return null;
```

`native-api.ts` is not modified to add `claude-desktop` or `desiredEnabled`: WP3
already shipped those, and WP5 has already added Codex detail. On that post-WP5
module, WP6 extends only the Desktop reasons; `residualPaths` is parsed through
WP3's existing envelope field:

```diff
 export type NativeRefusalReason =
   /* WP3 shared + WP5 Codex reasons */
+  | "unsafe_metadata"
+  | "cleanup_incomplete";
@@
 const NATIVE_REASONS = new Set<NativeRefusalReason>([
   /* existing post-WP5 values */
+  "unsafe_metadata",
+  "cleanup_incomplete",
 ]);
```

Add `DESKTOP_DISABLE_COPY` beside `GROK_DISABLE_COPY` and branch on
`pendingToggle.id`. Exact English source copy:

> **Disable Claude Desktop integration?**
>
> If `{path}` contains an opencodex-managed gateway profile, it will be updated to
> select a new credential-free opencodex profile with no inference provider, and
> the previous profile and backup will be removed. If no Claude Desktop library or
> managed profile exists, nothing will be created or removed.
>
> Claude Desktop will stop using models routed through opencodex and return to
> standard Claude.
>
> Turning it back on regenerates the opencodex profile from your saved model
> assignments. It cannot restore whichever profile was selected before
> opencodex was first applied.
>
> **Claude Desktop reads this configuration only at launch. Fully quit and reopen
> Claude Desktop for this change to take effect.**

Confirm label: **Disable**. The restart sentence is `sideEffectKey`, not a toast
added after confirmation: the user sees the delayed effect before choosing.
There is no claim that the current Desktop process switched instantly.

The refusal/partial copy is equally exact:

- `unsafe_metadata` — "Claude Desktop's metadata could not be read safely, so
  its library was not changed. The requested Off state was saved and automatic
  apply remains disabled. Repair `{path}/_meta.json`, then try again."
- `config_busy` — reuse the existing native lock copy: nothing was persisted and
  retry is appropriate.
- `cleanup_incomplete` — "Claude Desktop is pointed at standard mode, but old
  opencodex credential files remain at: `{paths}`. Remove them manually before
  treating cleanup as complete." This is a failed partial outcome, not a refusal
  pretending nothing changed.
- `write_failed` before the pointer pivot — use the server message and say no
  Desktop library change completed; desired OFF remains saved if step 1 passed.

On the Desktop page, consume required `desiredEnabled` from `DesktopStatus`; do
not add a second `enabled` alias. When false, the status bar
says: "Claude Desktop integration is off. Desktop reads configuration only at
launch; if it was open during the change, fully quit and reopen it." Save remains
available because assignments/defaults are intentionally preserved; Save + Apply
reads **Enable and apply** and goes through the explicit enable path.

## i18n

Add every key to exactly these six locale files:

```
gui/src/i18n/en.ts
gui/src/i18n/ko.ts
gui/src/i18n/ja.ts
gui/src/i18n/zh.ts
gui/src/i18n/de.ts
gui/src/i18n/ru.ts
```

Exact keys (English is the source of truth / `TKey`):

```text
integrations.dialog.desktop.title
integrations.dialog.desktop.changes
integrations.dialog.desktop.breakage
integrations.dialog.desktop.undo
integrations.dialog.desktop.restart
integrations.dialog.desktop.confirm
integrations.detail.desktopDesiredOff
integrations.detail.desktopDesiredOnNotApplied
integrations.detail.desktopSelectedElsewhere
integrations.detail.desktopProfileDrift
integrations.detail.desktopObservedUnsafe
integrations.detail.desktopNotInstalled
integrations.native.error.desktopUnsafeMetadata
integrations.native.error.desktopCleanupIncomplete
integrations.native.msg.desktopDisabled
integrations.native.msg.desktopEnabled
claudeDesktop.status.disabled
claudeDesktop.enableApply
```

`changes` interpolates `{path}`; `desktopUnsafeMetadata` interpolates `{path}`;
`desktopCleanupIncomplete` interpolates `{paths}`. Do not put a credential value
or profile JSON into any interpolation.

## Test plan

`tests/desktop-3p-removal.test.ts` uses
`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`/explicit options and `mkdtempSync`; it never
resolves the user's live library.

1. Point the path override at a child directory that does not exist. Inspector,
   native GET, rich status GET, and OFF each return `not_installed`/unchanged with
   required `desiredEnabled`; the child path remains absent after every call.
   Repeat with an existing empty library and no `_meta.json`: OFF is a no-op and
   creates neither metadata nor a profile. Explicit apply is the first operation
   allowed to create them. Finally persist desired OFF beside an existing selected
   gateway and call both GETs: they report drift but every Desktop-library byte and
   mtime remains unchanged; only startup/ensure/explicit OFF may converge it.
2. Normal disable of an existing selected gateway writes a fresh UUID `{}` profile, verifies it is readable,
   points `appliedId` to it, removes only the old opencodex row, and preserves
   unrelated rows/top-level fields.
3. **Dangling Default fixture:** `_meta.json` contains `Default`, but its
   `<id>.json` does not exist. Disable neither selects nor changes that row; the
   selected fresh standard file exists. This reproduces the real-machine fact.
4. The replacement JSON has no `inferenceProvider`,
   `inferenceGatewayApiKey`, or other credential field. Do not assert by printing
   values; assert key absence.
5. The old `<id>.json.bak` exists before removal and is absent after. This is a
   mandatory security assertion, not incidental cleanup. The old `<id>.json` is
   also absent.
6. Crash fixtures resume from every table row above: selected standard + both old
   files; backup gone; both files gone + old row present; markers handled at the
   route layer. Every retry removes locatable old credential files and leaves one
   selected standard row. The pre-metadata orphan case explicitly permits the one
   unlocatable credential-free orphan documented above.
7. Metadata malformed, path-escaping id, and two non-selected opencodex cleanup
   rows each REFUSE `unsafe_metadata` without a Desktop-library write.
8. Injected delete failure returns `cleanup_incomplete`, keeps the old row as
   locator, reports residual paths only, and leaves selected standard readable.
9. Idempotent retry from a selected standard profile allocates no second profile.
10. Re-enable prefers the selected standard row, overwrites it through the normal
   gateway writer, and does not revive an old interrupted-cleanup id.
11. Inspector fixtures cover selected foreign, selected standard, valid gateway,
    edited gateway fingerprint drift, selected file deleted, invalid provider /
    credential shape, and malformed metadata. It returns only classification,
    paths, and hashes—never profile contents or credential values.

`tests/native-claude-desktop-toggle.test.ts` follows the injected-persist seam in
`tests/native-claude-code-toggle.test.ts:18-43`:

1. Absent WP3 key reads desired ON; every status/success fixture includes the
   required `desiredEnabled` field, including not-installed and no-op OFF.
2. Disable field-scoped-patches desired false and `desktopAutoApply:false` through
   `mutatePersistedConfig` before the remover
   seam is called; a spy records call order.
3. Successful cleanup clears only `appliedFingerprint`/`appliedAt` and preserves
   all assignments/defaults (include 33 assignments to pin the observed scale).
4. `unsafe_metadata` leaves desired OFF persisted and markers intact, returning
   409 with the typed refusal.
5. Cleanup partial returns 500, residual paths, selected-standard state, desired
   OFF, and no false success.
6. Config `SQLITE_BUSY` refuses before any Desktop mutation; broken lock is 500.
7. A competing persisted update to another `claudeCode` field between read and
   commit survives disable, enable, POST apply, and marker cleanup. This proves
   field-scoped rebasing rather than whole-subtree replacement.
8. Explicit POST apply paused before its writer, then a competing OFF arrives on
   the same per-client flight. The competitor is typed-refused; no ON/OFF overlap
   occurs and maximum concurrent Desktop mutators is one. Repeat with native
   enable versus OFF and from a second process against WP3's SQLite coordinator.
9. Auto-apply that is paused in `fetchAllModels`, then disabled, hits the second
   guard and never calls `writeDesktop3pConfig`. This activates the race fix at
   `agent-settings-routes.ts:137-139`, not merely its first guard.
10. Enable and explicit POST apply persist desired true, keep assignments/defaults,
   regenerate the gateway profile, and record markers only after write success.
11. Persist OFF, stop before invoking the remover, then run WP3 startup
    reconciliation. It enters the same flight, re-runs removal, and converges the
    selected gateway to standard mode. Repeat every partial state in the table;
    no retry creates a library when none exists.
12. Rich status derives observation from selected id + selected file + parsed
    provider/credential shape before fingerprint. Changing selection, deleting or
    editing the selected file, and selecting standard mode all change observed
    status while the saved marker stays constant; desired state does not change.

MODIFY `tests/claude-messages-endpoint.test.ts`: start from Claude Code enabled,
perform the Desktop disable PUT against a temp config library, then send a valid
Claude Code `/v1/messages` request through the same test server. Assert it reaches
the existing transport/adapter path rather than 403/404. Also assert the proxy
health endpoint still responds. This is the C4 proof that Desktop OFF does not
shut down the shared transport.

GUI cases:

- `integrations-overview-rows.test.ts`: switch uses desired state while badge and
  applied count use observed state; OFF + gateway selected, ON + foreign selected,
  edited/deleted selected profile, and standard mode each show explicit drift.
  `not_installed` is not rendered as applied and no missing `desiredEnabled` is
  silently inferred from bookkeeping.
- `integrations-surfaces.test.tsx`: Desktop card has a keyboard-operable switch;
  disable opens the Desktop—not Grok—dialog; all five paragraphs render in order;
  confirm calls `/api/native-integrations/claude-desktop`; restart-required text
  is visible before confirm; focus returns to the switch.
- `claude-desktop-locale.test.ts`: all 18 keys exist and are non-empty in all six
  locales.

## Verification

Implementation C-gate commands:

```bash
bun run typecheck
bun test --isolate tests/desktop-3p-removal.test.ts tests/native-claude-desktop-toggle.test.ts tests/claude-messages-endpoint.test.ts tests/claude-management-api.test.ts
bun run test
bun run privacy:scan
cd gui && bun test tests
cd gui && bun run lint
cd gui && bun run lint:i18n
cd gui && bun run build
```

Render grounding: open the Integrations overview in the real dashboard, activate
the Desktop OFF switch with keyboard, screenshot the open dialog at desktop and
constrained width, read the screenshot back, and verify the restart sentence is
visible before confirmation. In browser QA, point the server at a temporary
`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR`; do not confirm against the live daemon.

Real-machine proof is deliberately read-only. It may parse only
`configLibrary/_meta.json` to report row names/ids and `existsSync(<id>.json)`
booleans, confirming the known dangling `Default` shape and that path resolution
targets the installed Desktop library. It must not open or print any profile or
`.bak` contents. All destructive activation proof runs against `mkdtempSync` on
the same machine. Do **not** call the live PUT endpoint, remover, `unlink`, or
apply route against the user's real Desktop library; that would change the active
selection and delete credential-bearing files without separate approval.

## Accept criteria

- **C7** (`000_plan.md:91-92`) — after a successful disable, `_meta.json.appliedId`
  names a present, readable `{}` profile with no `inferenceProvider` or credential
  fields and the previous opencodex `<id>.json`/`.bak` are absent **when an owned
  gateway existed**. If no library/metadata/owned row existed, successful OFF is
  unchanged and creates nothing. The dangling-Default fixture proves no `Default`
  assumption entered either path.
- **C4** (`000_plan.md:86-87`) — disable does not stop/restart the proxy and does
  not change `claudeCode.enabled`; a Claude Code request still traverses
  `/v1/messages` after Desktop is disabled, and proxy health remains live.
- Desired OFF and `desktopAutoApply:false` are durable before the Desktop write;
  startup reconciliation re-runs the idempotent remover after a crash, and every
  partial-state fixture states exactly what the retry removes, preserves, or
  refuses. A failed/partial mutation reports desired OFF versus observed residue
  rather than silently re-enabling.
- Native/rich status is read-only and derives observation from selected id,
  selected-file existence, parsed provider/credential shape, then fingerprint.
  Desired state is required separately on every status/success/post-commit
  refusal; changing Desktop state behind opencodex surfaces drift immediately.
- Auto-apply, POST apply, native enable, native disable, and startup OFF
  reconciliation share WP3's `claude-desktop` flight and re-read persisted desired
  state immediately before each irreversible Desktop write. Persistence uses
  `mutatePersistedConfig` field patches, so unrelated `claudeCode` fields survive.
- Assignments/defaults survive disable and enable byte-semantically as parsed
  data; only `appliedFingerprint`/`appliedAt` are cleared after complete cleanup.
- The dialog states before confirmation that a full Desktop quit/reopen is
  required. No UI or API claims the running Desktop process changed instantly.
