# wp3 — CLI and management contract merge, docs, generated surfaces

Diff-level design. Depends on wp2 (`010`) and wp5 (`020`).

## 1. The flag contract, before and after

| Flag | Before | After |
|---|---|---|
| `--restart-codex` | SIGTERM to matching app-server / code-mode-host processes only | app-server restart **and** a full desktop-app quit + relaunch, all platforms |
| `--restart-desktop-app` | Windows-only opt-in, never implied | deprecated alias of `--restart-codex`, prints a deprecation line |
| `--restart-app-server-only` | — | NEW: the old `--restart-codex` behaviour |

Nobody loses a capability. The narrow scope moves to a flag that names it, which is
better than the old arrangement where the narrow scope was the unnamed default and
the wide scope needed a flag.

## 2. Ordering: do not interrupt the same turn twice

`001` §1.1 and §2.1 measured the app-server as a **child of the desktop app** on both
macOS (`16733` under `15901`) and Linux (`3285204` under `3284901`). Running the
existing app-server pass and then the desktop restart therefore signals the same
process twice: SIGTERM to the app-server, the app respawns it, then the whole app is
quit. The operator's in-flight turn is interrupted, recovered, and interrupted again.

So when a desktop restart is going to run, app-servers that are **members of the
discovered desktop tree** are excluded from the SIGTERM pass. Quitting the app
terminates them anyway. Standalone app-servers — the npm `codex app-server` pair that
`devlog/_plan/260826_restart_codex_linux_survivor/000_repro_and_root_cause.md`
documents, and SSH bootstraps — are not members and are still signalled.

`afterCatalogWriteHandleAppServers` gains one option:

```ts
export interface AfterCatalogWriteAppServerOptions {
  restart: boolean;
  log?: Pick<Console, "log" | "error"> | null;
  io?: CodexAppServerProcessIo;
+ /** Pids already covered by a desktop-app restart in this same command. */
+ excludePids?: readonly number[];
}
```

The caller computes the exclusion by asking the wp2 module to enumerate without
acting. `010` §2 already exposes what that needs; wp3 adds the thin read-only entry:

```ts
export function listCodexDesktopAppPids(io?: DesktopAppRestartIo): number[] | null;
```

`null` (discovery or probe failure) means **no exclusion** — falling back to the old
behaviour of signalling everything, which is the safe direction: a missed exclusion
costs an extra interruption, a wrong exclusion leaves a stale app-server alive.

**`excludePids` can go stale (nit N7).** Between enumeration and the signal pass, a
listed pid can exit and be recycled into a standalone app-server, which would then
escape signalling because its pid is on the exclusion list. The window is short and
the cost is one stale app-server rather than a wrong kill. `restartCodexAppServers`
already re-resolves pid+command-line identity immediately before signalling
(`src/codex/app-server-processes.ts:1146-1154`), so a recycled pid is never
*signalled* on a stale identity. Only the skip can be wrong, never the kill.

## 3. `src/cli/dispatch.ts` (MODIFY)

### 3.1 Flag parsing, `sync` (currently lines 381-384)

```ts
-    const restartCodex = syncArgs.includes("--restart-codex");
-    // Separate flag on purpose: --restart-codex promises app-server-only scope,
-    // and quitting the desktop app ends live conversations.
-    const restartDesktopApp = syncArgs.includes("--restart-desktop-app");
+    const restartScope = readRestartScope(syncArgs, console);
```

with one shared helper so `sync`, `sync-cache` and `catalog pull` cannot drift:

```ts
export interface RestartScope {
  /** Signal matching app-server / code-mode-host processes. */
  appServers: boolean;
  /** Fully quit and relaunch the Codex desktop app. */
  desktopApp: boolean;
}

export function readRestartScope(
  args: readonly string[],
  log: Pick<Console, "error">,
): RestartScope {
  const appServerOnly = args.includes("--restart-app-server-only");
  const legacyDesktop = args.includes("--restart-desktop-app");
  const restartCodex = args.includes("--restart-codex");
  if (legacyDesktop) {
    log.error(
      "--restart-desktop-app is deprecated: --restart-codex now restarts the Codex "
      + "desktop app on every platform. The flag still works and will be removed in a "
      + "future release.",
    );
  }
  if (appServerOnly && (restartCodex || legacyDesktop)) {
    // Contradictory scopes. The narrower one wins: a user who typed the
    // app-server-only flag asked not to lose their conversations.
    log.error(
      "--restart-app-server-only overrides --restart-codex/--restart-desktop-app; "
      + "the desktop app was left running.",
    );
    return { appServers: true, desktopApp: false };
  }
  if (appServerOnly) return { appServers: true, desktopApp: false };
  if (restartCodex || legacyDesktop) return { appServers: true, desktopApp: true };
  return { appServers: false, desktopApp: false };
}
```

