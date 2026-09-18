import type { OcxConfig } from "../types";
import { injectClaudeAgentDefs } from "../claude/agents-inject";
import { readCachedHubState } from "../client/hub-state";
import { fetchClaudeContextWindows } from "./claude";
import type { ReadinessGate } from "../server/readiness";

export interface ClaudeAgentStartupSyncDeps {
  fetchContextWindows?: typeof fetchClaudeContextWindows;
  injectAgentDefs?: typeof injectClaudeAgentDefs;
  warn?: (message: string) => void;
  /** Seam for the hub roster lookup; the default reads only the on-disk cache. */
  readHubRoster?: (config: OcxConfig) => readonly string[] | undefined;
}

/**
 * The hub's roster for a connected client, from the CACHE only (#4236).
 *
 * Startup deliberately makes no network call for this. The roster is a convenience here — `ocx
 * claude` does the live read on the path where it matters — and a hub round trip on every proxy
 * start would put an offline hub in the way of a local launch. Undefined falls back to local
 * `subagentModels`, which is what this path has always used.
 */
function cachedHubRoster(config: OcxConfig): readonly string[] | undefined {
  if (config.runtimeRole !== "client" || !config.client) return undefined;
  try {
    const cached = readCachedHubState({
      serverUrl: config.client.serverUrl,
      apiKeyId: config.client.apiKeyId,
      connectedAt: config.client.connectedAt,
    });
    return cached?.state.subagentModels;
  } catch {
    return undefined;
  }
}

/**
 * Keep readiness pending until the roster and optional Desktop registry have settled.
 *
 * The Codex sync remains the authority for ready versus failed. Claude roster repair is
 * deliberately best-effort (#2200), but readiness must not become observable between the
 * Codex write and that repair: a service manager could otherwise launch Claude Code against
 * stale `ocx-*.md` files. A small forwarding gate delays only the successful transition;
 * terminal Codex failure is still published immediately.
 */
export async function reconcileClientStartupBeforeReady<T>(
  readinessGate: ReadinessGate,
  syncCodex: (deferredGate: ReadinessGate) => Promise<T>,
  syncClaudeRoster: () => Promise<unknown>,
  syncDesktopRegistry?: () => Promise<unknown>,
): Promise<T> {
  let codexReady = false;
  const deferredGate: ReadinessGate = {
    getStatus: () => readinessGate.getStatus(),
    markReady: () => { codexReady = true; },
    markFailed: () => readinessGate.markFailed(),
  };

  const result = await syncCodex(deferredGate);
  await syncClaudeRoster();
  await syncDesktopRegistry?.();
  if (codexReady) readinessGate.markReady();
  return result;
}

/**
 * Reconcile the generated Claude Code roster after the proxy listener is live.
 *
 * This belongs to the owning CLI lifecycle rather than `startServer`: the latter is also a
 * library/test primitive and must not mutate a developer's real `~/.claude` directory merely
 * because an in-process test server was created. The live Management API supplies the same bounded
 * context-window map used by `ocx claude`; failure keeps startup available and falls back to an
 * unmarked roster. Disabled integrations skip discovery and prune verified-owned definitions.
 */
export async function syncClaudeAgentDefsAtProxyStartup(
  config: OcxConfig,
  port: number,
  deps: ClaudeAgentStartupSyncDeps = {},
): Promise<string[] | null> {
  const inject = deps.injectAgentDefs ?? injectClaudeAgentDefs;
  const warn = deps.warn ?? (message => console.warn(message));

  try {
    // Hub role: never rewrite this host's ~/.claude roster on startup (same rule as
    // shouldSyncCodexOnStart / shouldSyncGrokOnStart — the hub serves other machines).
    if (config.runtimeRole === "hub") return null;
    if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
      return inject(config, {});
    }

    let windows: Record<string, number> = {};
    try {
      windows = await (deps.fetchContextWindows ?? fetchClaudeContextWindows)(config, port);
    } catch {
      // Startup remains best-effort. The next management mutation or `ocx claude` launch can
      // restore context markers after a transient catalog/Management API failure.
    }
    return inject(config, windows, undefined, (deps.readHubRoster ?? cachedHubRoster)(config));
  } catch (error) {
    warn(`⚠ Claude agent definitions could not be synced at proxy startup: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
