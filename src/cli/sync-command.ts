import type { CliDispatchDeps } from "./dispatch";
import type { OwnedIntegrationRefreshOutcome } from "../integrations/owned-refresh";
import { syncModelsToCodex } from "../codex/sync";
import { HUB_GATED_SKIP_MESSAGE } from "../codex/desired-state";
import { handleRestartScopeAfterWrite, readRestartScope, type RestartScope } from "./restart-scope";
import { terminalSafeError, terminalSafeText } from "./runtime-api";
import { parseSyncFanoutFlags } from "./sync-flags";
import { projectLocalSyncResult } from "./local-sync-result";
import { readLinkStore } from "../link/store";
import { linkKnownHostsPath, linkStorePath } from "../link/paths";
import { buildExecArgv, remotePinnedSyncArgv } from "../link/ssh-argv";
import { requireRemotePlatformFramed } from "../link/remote-platform";
import { pinnedSyncRanNothing, syncThenRestart, type PinnedRun } from "../link/sync-then-restart";
import type { ChildRestart } from "../link/child-ops-types";
import { FanoutProcessError, fanoutSshRunner, runFanoutProcess } from "./sync-fanout-process";
import { readHomeLinkStatus } from "./sync-link-status";
import { classifySyncResult, fanoutExitCode, renderFanoutHuman, renderFanoutJson, restartNote, runHomeFanout, REMOTE_LINK_SYNC_MESSAGE, STALE_REMOTE_CATALOG_MESSAGE, type ChildResult, type HomeResult } from "./sync-fanout";