The contradiction resolution is the narrow scope on purpose. Losing live
conversations is unrecoverable; a stale model picker is not.

### 3.2 Post-write handling (currently lines 437-438, 517-518, 1023-1028)

```ts
-      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
-      if (restartDesktopApp) await handleDesktopAppRestart(console);
+      await handleRestartScopeAfterWrite(restartScope, console);
```

### 3.3 The helper returns its outcome (audit B6)

`catalog pull` derives its JSON envelope from the restart result
(`src/cli/catalog.ts:65-93`), so a `void` helper cannot serve it:

```ts
export interface RestartScopeOutcome {
  appServers?: AfterCatalogWriteAppServerResult;
  desktopApp?: DesktopAppRestartResult;
}

async function handleRestartScopeAfterWrite(
  scope: RestartScope,
  log: Pick<Console, "log" | "error">,
): Promise<RestartScopeOutcome> {
  const excludePids = scope.desktopApp ? (listCodexDesktopAppPids() ?? []) : [];
  const appServers = afterCatalogWriteHandleAppServers({
    restart: scope.appServers, log, excludePids,
  });
  const desktopApp = scope.desktopApp ? await handleDesktopAppRestart(log) : undefined;
  return { appServers, desktopApp };
}
```

`handleDesktopAppRestart` therefore returns the `DesktopAppRestartResult` it already
switches on, instead of `void`.

All four call sites collapse to this one helper, which is what makes the
source-oracle assertion in §6 checkable in one place instead of four.

### 3.4 `catalog pull` joins the merged contract (audit B4)

`src/cli/catalog.ts` was missing from the first draft. It is a fourth
`afterCatalogWriteHandleAppServers` call site, and its `knownFlags` set is **closed**,
so the new flags would be rejected as `code: "usage"` rather than ignored.

| Location | Change |
|---|---|
| `src/cli/catalog.ts:24` | parse through `readRestartScope` instead of a local `includes` |
| `src/cli/catalog.ts:31` | `knownFlags` gains `--restart-desktop-app` and `--restart-app-server-only` |
| `src/cli/catalog.ts:41` | usage string lists the three flags |
| `src/cli/catalog.ts:65` | call `handleRestartScopeAfterWrite` |
| `src/cli/catalog.ts:5-14` | `CatalogPullEnvelope` gains optional `desktopAppRestarted?: boolean` |
| `src/cli/registry.ts:148` | `catalog pull` usage line |
| `src/cli/help.ts:49` | `catalog pull` usage line |

`codexRestarted` keeps its current meaning — app-servers only — and the desktop
outcome gets its own optional field, so a script reading the existing field is not
silently handed a different answer. The field is emitted only when a desktop restart
was requested, which keeps `schemaVersion: 1` honest.

`desktopAppRestarted` is `true` only for `relaunch: "started"`. Every other outcome —
`restart_in_flight`, `targets_survived`, `relaunch_failed`, `self_ancestry`,
`handoff_started` — is `false`, because none of them left a restarted app behind. A
handoff in particular is **not** a success: the restart has not happened yet when the
envelope is written, and a script that read `true` there would proceed on a promise.

The docs currently say desktop restart is not part of this command, in English plus
`zh-cn`, `zh-tw`, `tr` and `ru`. `002` §B4 records why that is reversed: it is a scope
statement about a capability that did not exist cross-platform, not the consent
decision that split the `sync` flags.


### 3.5 `handleDesktopAppRestart` messages (currently lines 977-1017)

```ts
-    case "windows_only":
-      log.error("--restart-desktop-app is supported on Windows only; nothing was stopped.");
-      return;
+    case "unsupported_platform":
+      log.error(
+        `Restarting the Codex desktop app is not supported on ${process.platform}; `
+        + "app-servers were still restarted.",
+      );
+      return;
+    case "handoff_started": ...        // see 020 §7
+    case "restart_in_flight":
+      log.error(
+        "Another Codex desktop-app restart is already running; this one did nothing. "
+        + "Wait for it to finish and check again.",
+      );
+      return;
+    case "relaunch_failed":
+      log.error(
+        "The Codex desktop app was stopped but could not be started again. "
+        + "Launch it manually.",
+      );
+      return;
```

and the `self_ancestry` text drops its `--restart-desktop-app` reference, since a
handoff now happens instead and the refusal only survives for the helper itself.

## 4. `ocx system codex-restart` (MODIFY)

`src/codex/app-server-restart-service.ts` runs the desktop restart after its
app-server pass, using the same exclusion from §2. The contract in
`src/lib/codex-restart-contract.ts` gains one **optional** field:

