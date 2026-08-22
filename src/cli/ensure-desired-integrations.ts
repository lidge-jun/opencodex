/**
 * Align Grok and Claude Desktop files with the durable switches during `ocx ensure`.
 *
 * handleEnsure used to load config once, then health-probe / model-sync / spawn,
 * and only afterwards mutate ~/.grok/config.toml and the Desktop library from
 * that snapshot. An OFF→ON flip in that window stripped a freshly enabled fence
 * or deleted a freshly applied Desktop profile; ON→OFF rewrote the files the
 * user had just turned off. Re-read persisted desired state immediately before
 * each external-file mutation, and use that current config for sync inputs.
 */
import { loadConfig } from "../config";
import { stripGrokConfig, type GrokInjectResult } from "../grok/inject";
import { removeDesktop3pStandardPivot } from "../claude/desktop-3p";
import {
  claudeDesktopIntegrationEnabled,
  shouldSyncGrokOnStart,
} from "../codex/desired-state";
import type { OcxConfig } from "../types";

export function grokSyncFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Grok Build config sync failed: ${detail}. `
    + "~/.grok/config.toml may still point at a previous proxy port — "
    + "run 'ocx ensure' (or apply from the dashboard's Grok page) to repoint it.";
}

export interface EnsureDesiredIntegrationsDeps {
  loadConfig: () => OcxConfig;
  stripGrokConfig: typeof stripGrokConfig;
  syncGrokConfig: (
    port: number,
    config: OcxConfig,
    opts?: { hostname?: string },
  ) => Promise<GrokInjectResult>;
  removeDesktop3pStandardPivot: typeof removeDesktop3pStandardPivot;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

async function defaultSyncGrokConfig(
  port: number,
  config: OcxConfig,
  opts: { hostname?: string } = {},
): Promise<GrokInjectResult> {
  const { syncGrokConfig } = await import("../grok/sync");
  return syncGrokConfig(port, config, opts);
}

const productionDeps: EnsureDesiredIntegrationsDeps = {
  loadConfig,
  stripGrokConfig,
  syncGrokConfig: defaultSyncGrokConfig,
  removeDesktop3pStandardPivot,
};

function io(deps: EnsureDesiredIntegrationsDeps): {
  log: (message: string) => void;
  error: (message: string) => void;
} {
  return {
    log: deps.log ?? (message => console.log(message)),
    error: deps.error ?? (message => console.error(message)),
  };
}

/**
 * Keep ~/.grok/config.toml aligned with the durable Grok switch.
 *
 * `handleStart` already gates inject on `shouldSyncGrokOnStart`. `ocx ensure`
 * used to call `syncGrokConfig` unconditionally, so a dashboard/update/restart
 * path that lands in ensure rewrote the fence while the switch stayed OFF.
 * When the switch is OFF, strip any leftover managed block instead of injecting.
 */
export async function ensureGrokFenceMatchesDesired(
  port: number,
  opts: { hostname?: string } = {},
  deps: EnsureDesiredIntegrationsDeps = productionDeps,
): Promise<void> {
  const config = deps.loadConfig();
  const { log, error } = io(deps);
  if (!shouldSyncGrokOnStart(config)) {
    try {
      const grok = deps.stripGrokConfig();
      if (grok.changed) log(`   ↩️  ${grok.message}`);
      else if (!grok.ok) error(`⚠️  ${grok.message}`);
    } catch (err) {
      error(`⚠️  ${grokSyncFailureMessage(err)}`);
    }
    return;
  }
  try {
    const hostname = opts.hostname ?? config.hostname;
    const g = await deps.syncGrokConfig(
      port,
      config,
      hostname !== undefined ? { hostname } : {},
    );
    if (g.changed) log("   + Grok Build config updated (~/.grok/config.toml)");
    else if (!g.ok) error(`⚠️  ${g.message}`);
  } catch (err) {
    error(`⚠️  ${grokSyncFailureMessage(err)}`);
  }
}

/**
 * When Claude Desktop is durably OFF, clear any leftover owned gateway profile.
 * ensure/update used to leave Claude-3p residue in place after a failed disable
 * (drifted fingerprint), so the Integrations card kept looking applied/stale.
 */
export function ensureClaudeDesktopMatchesDesired(
  deps: EnsureDesiredIntegrationsDeps = productionDeps,
): void {
  const config = deps.loadConfig();
  const { log, error } = io(deps);
  if (claudeDesktopIntegrationEnabled(config)) return;
  try {
    const removed = deps.removeDesktop3pStandardPivot({
      appliedFingerprint: config.claudeCode?.desktopProfile?.appliedFingerprint ?? null,
    });
    if (removed.ok && removed.changed) {
      log("   ↩️  Claude Desktop integration residue removed.");
    } else if (!removed.ok) {
      error(`⚠️  Claude Desktop cleanup skipped: ${removed.reason ?? removed.kind}.`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    error(`⚠️  Claude Desktop cleanup failed: ${detail}.`);
  }
}

export type EnsureDesiredIntegrationsBranch =
  | { kind: "live"; hostname?: string }
  | { kind: "spawned" };

/**
 * Reconcile the two external integration files after either ensure race window.
 * Only the live proxy's observed bind host crosses this boundary; persisted
 * config is deliberately loaded inside each mutation helper.
 */
export async function reconcileEnsureDesiredIntegrations(
  port: number,
  branch: EnsureDesiredIntegrationsBranch,
  deps: EnsureDesiredIntegrationsDeps = productionDeps,
): Promise<void> {
  const liveHost = branch.kind === "live" ? branch.hostname : undefined;
  await ensureGrokFenceMatchesDesired(
    port,
    liveHost ? { hostname: liveHost } : {},
    deps,
  );
  ensureClaudeDesktopMatchesDesired(deps);
}