export async function runSyncCommand(deps: CliDispatchDeps): Promise<number> {
    const flags = parseSyncFanoutFlags(deps.args.slice(1));
    if (!flags.ok) { console.error(flags.message); return 2; }
    if (flags.children) {
      // D16: an unknown id is a usage error before the Home sync changes anything.
      let known: Set<string>;
      try { known = new Set(readLinkStore(linkStorePath()).links.map(link => link.id)); }
      catch { console.error("--child cannot be checked: the Remote Link store could not be read."); return 2; }
      const unknown = flags.children.find(id => !known.has(id));
      if (unknown) { console.error(`--child ${unknown} is not a link on this Home (see ocx link status).`); return 2; }
    }
    const originalLog = console.log;
    if (flags.json) console.log = (...args: unknown[]) => console.error(...args);
    let applicable = false, catalogCurrent = false;
    let state: HomeResult["state"] = "failed";
    const runHome = async (): Promise<number> => {
    const syncArgs = deps.args.slice(1);
    // #7694: parse the expected identity before anything else reads or writes state.
    const { parseSyncExpectation, reportSyncExpectationMismatch, SYNC_EXPECTATION_USAGE_EXIT } = await import("./sync-expectation");
    const parsedExpectation = parseSyncExpectation(syncArgs);
    if (!parsedExpectation.ok) {
      console.error(parsedExpectation.message);
      return SYNC_EXPECTATION_USAGE_EXIT;
    }
    const expectation = parsedExpectation.expectation;
    // The root preflight skips shim repair for every sync so the update/sync mutex is held first.
    if (!expectation) await (await import("./codex-shim-autorestore")).runCodexShimAutoRestoreAsync();
    const restartScope = readRestartScope(syncArgs, console);
    // The wire field keeps APP-SERVER-ONLY meaning and is deliberately not widened. A
    // remote hub must not end a local user's conversations because a field name acquired
    // a wider meaning underneath it; the maintainer decision widened a local CLI flag and
    // said nothing about remote callers. syncConnectedClient ignores it either way.
    const restartCodex = restartScope.appServers;
    const { readClientConnectionState } = await import("../client/state");
    const clientState = readClientConnectionState();
    // With an expectation the unlocked read decides nothing: the connected sync re-reads under its
    // lock and refuses there, so a state that changes in between can never reach the local path.
    if (!expectation && (clientState.kind === "invalid" || clientState.kind === "mismatched")) {
      console.error(`Client state is ${clientState.kind}: ${clientState.reason}`);
      return 1;
    }
    if (expectation || clientState.kind === "connected") {
      try {
        const { syncConnectedClient } = await import("../client/connect");
        const result = await syncConnectedClient(expectation ? { restartCodex, expect: expectation } : { restartCodex });
        if (expectation) {
          // The root preflight skipped the shim repair for a pinned sync; the identity held, so
          // run it now, as an unpinned sync would have.
          const { runCodexShimAutoRestoreAsync } = await import("./codex-shim-autorestore");
          await runCodexShimAutoRestoreAsync();
        }
        // The connection the sync ran under, read inside its lock; the read above may be stale.
        const link = result.connection.transport === "link";
        state = result.stale ? "stale" : "synced";
        console.log(result.stale
          ? link ? STALE_REMOTE_CATALOG_MESSAGE : "Hub unavailable; retained and applied the last-known-good remote catalog (stale)."
          : link ? REMOTE_LINK_SYNC_MESSAGE : "Remote hub catalog synchronized.");
        if (result.homeSettings) {
          const { describeHomeCodexSettings } = await import("../link/codex-settings");
          const settings = result.homeSettings;
          if (settings.source === "local") {
            console.log(`Codex settings: kept this machine's local values (${terminalSafeText(settings.reason)}).`);
          } else {
            console.log(settings.source === "home"
              ? `Codex settings applied from Home ${terminalSafeText(settings.document.home.name)}:`
              : `Codex settings applied from the last recorded Home read (${terminalSafeText(settings.reason)}):`);
            for (const line of describeHomeCodexSettings(settings.document.settings)) console.log(`  ${terminalSafeText(line)}`);
          }
        }
        await handleConnectedSyncCatalogWrite(result, restartScope);
        if (result.applyRecordFailed) {
          console.error("The Home's Codex settings were applied, but the apply record could not be written; the client runtime was not restarted. Run 'ocx sync' again.");
          process.exitCode = 1;
        }
        if (result.journalHandoverFailed) {
          console.error("Codex routing was applied, but the Codex journal could not be handed to this connection (the Codex config was busy or changed, or the journal belongs to an earlier connection), so the client runtime was not restarted: the next OpenCodex restart could restore native routing. Run 'ocx sync' again; if it repeats, run 'ocx sync --restart-codex' after that restart.");
          process.exitCode = 1;
        }
        // OCX-6: a link Child's runtime must have started after the apply it serves under.
        // Not after a failed handover: that restart is the one that would undo this routing.
        if (link && result.appliedRecord && !result.journalHandoverFailed) {
          const { applyRestartMessage, restartRuntimeAfterApply } = await import("./link-apply-restart");
          const { sameClientConnectionOwner } = await import("../client/state");
          const applied = result.connection;
          const outcome = await restartRuntimeAfterApply(result.appliedRecord, {
            restart: (startWhenStopped, onSupervised) => deps.handleProxyRestart(startWhenStopped, onSupervised),
            recoveryStart: recovering => deps.handleRestartStartWhenStopped(recovering),
            connectionUnchanged: () => {
              const current = readClientConnectionState();
              return current.kind === "connected" && sameClientConnectionOwner(current.value, applied)
                && current.value.link?.linkId === applied.link?.linkId;
            },
          });
          const message = applyRestartMessage(outcome);
          if (outcome.kind === "failed" || outcome.kind === "connection-changed") {
            console.error(message);
            process.exitCode = 1;
          } else {
            console.log(message);
          }
        }
        // `process.exitCode` rather than a literal 0, for the same reason every other
        // runner does it (tests/cli/cli-transport-honesty.test.ts): the catalog-write helper
        // drives app-server restarts, and one of those recording a failure must not be
        // erased by the value this runner returns. It reads 0 on the ordinary path. Node
        // types it as `number | string`; only a numeric code means anything here.
        return typeof process.exitCode === "number" ? process.exitCode : 0;
      } catch (error) {
        const { ClientSyncExpectationError } = await import("../client/sync-expectation");
        if (error instanceof ClientSyncExpectationError) return reportSyncExpectationMismatch(error, console);
        // The refresh path reaches the same hub catalog `ocx connect` validates, so a rejected
        // reasoning level arrives here as hub-supplied text. Rendering it through the shared
        // terminal boundary is what keeps the routine refresh from forging output; the domain
        // error itself is left alone for callers that inspect it.
        console.error(`Connected sync failed without local fallback: ${terminalSafeError(error).message}`);
        return 1;
      }
    }
    applicable = true;
    const live = await deps.findLiveProxy();
    const synced = await syncModelsToCodex(
      live?.port,
      undefined,
      undefined,
      undefined,
      { catalogEvenWhenNotInjected: true },
    );
    let code = 0;
    state = synced.status === "skipped" ? "skipped" : synced.ok ? "synced" : "failed";
    catalogCurrent = (synced.status === "applied" || synced.status === "catalog-only")
      && synced.refreshOutcome === "committed" && projectLocalSyncResult(synced).catalog?.converged === true;
    if (synced.status === "skipped") {
      console.log(synced.skippedReason === "hub-gated"
        ? `${HUB_GATED_SKIP_MESSAGE} sync skipped and no Codex files changed.`
        : "Codex integration is OFF; sync skipped and no Codex files changed.");
    } else if (synced.status === "catalog-only") {
      // Explicit sync with the integration OFF still refreshes the catalog/cache
      // for side profiles that consume the proxy without injection.
      console.log(synced.message ?? "Codex integration is OFF; catalog refreshed, Codex config untouched.");
      if (!synced.ok) code = 1;
    } else if (!synced.ok) {
      code = 1;
      console.error("Codex sync did not complete. Fix the reported Codex config issue and retry.");
    }
    // Catalog/model-cache writes retain their warning/restart handling. This is
    // deliberately not an `else`: refreshCodexModelCatalog runs before injectCodexConfig,
    // so a sync can fail (`ok: false`) after the catalog was already rewritten — which is
    // exactly when a long-lived app-server is holding the stale list.
    // A configuration-only change also needs a reload, but only when explicitly
    // requested. A successful no-op or refused write is never restart authority.
    const requestedConfigRestart = (restartScope.appServers || restartScope.desktopApp)
      && synced.ok && synced.configChanged === true;
    if (synced.catalogWritten || synced.cacheSynced || requestedConfigRestart) {
      await handleRestartScopeAfterWrite(restartScope, console);
    }
    // `ocx sync` is a direct CLI path; it does not call the management
    // `/api/sync` route. Refresh already-connected file integrations here too,
    // after Codex has published the catalog that supplies its capabilities.
    if (synced.status !== "refused") {
      const results: OwnedIntegrationRefreshOutcome[] = [];
      if (live) {
        try {
          const config = deps.loadConfig();
          const { refreshOwnedCatalogIntegrations } = await import("../integrations/catalog-refresh");
          results.push(...await refreshOwnedCatalogIntegrations({
            models: async () => {
              const { loadExportModels } = await import("../server/management/model-rows");
              return loadExportModels(config);
            },
            config,
            port: live.port,
          }, ["mcode", "pi", "raycast", "omo", "cline", "commandcode", "droid", "opencode", "kilo", "qoder", "qoder-cn", "workbuddy", "workbuddy-ai", "hermes", "t3code"]));
        } catch (error) {
          console.warn(`Client integrations were not refreshed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Even without a live proxy, report why Aside could not sync. Its server
      // owner is never bypassed, and another client's failure cannot hide it.
      try {
        const { refreshAsideProfilesThroughServer } = await import("./aside-profiles");
        results.push(...await refreshAsideProfilesThroughServer({ findLiveProxy: async () => live }));
      } catch (error) {
        console.warn(`Aside profiles were not refreshed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const result of results) {
        const label = result.profileId === undefined ? result.client : `${result.client}:${result.profileId}`;
        if (result.changed) console.log(`${label} integration refreshed from the current catalog.`);
        else if (result.reason) console.warn(`${label} integration was not refreshed: ${result.reason}${result.residual ? " Recovery did not finish." : ""}${result.snapshotPath ? ` Backup: ${result.snapshotPath}` : ""}`);
      }
    }
    return code || (typeof process.exitCode === "number" ? process.exitCode : 0);
    };
    let code: number;
    try { code = await runHome(); }
    catch (error) {
      if (!flags.json) {
        try { if (readLinkStore(linkStorePath()).links.length) console.error("Children were not synced because the Home sync failed."); } catch { /* Preserve the original error. */ }
        throw error;
      }
      console.error(`Sync failed: ${terminalSafeError(error).message}`);
      code = 1; state = "failed"; applicable = true;
    } finally { console.log = originalLog; }
    if (code !== 0) state = "failed";
    const document = await runHomeFanout({
      home: { state, exit: code }, catalogCurrent, localOnly: flags.localOnly, applicable,
      selected: flags.children === null ? null : new Set(flags.children), restartChildren: flags.restartChildren,
      readStore: () => readLinkStore(linkStorePath()), readLinkStatus: () => readHomeLinkStatus(),
      runChild: async (link, deadline, options) => {
        const runner = fanoutSshRunner(deadline);
        let platform: "posix" | "windows";
        try { platform = link.remotePlatform ?? await requireRemotePlatformFramed(runner, link.alias, linkKnownHostsPath()); }
        catch (error) {
          if (error instanceof FanoutProcessError && (error.reason === "deadline-exceeded" || error.reason === "termination-unconfirmed")) return { state: "timed-out", reason: error.reason, exit: null };
          return { state: "failed", reason: "platform-probe-failed", exit: null };
        }
        type Run = { state: ChildResult["state"]; reason: string | null; exit: number | null; executable?: "ocx-child" };
        const runPinned = async (restart: ChildRestart): Promise<PinnedRun<Run>> => {
          // Revision 6: with the shared deadline spent before the restarting sync, nothing is sent to the Child.
          if (restart !== "none" && deadline - Date.now() <= 0) return { sync: { state: "timed-out", reason: "deadline-exceeded", exit: null }, notRun: true };
          try {
            const result = await runFanoutProcess(buildExecArgv({ alias: link.alias, knownHostsFile: linkKnownHostsPath(),
              argv: remotePinnedSyncArgv(link.id, platform, restart === "none" ? {} : { restart }) }), { timeoutMs: Math.max(0, deadline - Date.now()) });
            const verdict = classifySyncResult(result, { expectSelectedKind: restart !== "none" });
            return { sync: { ...verdict, exit: result.code }, notRun: pinnedSyncRanNothing(verdict, result) };
          } catch (error) {
            if (!(error instanceof FanoutProcessError)) throw error;
            const timedOut = error.reason === "deadline-exceeded" || error.reason === "termination-unconfirmed";
            return { sync: { state: timedOut ? "timed-out" : "failed", reason: error.reason, exit: null }, notRun: error.reason === "ssh-spawn-failed" };
          }
        };
        const done = await syncThenRestart({ requested: options.restart ?? "none", platform, childKind: link.childKind,
          runPinned, readActivity: options.readActivity });
        // Pick the public fields: executable, withheld and second never reach ocx.sync.fanout/1.
        const note = restartNote(done);
        return note === null ? { state: done.sync.state, reason: done.sync.reason, exit: done.sync.exit }
          : { state: "synced", reason: note, exit: done.sync.exit };
      },
    });
    if (flags.json) originalLog(renderFanoutJson(document));
    else {
      for (const line of renderFanoutHuman(document)) originalLog(line);
      if (document.fanout.state === "failed" && document.fanout.reason === "link-store-unreadable") {
        console.error("Children were not synced: the Remote Link store could not be read.");
      }
    }
    return fanoutExitCode(document);
}

async function handleConnectedSyncCatalogWrite(
  result: { catalogWritten: boolean; cacheSynced: boolean },
  scope: RestartScope,
): Promise<void> {
  if (!result.catalogWritten && !result.cacheSynced) return;
  await handleRestartScopeAfterWrite(scope, console);
}
