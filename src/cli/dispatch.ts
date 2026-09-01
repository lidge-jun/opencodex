/**
 * Registry-driven command dispatch (Phase 3 of the CLI deepening).
 *
 * The command switch moved out of src/cli/index.ts into a runner table keyed
 * by command name. Aliases resolve through the registry's alias pairs
 * (init/setup, restore/eject, uninstall/remove, models/model); the registry
 * remains the single source of command metadata. index.ts passes its local
 * helpers (start/stop/ensure/status/...) through CliDispatchDeps so dispatch
 * never needs to import the entry module back (no cycle).
 */
import { CLI_COMMANDS } from "./registry";
import { isValidProviderName } from "../config/provider-name";
import type { CliHead } from "./root";
import type { ReadyArgs } from "./ready";
import type { LivenessIo, LiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { hasHelpFlag, printSubcommandUsage, printUsage } from "./help";
import { setIntegrationEnabled, shouldSyncCodexOnStart } from "../codex/desired-state";
import { syncModelsToCodex } from "../codex/sync";
import { collectOrcaCodexHomeDiagnostic } from "../codex/home";
import { restoreNativeCodexAsync } from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import { afterCatalogWriteHandleAppServers } from "../codex/app-server-processes";
import { normalizeUpdateChannel, runGuiUpdateWorker } from "../update/job";
import { isJsonOption, takeFlag } from "./runtime-api";
import type { ClientConnectionState } from "../client/state";

export interface CliDispatchDeps {
  args: string[];
  command: string | undefined;
  head: CliHead;
  loadConfig: () => OcxConfig;
  findLiveProxy: (io?: LivenessIo) => Promise<LiveProxy | null>;
  probeHostname: (hostname: string | undefined) => string;
  waitForProxy: (timeoutMs?: number) => Promise<LiveProxy | null>;
  startArgv: (port?: number) => string[];
  /** Spawn a detached proxy child (stdio ignore, unref'd, provenance env). */
  spawnDetached: (argv: readonly string[]) => void;
  handleStart: () => Promise<void>;
  handleStop: () => Promise<boolean>;
  handleEnsure: (options?: { existingIsSuccess?: boolean }) => Promise<boolean>;
  handleTrayProxyStart: (existingIsSuccess?: boolean) => Promise<boolean>;
  handleTrayProxyRestart: () => Promise<void>;
  handleRestartStartWhenStopped: () => Promise<boolean | "skipped">;
  handleProxyRestart: (startWhenStopped: () => Promise<boolean | "skipped">) => Promise<boolean>;
  handleUninstall: () => Promise<void>;
  handleStatus: () => Promise<void>;
  handleRecoverHistory: () => Promise<void>;
  handleReady: (args: ReadyArgs) => Promise<number>;
  serviceCommand: (...args: string[]) => Promise<void>;
}

type CommandRunner = (deps: CliDispatchDeps) => Promise<number>;

const commandRunners: Record<string, CommandRunner> = {
  init: async () => {
    const { runInit } = await import("./init");
    await runInit();
    // runInit sets process.exitCode = 1 on stdin EOF/closed; preserve it.
    return Number(process.exitCode ?? 0);
  },
  start: async deps => {
    const { readClientConnectionState } = await import("../client/state");
    const clientState = readClientConnectionState();
    await reconcileClientJournalBeforeLifecycle(clientState);
    if (clientState.kind === "invalid" || clientState.kind === "mismatched") {
      console.error(`Client state is ${clientState.kind}: ${clientState.reason}`);
      return 1;
    }
    await deps.handleStart();
    return Number(process.exitCode ?? 0);
  },
  stop: async deps => {
    // Downtime warning lives HERE, not in handleStop: `restart`/tray-restart callers
    // re-start the proxy immediately, so warning there would contradict the next line.
    if (await deps.handleStop()) {
      console.log("⚠️  Codex/Claude requests through the proxy will fail until it is restarted ('ocx start' or 'ocx service start').");
    }
    return Number(process.exitCode ?? 0);
  },
  restore: async deps => {
    const restoreArgs = deps.args.slice(1);
    const restoreJson = takeFlag(restoreArgs, "--json");
    if (restoreArgs[0] === "back") {
      // Reverse switch: re-point plain `codex` at the RUNNING proxy without touching its
      // lifecycle — the counterpart of `ocx restore`. Start/stop triggers are unchanged;
      // this only re-runs the same inject (config + catalog + history) `ocx start` does.
      // takeFlag above makes `ocx restore --json back` restore-back, not eject.
      const { skippedRestoreEnvelope } = await import("../codex/inject");
      const emitBack = (success: boolean, message: string, code: number): number => {
        if (restoreJson) console.log(JSON.stringify(skippedRestoreEnvelope(success, message)));
        else if (code === 0) console.log(message);
        else console.error(message);
        return code;
      };
      const live = await deps.findLiveProxy();
      if (!live) {
        return emitBack(false, "No running proxy found. Run 'ocx start' — it injects opencodex automatically.", 1);
      }
      const desired = setIntegrationEnabled("codex", true);
      if (!desired.ok) {
        return emitBack(false, `Codex desired state was not saved (${desired.reason}).`, desired.reason === "conflict" ? 2 : 1);
      }
      const synced = await syncModelsToCodex(live.port);
      if (synced.status === "skipped") {
        return emitBack(false, "Codex integration is OFF; restore back did not change Codex. Retry after the competing integration change finishes.", 2);
      }
      if (!synced.ok) {
        return emitBack(false, "Plain `codex` was not switched back to opencodex. Fix the reported Codex config issue and retry.", 1);
      }
      const target = collectOrcaCodexHomeDiagnostic();
      return emitBack(true, `Plain \`codex\` now routes through opencodex in ${target.effectiveCodexHome} (undo with: ocx restore).`, 0);
    }
    const desired = setIntegrationEnabled("codex", false);
    if (!desired.ok) {
      if (restoreJson) {
        // Machine-readable contract: every restore --json outcome emits one
        // schema-complete envelope on stdout, including pre-machinery failures.
        const { skippedRestoreEnvelope } = await import("../codex/inject");
        console.log(JSON.stringify(skippedRestoreEnvelope(false, `Codex desired state was not saved (${desired.reason}).`)));
      } else {
        console.error(`Codex desired state was not saved (${desired.reason}).`);
      }
      return desired.reason === "conflict" ? 2 : 1;
    }
    // A repeated OFF on an already-clean home is a policy no-op. Do not enter
    // restore's native-profile machinery merely to prove there is nothing to
    // restore: those locks live in CODEX_HOME and a skip must create nothing.
    if (desired.status === "unchanged") {
      const { classifyNativeRoutedResidue } = await import("../codex/native-residue");
      if (classifyNativeRoutedResidue().kind === "clean") {
        // The Codex half being a no-op says nothing about the Grok half. Returning here
        // without stripping the fence meant `ocx restore` could report success while Grok
        // still pointed at a stopped proxy — and the deferred-teardown recovery path
        // (#3008) tells operators to run exactly this command before deleting a receipt,
        // so the incomplete teardown would be signed off and the obligation erased.
        let grokNote = "";
        let grokCode = 0;
        try {
          const g = stripGrokConfig();
          if (g.changed) grokNote = ` ${g.message}`;
          else if (!g.ok) { grokNote = ` Grok config cleanup failed: ${g.message}`; grokCode = 1; }
        } catch (err) {
          grokNote = ` Grok config cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
          grokCode = 1;
        }
        const alreadyOff = `Codex integration is already OFF and native; no Codex files changed.${grokNote}`;
        if (restoreJson) {
          const { skippedRestoreEnvelope } = await import("../codex/inject");
          console.log(JSON.stringify(skippedRestoreEnvelope(grokCode === 0, alreadyOff)));
        } else if (grokCode === 0) {
          console.log(alreadyOff);
        } else {
          console.error(alreadyOff);
        }
        return grokCode;
      }
    }
    let r: { success: boolean; message: string };
    try {
      r = await restoreNativeCodexAsync({ revalidateDesiredState: true });
    } catch (err) {
      r = { success: false, message: err instanceof Error ? err.message : String(err) };
    }
    // Grok BEFORE either output. The JSON path used to return here, so `ocx restore --json`
    // (and `ocx eject --json`, the same runner) could report success while the fence still
    // pointed at the stopped proxy — and the deferred-teardown recovery on this branch
    // tells operators to run exactly this before deleting a receipt (#3008).
    let grokFailure: string | null = null;
    let grokChangedMessage: string | null = null;
    try {
      const g = stripGrokConfig();
      if (g.changed) grokChangedMessage = g.message;
      else if (!g.ok) grokFailure = g.message;
    } catch (err) {
      grokFailure = err instanceof Error ? err.message : String(err);
    }
    if (restoreJson) {
      // Spawned callers need the artifact-level result to distinguish a busy
      // history worker from a successful native restore. Keep stdout machine
      // readable — the Codex artifact schema is unchanged; the Grok outcome is
      // folded into success/message so a caller cannot read a half teardown as done.
      const message = grokFailure
        ? `${r.message} Grok config cleanup failed: ${grokFailure}`
        : grokChangedMessage ? `${r.message} ${grokChangedMessage}` : r.message;
      console.log(JSON.stringify({ ...r, success: r.success && !grokFailure, message }));
      return r.success && !grokFailure ? 0 : 1;
    }
    if (r.success) console.log(`✅ ${r.message}`);
    else {
      console.error(`⚠️  ${r.message}`);
    }
    let code = r.success ? 0 : 1;
    if (grokChangedMessage) console.log(`✅ ${grokChangedMessage}`);
    if (grokFailure) {
      console.error(`⚠️  ${grokFailure}`);
      code = 1;
    }
    if (r.success) {
      console.log("Codex integration is OFF and plain `codex` now runs natively. Switch back with: ocx restore back");
    } else {
      console.error("Plain `codex` was not fully restored. Inspect $CODEX_HOME/config.toml before using native Codex.");
    }
    return code;
  },
  "recover-history": async deps => {
    await deps.handleRecoverHistory();
    return Number(process.exitCode ?? 0);
  },
  uninstall: async deps => {
    await deps.handleUninstall();
    return Number(process.exitCode ?? 0);
  },
  status: async deps => {
    await deps.handleStatus();
    return Number(process.exitCode ?? 0);
  },
  doctor: async deps => {
    const doctorArgs = deps.args.slice(1);
    // `--json` was silently ignored here: runDoctor scans for its own flags and prints human
    // output regardless, so a caller that asked for JSON got prose and exit 0 -- and the skill
    // recipes recommended exactly that invocation. Refusing it is worse than supporting it and
    // better than lying about it.
    //
    // Not implemented rather than deferred silently: runDoctor has no report collection at all
    // (a module-level failure bit plus ~90 direct console emissions), and this runner appends
    // the Codex Log Guard's human output after it returns, so emitting a JSON document here
    // would interleave prose with JSON on one stdout -- unparseable, which is worse than the
    // ignored flag. The structured-report refactor is tracked as its own work-phase.
    if (doctorArgs.some(isJsonOption)) {
      console.error("ocx doctor does not support --json yet. Run `ocx doctor` for the human report, or use `ocx status --json` and `ocx ready --json` for machine-readable health.");
      return 2;
    }
    const { RECOVER_ZERO_BYTE_COORDINATOR_FLAG, runDoctor, doctorFailed } = await import("./doctor");
    await runDoctor(doctorArgs);
    if (!doctorArgs.includes("--fix-codex-runtime") && !doctorArgs.includes(RECOVER_ZERO_BYTE_COORDINATOR_FLAG)) {
      console.log("");
      const { printCodexLogGuardDoctor } = await import("./codex-log-guard-doctor");
      printCodexLogGuardDoctor();
    }
    // A diagnostic that always exits 0 cannot gate a script. `runDoctor` reports by direct
    // console.log with no checks collection, and signals its own special-flag failures
    // through process.exitCode, so honour both: an explicit exitCode wins, otherwise a
    // FAIL-level check fails the command. This is a BREAKING change for pipelines that ran
    // `ocx doctor` and ignored the result; a diagnostic that cannot fail is worse.
    const explicit = Number(process.exitCode ?? 0);
    if (explicit !== 0) return explicit;
    return doctorFailed() ? 1 : 0;
  },
  debug: async deps => {
    const { handleDebugCommand } = await import("./debug");
    await handleDebugCommand(deps.args.slice(1));
    return 0;
  },
  ensure: async deps => {
    const { readClientConnectionState } = await import("../client/state");
    const clientState = readClientConnectionState();
    await reconcileClientJournalBeforeLifecycle(clientState);
    if (clientState.kind !== "disconnected") {
      console.error(clientState.kind === "connected"
        ? "Client mode does not start a local provider proxy; use 'ocx sync'."
        : `Client state is ${clientState.kind}: ${clientState.reason}`);
      return 1;
    }
    await deps.handleEnsure();
    return Number(process.exitCode ?? 0);
  },
  login: async deps => {
    const { handleLogin } = await import("../oauth/login-cli");
    await handleLogin(deps.args[1]);
    return 0;
  },
  logout: async deps => {
    // Argv is parsed BEFORE any store access, which is the whole point of this shape.
    // Previously `args[1]` was taken as the provider name with no parsing, so
    // `ocx logout --json` called removeCredential("--json"), printed "Logged out of
    // --json." and exited 0 -- a silent false success, the worst outcome for a caller
    // that can only see the exit code.
    //
    // That is not merely a wasted call. `normalizeAuthStore` copies every top-level key
    // it finds, so a hand-edited, legacy, or corrupted auth.json containing a `--json`
    // key would have its active account deleted -- and the key dropped entirely if that
    // was its last account. A flag must never reach the store as a provider name.
    const logoutArgs = deps.args.slice(1);
    const wantsJson = logoutArgs.includes("--json");
    // Any leading dash is an option, not a provider. Matching only `--` left the same defect
    // one dash shorter: `ocx logout -j` treated `-j` as the provider name and, with a `-j` key
    // present in the store, deleted it and exited 0.
    const isOption = (arg: string): boolean => arg.startsWith("-");
    const positionals = logoutArgs.filter(arg => !isOption(arg));
    const unknownFlags = logoutArgs.filter(arg => isOption(arg) && arg !== "--json");
    const name = (positionals[0] ?? "").trim().toLowerCase();

    // Usage failures exit 2 and touch nothing. A missing provider is a usage error; a
    // provider that simply has no credential is a not-found (4) further down, because the
    // vocabulary distinguishes "you called this wrong" from "the thing is not there".
    //
    // The shape check is `isValidProviderName`, not another dash test. Rejecting a leading
    // ASCII `-` fixed `-j` and still let `logout —json` through with a Unicode dash, which is
    // the same defect a third time: each patch named one spelling instead of the class. The
    // canonical validator states the rule positively -- start and end alphanumeric, internal
    // `._-` allowed -- so `github-copilot` and `google-antigravity` pass while every dash
    // variant, empty string, and reserved name fails. Anything that is not a possible
    // provider id cannot reach the store at all.
    const malformedName = Boolean(name) && !isValidProviderName(name);
    if (unknownFlags.length > 0 || positionals.length > 1 || !name || malformedName) {
      const problem = unknownFlags.length > 0
        ? `unknown option ${unknownFlags[0]}`
        : positionals.length > 1 ? "too many arguments"
        : malformedName ? `not a valid provider name: ${name}`
        : "missing provider";
      console.error(`Usage: ocx logout <provider> [--json]  (${problem})`);
      return 2;
    }

    // The disposition comes from inside the store mutation, not from a read-then-remove
    // preflight. `mutateStore` serializes writes, so a preflight leaves a window where a
    // concurrent logout removes the same account and BOTH callers exit 0 claiming a removal --
    // a false success again, just a narrower one than the flag bug above.
    const { removeCredential } = await import("../oauth/store");
    const outcome = await removeCredential(name);
    if (outcome === "not-found") {
      if (wantsJson) console.log(JSON.stringify({ schemaVersion: 1, ok: false, provider: name, removed: false, reason: "not_found" }, null, 2));
      else console.error(`No stored credential for '${name}'.`);
      return 4;
    }
    if (wantsJson) console.log(JSON.stringify({ schemaVersion: 1, ok: true, provider: name, removed: true }, null, 2));
    else console.log(`Logged out of ${name}.`);
    return 0;
  },
  sync: async deps => {
    const syncArgs = deps.args.slice(1);
    const restartCodex = syncArgs.includes("--restart-codex");
    // Separate flag on purpose: --restart-codex promises app-server-only scope,
    // and quitting the desktop app ends live conversations.
    const restartDesktopApp = syncArgs.includes("--restart-desktop-app");
    const { readClientConnectionState } = await import("../client/state");
    const clientState = readClientConnectionState();
    if (clientState.kind === "invalid" || clientState.kind === "mismatched") {
      console.error(`Client state is ${clientState.kind}: ${clientState.reason}`);
      return 1;
    }
    if (clientState.kind === "connected") {
      try {
        const { syncConnectedClient } = await import("../client/connect");
        const result = await syncConnectedClient({ restartCodex });
        console.log(result.stale
          ? "Hub unavailable; retained and applied the last-known-good remote catalog (stale)."
          : "Remote hub catalog synchronized.");
        await handleConnectedSyncCatalogWrite(result, restartCodex, restartDesktopApp);
        // `process.exitCode` rather than a literal 0, for the same reason every other
        // runner does it (tests/cli-transport-honesty.test.ts): the catalog-write helper
        // drives app-server restarts, and one of those recording a failure must not be
        // erased by the value this runner returns. It reads 0 on the ordinary path. Node
        // types it as `number | string`; only a numeric code means anything here.
        return typeof process.exitCode === "number" ? process.exitCode : 0;
      } catch (error) {
        console.error(`Connected sync failed without local fallback: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    }
    const live = await deps.findLiveProxy();
    const synced = await syncModelsToCodex(
      live?.port,
      undefined,
      undefined,
      undefined,
      { catalogEvenWhenNotInjected: true },
    );
    let code = 0;
    if (synced.status === "skipped") {
      console.log("Codex integration is OFF; sync skipped and no Codex files changed.");
    } else if (synced.status === "catalog-only") {
      // Explicit sync with the integration OFF still refreshes the catalog/cache
      // for side profiles that consume the proxy without injection.
      console.log(synced.message ?? "Codex integration is OFF; catalog refreshed, Codex config untouched.");
    } else if (!synced.ok) {
      code = 1;
      console.error("Codex sync did not complete. Fix the reported Codex config issue and retry.");
    }
    // Only warn/restart when a catalog or models_cache write actually happened. This is
    // deliberately not an `else`: refreshCodexModelCatalog runs before injectCodexConfig,
    // so a sync can fail (`ok: false`) after the catalog was already rewritten — which is
    // exactly when a long-lived app-server is holding the stale list.
    if (synced.catalogWritten || synced.cacheSynced) {
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
      if (restartDesktopApp) await handleDesktopAppRestart(console);
    }
    // `ocx sync` is a direct CLI path; it does not call the management
    // `/api/sync` route. Refresh the already-connected MCode block here too,
    // after Codex has published the catalog that supplies its capabilities.
    if (synced.status !== "refused" && live) {
      try {
        const config = deps.loadConfig();
        const { refreshOwnedIntegration } = await import("../integrations/owned-refresh");
        const result = await refreshOwnedIntegration({
          clientId: "mcode",
          models: async () => {
            const { loadExportModels } = await import("../server/management/model-rows");
            return loadExportModels(config);
          },
          config,
          port: live.port,
        });
        if (result?.changed) console.log("MCode integration refreshed from the current catalog.");
        else if (result?.reason) console.warn(`MCode integration was not refreshed: ${result.reason}`);
      } catch (error) {
        console.warn(`MCode integration was not refreshed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return code;
  },
  v2: async deps => {
    const { cmdV2 } = await import("./v2");
    return await cmdV2(deps.args.slice(1), {}, async () => (await deps.findLiveProxy())?.port);
  },
  connect: async deps => {
    const { handleConnectCommand } = await import("./connect");
    return await handleConnectCommand(deps.args.slice(1));
  },
  disconnect: async deps => {
    const { handleDisconnectCommand } = await import("./connect");
    return await handleDisconnectCommand(deps.args.slice(1));
  },
  "sync-cache": async deps => {
    const cacheArgs = deps.args.slice(1);
    const restartCodex = cacheArgs.includes("--restart-codex");
    const restartDesktopApp = cacheArgs.includes("--restart-desktop-app");
    const { withCatalogWriteSerialization } = await import("../codex/catalog-write-serialization");
    const { invalidateCodexModelsCacheWithPermit } = await import("../codex/catalog/sync");
    const { getCodexHome } = await import("../codex/paths");
    const { readCodexCatalogPathForHome } = await import("../codex/catalog/parsing");
    const { existsSync } = await import("node:fs");
    const owningCodexHome = getCodexHome();
    const desiredDisabled = !shouldSyncCodexOnStart(deps.loadConfig());
    const invalidated = withCatalogWriteSerialization(owningCodexHome, permit =>
      invalidateCodexModelsCacheWithPermit(permit, owningCodexHome, { allowWhenDesiredDisabled: true }));
    const cacheJson = cacheArgs.includes("--json");
    const jsonSafeLog = cacheJson
      ? { log: (...values: unknown[]) => console.error(...values), error: (...values: unknown[]) => console.error(...values) }
      : console;
    // Only warn/restart when models_cache was actually rewritten from a readable catalog.
    if (invalidated.kind === "completed" && invalidated.value) {
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: jsonSafeLog });
      if (restartDesktopApp) await handleDesktopAppRestart(jsonSafeLog);
    } else if (desiredDisabled && !cacheJson) {
      // Worth saying in the human path, because it explains why nothing was written.
      // Under --json this belongs on the envelope, not as a second stdout line.
      console.log("Codex integration is OFF; no catalog or cache write resulted.");
    }
    // `completed` with a falsy value means the cache was NOT rewritten. Previously every
    // outcome exited 0, so a script could not tell a refreshed cache from a skipped one.
    //
    // Losing the catalog write lock to another process is a skip, not a failure:
    // serialization working as designed is the expected outcome under concurrency, and a
    // proxy startup holding the permit would otherwise make a perfectly healthy
    // `ocx sync-cache` exit 1 and fail the pipeline that called it -- intermittently, so it
    // would read as a flake rather than a bug. `codex-retained-root-serialization.test.ts`
    // pins exactly that: contended lock, no cache write, exit 0.
    //
    // `desiredDisabled` is deliberately NOT part of the success test, which is the subtle
    // part. This call passes `allowWhenDesiredDisabled: true`, so the OFF gate inside the
    // refresh never fires and the work is genuinely attempted -- an explicit `ocx sync-cache`
    // means the user asked for it regardless of the toggle. Treating OFF as automatic success
    // would report exit 0 and `skipped: true` for a refresh that actually failed.
    //
    // But `invalidateCodexModelsCacheWithPermit` returns a bare boolean for four different
    // situations -- wrote it, no catalog file exists, the OFF gate fired, or it threw -- so
    // `false` alone cannot be read as failure either. `!existsSync(catalogPath)` is a
    // legitimate nothing-to-do: with no catalog there is no cache to derive, which is the
    // normal state of a fully native home and the case
    // `codex-composed-acceptance.test.ts` pins at exit 0. It is checked here rather than by
    // widening that function's return type, because its boolean is consumed by a dozen
    // management routes that have no use for the distinction.
    const wrote = invalidated.kind === "completed" && Boolean(invalidated.value);
    const contended = invalidated.kind === "unavailable" && invalidated.reason === "busy";
    const noCatalog = !wrote && !existsSync(readCodexCatalogPathForHome(owningCodexHome));
    const ok = wrote || contended || noCatalog;
    if (cacheJson) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        ok,
        wrote,
        skipped: contended || noCatalog,
        outcome: invalidated.kind,
        // `outcome` alone cannot separate a contended lock from a hard serialization
        // failure -- both are `unavailable`. Carry the reason so a caller can.
        reason: invalidated.kind === "unavailable" ? invalidated.reason : undefined,
        // Which of the two benign skips this was, so `skipped: true` is never opaque.
        skippedReason: contended ? "contended" : noCatalog ? "no_catalog" : undefined,
        desiredDisabled,
        codexHome: owningCodexHome,
      }, null, 2));
    } else if (contended) {
      console.log("Another process owns the catalog write; cache sync skipped.");
    } else if (noCatalog) {
      console.log("No Codex catalog to derive a cache from; nothing to sync.");
    } else if (!ok) {
      console.error(`Cache refresh did not complete (${invalidated.kind}). The Codex model cache was not rewritten.`);
    }
    return ok ? 0 : 1;
  },
  gui: async deps => {
    const { runGuiCommand } = await import("./gui");
    return runGuiCommand(deps.args.slice(1), {
      loadConfig: deps.loadConfig,
      findLiveProxy: deps.findLiveProxy,
      openDefaultGui: async () => {
        const config = deps.loadConfig();
        // Identity-checked liveness (not the pid file + a fixed sleep): finds a fallback-port
        // proxy and waits until the spawned one actually answers before opening the browser.
        let live = await deps.findLiveProxy();
        if (!live) {
          console.log("Proxy not running. Starting...");
          deps.spawnDetached(deps.startArgv((config.port ?? 10100) > 0 ? (config.port ?? 10100) : undefined));
          live = await deps.waitForProxy();
          if (!live) {
            console.error("❌ Proxy did not become healthy after starting. Not opening the GUI.");
            return 1;
          }
        }
        // Open the host the proxy actually binds — `localhost` only answers for
        // loopback/wildcard binds, not a concrete LAN/IPv6 hostname.
        const guiHost = deps.probeHostname(live?.hostname ?? config.hostname);
        const guiUrl = `http://${guiHost === "127.0.0.1" ? "localhost" : guiHost}:${live?.port ?? config.port}`;
        console.log(`Opening ${guiUrl}`);
        const { openUrl } = await import("../lib/open-url");
        openUrl(guiUrl);
        return 0;
      },
    });
  },
  service: async deps => {
    process.exitCode = 0;
    await deps.serviceCommand(...deps.args.slice(1));
    // serviceCommand uses process.exitCode for recoverable install/stop failures
    // that must finish cleanup before the single top-level process.exit runs.
    return Number(process.exitCode ?? 0);
  },
  tray: async deps => {
    const { windowsTrayCommand } = await import("../tray/windows");
    // windowsTrayCommand reports failure through process.exitCode (tray/windows.ts sets
    // it for bad usage and for a failed install/start/stop/uninstall) and returns void,
    // so a literal 0 here made `ocx tray install` print an error and exit 0 (#2697).
    process.exitCode = 0;
    await windowsTrayCommand(deps.args.slice(1));
    return Number(process.exitCode ?? 0);
  },
  "codex-shim": async deps => {
    const { codexShimStatus, diagnoseCodexShim, installCodexShim, uninstallCodexShim } = await import("../codex/shim");
    switch (deps.args[1]) {
      case "install": {
        const r = installCodexShim();
        const { collectCodexShimReadinessWarnings } = await import("./codex-shim-readiness");
        const warnings = diagnoseCodexShim().healthy
          ? collectCodexShimReadinessWarnings()
          : [];
        console.log(`${r.installed && warnings.length === 0 ? "✅ " : "⚠️  "}${r.message}`);
        for (const warning of warnings) console.warn(`   ${warning}`);
        break;
      }
      case "status":
        console.log(codexShimStatus());
        break;
      case "uninstall":
      case "remove": {
        const r = uninstallCodexShim();
        console.log(r.removed ? `✅ ${r.message}` : `⚠️  ${r.message}`);
        break;
      }
      default:
        console.error("Usage: ocx codex-shim <install|status|uninstall|remove>");
        return 1;
    }
    return 0;
  },
  update: async deps => {
    // `ocx update --help` must print usage and exit WITHOUT side effects — running the
    // real self-update stops the proxy and drops in-flight routed streams (issue #168).
    if (hasHelpFlag(deps.args.slice(1))) {
      printSubcommandUsage("update");
      return 0;
    }
    const { runUpdate } = await import("../update");
    await runUpdate();
    return 0;
  },
  "__refresh-version": async deps => {
    // Hidden, detached helper spawned by the update prompt to refresh the
    // cached latest version without blocking the foreground start. Not in help.
    const { refreshVersionCache } = await import("../update/notify");
    const channel = deps.args[1] === "preview" ? "preview" : "latest";
    await refreshVersionCache(channel);
    return 0;
  },
  "__tray-start": async deps => {
    return (await deps.handleTrayProxyStart()) ? 0 : 1;
  },
  "__tray-restart": async deps => {
    await deps.handleTrayProxyRestart();
    return Number(process.exitCode ?? 0);
  },
  "__startup-health": async deps => {
    const { collectStartupHealth } = await import("../codex/autostart-health");
    console.log(JSON.stringify(collectStartupHealth(deps.loadConfig())));
    return 0;
  },
  "__tray-host": async () => {
    const { runWindowsTrayHost } = await import("../tray/windows");
    await runWindowsTrayHost();
    return 0;
  },
  "__gui-update-worker": async deps => {
    const jobId = deps.args[1];
    if (!jobId) return 1;
    const channel = normalizeUpdateChannel(deps.args[2]);
    await runGuiUpdateWorker(jobId, channel, deps.args[3] === "restart");
    return 0;
  },
  restart: async deps => {
    // The running proxy owns its drain and replacement through /api/system/restart.
    // If nothing is live, restart degrades to the documented `ensure` start behavior.
    await deps.handleProxyRestart(deps.handleRestartStartWhenStopped);
    return Number(process.exitCode ?? 0);
  },
  capabilities: async deps => {
    const { runCapabilities } = await import("./capabilities-command");
    return await runCapabilities(deps.args.slice(1));
  },
  health: async deps => {
    const healthArgs = deps.args.slice(1);
    const wantsHealthJson = healthArgs.includes("--json");
    // A proxy that has only just bound can miss a single probe while its event loop
    // is still settling startup work — the same just-started race the stop paths
    // already retry for (#764, SERVICE_STOP_LIVENESS). Without this, `ocx health`
    // run seconds after a service restart reports a false negative on a proxy that
    // is in fact serving.
    const live = await deps.findLiveProxy({ attempts: 3 });
    if (wantsHealthJson) {
      console.log(JSON.stringify({ ok: !!live, pid: live?.pid ?? null, port: live?.port ?? null }));
    } else {
      console.log(live ? `Proxy healthy (PID ${live.pid}, port ${live.port})` : "Proxy not healthy");
    }
    return live ? 0 : 1;
  },
  ready: async deps => {
    // Fail-closed impossible-state guard: readyArgs is populated by the
    // preparse block in src/cli/root.ts before maybeAutoRestoreCodexShim, so
    // reaching here without it means dispatch diverged. Refuse with code 64
    // and perform NO I/O (no discovery/probe). process.exit is `never`,
    // narrowing below.
    const readyArgs = deps.head.readyArgs;
    if (!readyArgs) return 64;
    return await deps.handleReady(readyArgs);
  },
  provider: async deps => {
    const { handleProviderCommand } = await import("./provider");
    // Reset first, like the service runner below: reading process.exitCode only
    // reports THIS command's outcome if nothing earlier in the process set it.
    process.exitCode = 0;
    await handleProviderCommand(deps.args.slice(1));
    // handleProviderCommand reports failure through process.exitCode, which it sets
    // from handleProviderRuntimeCommand. Returning a literal 0 here made index.ts
    // call process.exit(0) and erase it, so `ocx provider quota` against a stopped
    // proxy printed an error and still exited 0 (#2697).
    return Number(process.exitCode ?? 0);
  },
  account: async deps => {
    const { cmdAccount } = await import("./account");
    return await cmdAccount(deps.args.slice(1));
  },
  models: async deps => {
    const { handleModels } = await import("./models");
    process.exitCode = 0;
    await handleModels(deps.args.slice(1));
    // Same as the provider runner above: handleModels sets process.exitCode from
    // handleModelsRuntimeCommand, and a literal 0 discarded it (#2697).
    return Number(process.exitCode ?? 0);
  },
  alias: async deps => {
    const { handleAliasCommand } = await import("./alias");
    return await handleAliasCommand(deps.args.slice(1));
  },
  combo: async deps => {
    const { handleComboCommand } = await import("./combo");
    return await handleComboCommand(deps.args.slice(1));
  },
  route: async deps => {
    if (deps.args[1] !== "combo" && deps.args[1] !== "policy") {
      console.error("Usage: ocx route <combo|policy> <subcommand>");
      return 2;
    }
    if (deps.args[1] === "combo") {
      const { handleComboCommand } = await import("./combo");
      return await handleComboCommand(deps.args.slice(2));
    } else {
      const { handleRoutePolicyCommand } = await import("./route-policy");
      return await handleRoutePolicyCommand(deps.args.slice(2));
    }
  },
  agent: async deps => {
    const { handleAgentCommand } = await import("./agent");
    return await handleAgentCommand(deps.args.slice(1));
  },
  observe: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand(deps.args.slice(1));
  },
  inspect: async deps => {
    const { handleInspectCommand } = await import("./inspect");
    return await handleInspectCommand(deps.args.slice(1));
  },
  logs: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand([deps.command!, ...deps.args.slice(1)]);
  },
  usage: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand([deps.command!, ...deps.args.slice(1)]);
  },
  storage: async deps => {
    // `ocx storage` used to be a pure alias of `observe storage`, which reached only the report
    // route. wp7 gave it cleanup, trash, and policy subcommands, so it dispatches to its own
    // module -- with `report` as the default subcommand, so a bare `ocx storage` still prints
    // the same thing it printed before.
    const { handleStorageCommand } = await import("./storage");
    return await handleStorageCommand(deps.args.slice(1));
  },
  memory: async deps => {
    const { handleObserveCommand } = await import("./observe");
    return await handleObserveCommand([deps.command!, ...deps.args.slice(1)]);
  },
  access: async deps => {
    const { handleAccessCommand } = await import("./access");
    return await handleAccessCommand(deps.args.slice(1));
  },
  "api-key": async deps => {
    const { handleAccessCommand } = await import("./access");
    return await handleAccessCommand(["key", ...deps.args.slice(1)]);
  },
  export: async deps => {
    const { handleExportCommand } = await import("./export-command");
    return await handleExportCommand(deps.args.slice(1));
  },
  grok: async deps => {
    const { handleGrokCommand } = await import("./integrations");
    return await handleGrokCommand(deps.args.slice(1));
  },
  integration: async deps => {
    const integration = deps.args[1];
    if (integration === "grok") {
      const { handleGrokCommand } = await import("./integrations");
      return await handleGrokCommand(deps.args.slice(2));
    } else if (integration === "native") {
      // The native client toggles are a separate server surface from the reversible file
      // integrations `client` manages, so they get their own subcommand rather than being
      // folded into one that means something else.
      const { handleIntegrationCommand } = await import("./inspect");
      return await handleIntegrationCommand(deps.args.slice(1));
    } else if (integration === "claude") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      return await handleClaudeConfigCommand(deps.args.slice(2));
    } else if (integration === "client") {
      const { handleClientIntegrationCommand } = await import("./integrations");
      return await handleClientIntegrationCommand(deps.args.slice(2));
    } else {
      console.error("Usage: ocx integration <claude|grok|client> <subcommand>");
      return 2;
    }
  },
  system: async deps => {
    const { handleSystemCommand } = await import("./system-command");
    return await handleSystemCommand(deps.args.slice(1));
  },
  config: async deps => {
    const { handleConfigCommand } = await import("./config-command");
    return await handleConfigCommand(deps.args.slice(1));
  },
  lab: async deps => {
    const { handleLabCommand } = await import("./lab");
    return await handleLabCommand(deps.args.slice(1));
  },
  claude: async deps => {
    const { cmdClaude } = await import("./claude");
    // "ocx claude desktop" → write Desktop 3P config
    if (deps.args[1] === "desktop") {
      const { handleClaudeDesktopCommand } = await import("./claude-desktop");
      const exitCode = await handleClaudeDesktopCommand(deps.args.slice(2));
      if (exitCode !== 0) return exitCode;
      return 0;
    }
    if (deps.args[1] === "config") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      return await handleClaudeConfigCommand(deps.args.slice(2));
    }
    return await cmdClaude(deps.args.slice(1));
  },
  opencode: async deps => {
    const { cmdOpencode } = await import("./opencode");
    return await cmdOpencode(deps.args.slice(1));
  },
  mcode: async deps => {
    const { cmdMcode } = await import("./minimax");
    return await cmdMcode(deps.args.slice(1));
  },
  mmx: async deps => {
    const { cmdMmx } = await import("./minimax");
    return await cmdMmx(deps.args.slice(1));
  },
  zcode: async deps => {
    const { handleZcodeCommand } = await import("./integrations");
    return await handleZcodeCommand(deps.args.slice(1));
  },
  help: async () => {
    printUsage();
    return 0;
  },
  "--help": async () => {
    printUsage();
    return 0;
  },
  "-h": async () => {
    printUsage();
    return 0;
  },
};