```ts
+export interface CodexDesktopRestartSummary {
+  attempted: boolean;
+  stopped: number[];
+  surviving: number[];
+  relaunch: "started" | "skipped";
+  reason?: string;
+}

 export interface CodexRestartResponse {
   ...
+  /** Absent on a proxy older than this change. */
+  desktopApp?: CodexDesktopRestartSummary;
 }
```

Optional, not required, because `isCodexRestartResponse` is a **version-skew guard**
consumed by the GUI: a dashboard talking to an older proxy must keep working. The
guard validates the field's shape and its own cross-field invariants when present
(`relaunch === "started"` implies `surviving` is empty) and ignores it when absent.

`scalar-only` still holds: pid arrays and a closed-vocabulary reason string, never a
command line, a path or an OS error message.

`reason` carries the `DesktopAppRestartReason` value verbatim, which is what keeps it
a closed vocabulary rather than free text — `restart_in_flight` included.

### 4.2 The service refuses instead of handing off (re-audit blocker 2)

`performCodexRestart` runs **inside the long-lived proxy process**, not in a
short-lived CLI. The wp5 handoff is built on "wait for the calling pid to exit"
(`020` §4.2), and a proxy does not exit. If the proxy were inside the desktop tree,
every handoff it started would sit out its 20-second window and end in
`caller_still_running` — after the operator had already been told the restart was
handed off.

So the service passes `allowHandoff: false`. When it is inside the tree it reports
`self_ancestry` and says what to do instead:

```
"The proxy is running inside the Codex app, so restarting the app from here would
 kill this request. Run 'ocx sync --restart-codex' from a terminal instead."
```

An honest refusal beats a promise the architecture cannot keep.

**This is not the normal case.** Measured on the maintainer's machine while writing
this: the proxy listening on :10100 is pid 60304, whose parent chain is
`bun -> node -> launchd` with no `ChatGPT.app` process in it, while the app root is
pid 15901. A proxy installed as a service sits outside the app tree, so the service
path performs the restart directly and `000` §7 is satisfied. The refusal covers the
case where someone started the proxy from a shell inside the app — a real thing
developers do, and a bad thing to mishandle silently.
### 4.1 The wire `restartCodex` field does not change meaning (audit B5)

`POST /api/machine/sync` accepts a `restartCodex` boolean from a remote hub
(`src/client/machine-api.ts:79-95`) and hands it to `syncConnectedClient`, which
deliberately ignores it (`src/client/connect.ts:649-650`). The desktop restart on the
connected path is performed **locally**, by the CLI, in
`handleConnectedSyncCatalogWrite` (`src/cli/dispatch.ts:1023-1028`).

That stays exactly as it is. The wire field keeps app-server-only semantics and
remains unhonored. A remote hub must not end a local user's conversations because a
field name acquired a wider meaning underneath it — the maintainer instruction in
`000` §4 widens a **local CLI flag** and says nothing about remote callers. Version
skew sharpens the argument: an older hub that never heard of this change would be
sending a boolean whose meaning silently grew.

Pinned by a regression test rather than a comment, because the realistic failure is a
future contributor "finishing" a parameter that looks obviously unused: the
machine-sync route must never reach `restartCodexDesktopApp`.
`tests/clients/client-machine-listener.test.ts:206` already exercises the route.

**The GUI is deliberately not changed.** `gui/src/codex-restart.ts`,
`use-codex-restart.ts` and `components/codex-stale-banner.tsx` keep rendering the
app-server outcome and ignore the new optional field. Surfacing the desktop result in
the dashboard is a separate, purely presentational unit with its own design and
screenshot obligation; folding it in here would widen a process-termination change
into a UI change and drag the `enforce-target` screenshot gate onto a PR whose risk
is entirely in process handling. Making the field optional is what allows that split.

## 5. Text surfaces (MODIFY)

| File | Change |
|---|---|
| `src/cli/registry.ts:128-143` | usage gains `[--restart-app-server-only]`; the "(Windows only, opt-in)" and "Never implied by --restart-codex" sentences are replaced by the merged contract |
| `src/cli/capabilities.ts:788-789` | `--restart-codex` summary widened; `--restart-desktop-app` marked deprecated; `--restart-app-server-only` added |
| `src/cli/capabilities.ts:712-722` | `system codex-restart` details: it now restarts the desktop app too |
| `src/cli/help.ts:46-47` | one-line usage refresh |
| `src/codex/app-server-processes.ts:19-21` | `STALE_CODEX_APP_SERVER_HINT` drops the Windows sentence and names one flag |
| `src/codex/app-server-processes.ts:565-567` | `formatStaleCodexAppServerWarning` likewise |
| `src/cli/doctor.ts:1369` | WARN action collapses to `ocx sync --restart-codex` |
| `src/codex/desktop-app-restart.ts:2` | module header rewritten: cross-platform, and why the flags merged |

