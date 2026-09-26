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
import { cliFirstPartyDesired, firstPartyDesired, reconcileClaudeFirstPartySettings } from "../claude/first-party-settings";
import { claudeInterceptEnabled } from "../claude/intercept/runtime";
import { removeDesktopPickerArtifacts } from "../claude/desktop-picker";
import { findLiveProxy } from "../server/proxy-liveness";
import { runtimeRequest } from "./runtime-api";
import { stripGrokConfig, type GrokInjectResult } from "../grok/inject";
import { inspectDesktop3pConfigLibrary, removeDesktop3pStandardPivot } from "../claude/desktop-3p";
import {
  applyDesktopFirstParty,
  inspectDesktopFirstParty,
  observeClaudeDesktopMode,
  removeDesktopFirstParty,
  resolveClaudeDesktopMode,
} from "../claude/desktop-first-party";
import {
  claudeDesktopIntegrationEnabled,
  grokIntegrationEnabled,
  HUB_GATED_SKIP_MESSAGE,
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
  removeDesktopFirstParty?: typeof removeDesktopFirstParty;
  applyDesktopFirstParty?: typeof applyDesktopFirstParty;
  inspectDesktopFirstParty?: typeof inspectDesktopFirstParty;
  observeClaudeDesktopMode?: typeof observeClaudeDesktopMode;
  reconcileClaudeFirstPartySettings?: typeof reconcileClaudeFirstPartySettings;
  inspectDesktop3pConfigLibrary?: typeof inspectDesktop3pConfigLibrary;
  findLiveProxyImpl?: typeof findLiveProxy;
  runtimeRequestImpl?: typeof runtimeRequest;
  removeDesktopPickerArtifacts?: typeof removeDesktopPickerArtifacts;
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
  // A hub-gated skip is NOT "the user turned Grok off" (#4236). Stripping the managed block
  // there deleted a fence the operator still wants — and `ocx ensure` reported it as the
  // Grok toggle doing its job. Only an explicit OFF authorizes the strip; the gate just
  // declines to write, and says which key would let it.
  if (!shouldSyncGrokOnStart(config) && grokIntegrationEnabled(config)) {
    log(`   ${HUB_GATED_SKIP_MESSAGE} ~/.grok/config.toml was left exactly as it is.`);
    return;
  }
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
 * When Claude Desktop is durably OFF, clear any leftover owned gateway profile and the
 * first-party settings env. ensure/update used to leave Claude-3p residue in place after a
 * failed disable (drifted fingerprint), so the Integrations card kept looking applied/stale.
 *
 * When it is ON in first-party mode, refresh a stale env (the intercept port follows the
 * public port, so a port change would otherwise leave Claude Code pointed at a dead proxy).
 */
export async function ensureClaudeDesktopMatchesDesired(
  deps: EnsureDesiredIntegrationsDeps = productionDeps,
): Promise<void> {
  const config = deps.loadConfig();
  const { log, error } = io(deps);
  if (cliFirstPartyDesired(config)) {
    const seen = (deps.inspectDesktopFirstParty ?? inspectDesktopFirstParty)(config);
    if (seen.settings.kind === "absent" || seen.stale || !claudeInterceptEnabled(config)) {
      const result = (deps.reconcileClaudeFirstPartySettings ?? reconcileClaudeFirstPartySettings)(config,
        firstPartyDesired(config, (deps.observeClaudeDesktopMode ?? observeClaudeDesktopMode)(config)));
      if (result.ok && result.changed) log(`   + Claude CLI first-party env refreshed (${result.path})`);
      else if (!result.ok) error(`⚠️  Claude CLI first-party env refresh skipped: ${result.reason}.`);
    }
  }
  if (claudeDesktopIntegrationEnabled(config)) {
    if (resolveClaudeDesktopMode(config, (deps.observeClaudeDesktopMode ?? observeClaudeDesktopMode)(config)) !== "first-party") return;
    const library = (deps.inspectDesktop3pConfigLibrary ?? inspectDesktop3pConfigLibrary)({
      appliedFingerprint: config.claudeCode?.desktopProfile?.appliedFingerprint ?? null,
    });
    if (library.kind === "gateway_ours" || library.kind === "gateway_drifted") {
      // The mode marker and the disk disagree. Replacing a live Desktop profile is an operator
      // action, not something an update hook should do silently.
      error("⚠️  Claude Desktop mode is first-party but a gateway profile is still applied; run `ocx claude desktop apply --first-party` (or `--gateway`) to reconcile.");
      return;
    }
    const seen = (deps.inspectDesktopFirstParty ?? inspectDesktopFirstParty)(config);
    if (!seen.stale) return;
    const applied = (deps.applyDesktopFirstParty ?? applyDesktopFirstParty)(config);
    if (applied.ok && applied.changed) log(`   + Claude Desktop first-party env refreshed (${applied.path})`);
    else if (!applied.ok) error(`⚠️  Claude Desktop first-party env refresh skipped: ${applied.reason}.`);
    return;
  }
  try {
    const live = await (deps.findLiveProxyImpl ?? findLiveProxy)();
    if (live) {
      const request = deps.runtimeRequestImpl ?? runtimeRequest;
      await request(
        "/api/claude-desktop/picker",
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, persist: false }) },
        deps.findLiveProxyImpl ? { findLiveProxy: deps.findLiveProxyImpl } : {},
      );
    } else {
      const removed = await (deps.removeDesktopPickerArtifacts ?? removeDesktopPickerArtifacts)({});
      if (!removed.ok) error(`⚠️  Claude Desktop picker cleanup skipped${removed.residual?.length ? `: ${removed.residual.join(", ")}` : ""}.`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    error(`⚠️  Claude Desktop picker cleanup skipped: ${detail}.`);
  }
  try {
    const env = (deps.removeDesktopFirstParty ?? removeDesktopFirstParty)(deps.loadConfig());
    if (env.ok && env.changed) log("   ↩️  Claude Desktop first-party env removed.");
    else if (env.ok && env.retainedFor === "cli") log("   = Shared first-party env retained for Claude Code CLI.");
    else if (!env.ok) error(`⚠️  Claude Desktop first-party env cleanup skipped: ${env.reason} (${env.path}).`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    error(`⚠️  Claude Desktop first-party env cleanup failed: ${detail}.`);
  }
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
  await ensureClaudeDesktopMatchesDesired(deps);
}