/** Registry alias pairs → canonical dispatch name (init/setup, restore/eject, …). */
const aliasTargets = new Map<string, string>();
for (const entry of CLI_COMMANDS) {
  for (const alias of entry.aliases ?? []) aliasTargets.set(alias, entry.name);
}

export const DISPATCH_COMMANDS: ReadonlySet<string> = new Set(Object.keys(commandRunners));
export const DISPATCH_ALIASES: ReadonlyMap<string, string> = aliasTargets;

/** Resolve the runner key for a command, following registry aliases to the
 * canonical runner. Returns undefined when the command is unknown. */
/** What `handleStart` does about a live proxy it found before binding. */
export type StartOwnerDecision = "refuse" | "service-stay-out" | "sibling";

/**
 * Pure decision for `handleStart` when the pre-bind probe found a live proxy.
 *
 * The #3106 guard exists so a bare `start` cannot shadow a healthy configured-port
 * proxy with an ephemeral-port copy. An interactive `--port X` naming a DIFFERENT
 * port than the live proxy's is an explicit sibling request, not that shadow — and
 * refusing it also broke every spawned-launcher test on a machine running a real
 * proxy, because the probe reaches the machine-global port across sandbox homes.
 * The service wrapper always passes the configured port and keeps its exact
 * stay-out-of-the-way semantics: it never takes the sibling path.
 */