`warnIfStaleCodexAppServersAfterStartupWrite` (`src/codex/app-server-processes.ts:1245`)
consumes the same hint strings but stays **warn-only** and never gains a restart
(nit N14). Its reason for existing is that an unattended startup is not consent to
interrupt a turn, and this unit does not touch that argument.

## 6. Tests to rewrite

Two assertions encode the contract being reversed and must be inverted, not deleted.
Deleting them would leave the new guarantee unenforced.

**`tests/codex-integration/codex-app-server-processes.test.ts:726-739`** —
`"--restart-desktop-app is a separate opt-in that --restart-codex never implies (#2292)"`.
It reads `src/cli/dispatch.ts` as text and asserts the handlers contain
`includes("--restart-desktop-app")`, match `/if \(restartDesktopApp\) await handleDesktopAppRestart\(...\)/`,
and do **not** contain `restartDesktopApp = restartCodex`.

Replaced by `"--restart-codex restarts the desktop app on every platform (#2292 follow-up)"`,
asserting on the same source text that both handlers route through
`handleRestartScopeAfterWrite`, that the write gate still precedes it, and that
`--restart-app-server-only` is the only path producing `desktopApp: false`.

**`tests/clients/desktop-app-restart.test.ts:57-62`** — darwin returns
`reason: "windows_only"` with zero `execFile` calls. Replaced by a case asserting
darwin now discovers, and an `unsupported_platform` case on a platform with no
adapter.

The other 15 cases in that file stay: they encode fail-closed discovery, the
PID-reuse re-verification, current-user scoping, bounded probe timeouts and the
`process_probe_failed` vs `no_targets` distinction — all of which the shared ladder
must keep satisfying on Windows.

New coverage lands in `tests/clients/desktop-app-restart-posix.test.ts`. The
`clients` domain seed in `scripts/test-layout/layout.json` is
`^(?:desktop|omp|pi|prime|remote|sync)-`, so a `desktop-`prefixed file in
`tests/clients/` resolves without an `explicit` entry — and therefore needs no
matching addition to `tests/fixtures/test-layout-expected.json`.

If anyone adds an `explicit` entry later it must go into **both** tables:
`tests/test-layout-tooling.test.ts:250` asserts `layout.explicit` equals the fixture
exactly, so a half-entry fails the gate (nit N15).

New tests this phase owes, beyond the two rewrites above:

- `readRestartScope`: each flag alone, the deprecation line, and the contradiction
  case where `--restart-app-server-only` beats `--restart-codex`.
- The machine-sync route never triggers a desktop restart (§4.1).
- `catalog pull` accepts the new flags instead of returning `code: "usage"`.
- The handoff singleton lock refuses a second concurrent restart (`020` §4.1).

## 7. Documentation

English, hand-written, heaviest edit in
`docs-site/src/content/docs/reference/cli/lifecycle.md:264-333` — including line 315,
"it has no Windows `--restart-desktop-app`", which becomes false. Also
`reference/cli/agents.md:346`, `reference/management-api.md:440`,
`guides/codex-integration.md:734`, `guides/factory-droid.md:148`.

Locales that exist and mention `--restart-codex`: `fr`, `ja`, `ko`, `ru`, `tr`,
`zh-cn`, `zh-tw`. Only the English lifecycle reference ever named
`--restart-desktop-app`, so the locale work is a semantic update of the
`--restart-codex` description in each, not a new section. The repository rule is that
translations must not contradict the English source; leaving seven locales saying
"app-server only" would do exactly that.

One correction from the audit: `zh-cn`, `zh-tw`, `tr` and `ru` **do** carry the
`catalog pull` desktop-restart exclusion sentence (zh-cn's
"Desktop 应用重启不属于此命令", for example). Those four pages need that sentence removed
as well as the `--restart-codex` description updated, so the locale edit is not
uniform across the seven.

## 8. Generated surfaces

`skills/ocx/references/01_management_surface.md` is generated from
`src/cli/capabilities.ts` by `bun run skill:surface`, and
`tests/ci-workflows/skill-ocx.test.ts` fails if the committed file drifts. It is
regenerated, never hand-edited.

This is a code generator, not a product test, build, typecheck or install, so running
it does not breach `000` §2. It is required for correctness: the committed artifact
must match its source or CI fails.

`structure/INDEX.md` is regenerated only if a `structure/` document changes. No
`structure/` file references these flags today; if the new `src/codex/desktop-app/`
directory needs an ownership note, `bun run structure:index` follows the edit.