export function decideStartWithLiveOwner(input: {
  livePort: number;
  requestedPort: number | undefined;
  ocxService: string | undefined;
}): StartOwnerDecision {
  const sibling = input.requestedPort !== undefined
    && input.requestedPort !== input.livePort
    // Only the exact "1" sentinel is service context — the same check syncCleanup
    // uses — so an env value like "0" or "false" cannot reach the stay-out path.
    && input.ocxService !== "1";
  if (sibling) return "sibling";
  return input.ocxService === "1" ? "service-stay-out" : "refuse";
}

export function resolveDispatchCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  if (Object.prototype.hasOwnProperty.call(commandRunners, command)) return command;
  return aliasTargets.get(command);
}

export async function dispatchCommand(head: CliHead, deps: CliDispatchDeps): Promise<number> {
  const command = head.command;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }
  const runner = commandRunners[resolveDispatchCommand(command) ?? ""];
  if (!runner) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }
  return await runner(deps);
}

/**
 * Report the outcome of an opt-in desktop-app restart. Kept next to the two
 * callers so `sync` and `sync-cache` cannot drift in what they tell the user.
 */
async function handleDesktopAppRestart(log: Pick<Console, "log" | "error">): Promise<void> {
  const { restartCodexDesktopApp } = await import("../codex/desktop-app-restart");
  const result = restartCodexDesktopApp();
  switch (result.reason) {
    case "windows_only":
      log.error("--restart-desktop-app is supported on Windows only; nothing was stopped.");
      return;
    case "package_discovery_failed":
      log.error(
        "Could not identify the installed Codex desktop package. Quit and relaunch the desktop app "
        + "manually to refresh the model picker.",
      );
      return;
    case "self_ancestry":
      log.error(
        "Refusing to restart the desktop app because this command is running inside it. "
        + "Run 'ocx sync --restart-desktop-app' from an external terminal instead.",
      );
      return;
    case "process_probe_failed":
      // Distinct from `no_targets`: we could not look, which is not the same as looking and
      // finding nothing. Saying "not running" here sent users away believing there was nothing
      // to restart (#2557).
      log.error(
        "Could not enumerate Codex desktop processes, so the app was not restarted. "
        + "Quit and relaunch the desktop app manually to refresh the model picker.",
      );
      return;
    case "no_targets":
      log.log("Codex desktop app is not running; nothing to restart.");
      return;
    case "targets_survived":
      log.error(
        `Codex desktop app PID(s) ${result.surviving.join(", ")} did not exit, so it was not relaunched. `
        + "Quit the desktop app manually to refresh the model picker.",
      );
      return;
    default:
      if (result.relaunch === "started") {
        log.log("Codex desktop app restarted; its model picker will re-read the catalog.");
      }
  }
}

async function handleConnectedSyncCatalogWrite(
  result: { catalogWritten: boolean; cacheSynced: boolean },
  restartCodex: boolean,
  restartDesktopApp: boolean,
): Promise<void> {
  if (!result.catalogWritten && !result.cacheSynced) return;
  afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
  if (restartDesktopApp) await handleDesktopAppRestart(console);
}

async function reconcileClientJournalBeforeLifecycle(
  state: ClientConnectionState,
): Promise<void> {
  if (state.kind === "disconnected") return;
  const { reconcileJournal } = await import("../codex/journal");
  reconcileJournal(state.kind === "connected"
    ? { activeClientApiKeyId: state.value.apiKeyId }
    : undefined);
}
