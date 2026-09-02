/**
 * Durable desired state for the native Codex integration.
 *
 * The switch itself was never the hard part — `ocx restore` already returns Codex
 * to its native path without stopping the proxy. What was missing is that the
 * decision did not survive: `ocx start` force-synced unconditionally, so an OFF
 * lasted exactly until the next start. That is the defect this module closes, and
 * it is the same one Grok's shipped toggle still has.
 *
 * ABSENT MEANS ON. A user who never touched a switch, a config written by an
 * older binary, and an explicit `true` are the same state, and none of them may
 * be read as "the user turned this off". Only an explicit `false` is OFF.
 *
 * This module does NOT own linearization. The plan that predates
 * `src/codex/user-identity.ts` proposed a second per-home lock at
 * `tmpdir()/opencodex-native-locks/sha256(home).sqlite`; that keys on the home
 * alone, carries no proof of effective user, and would collide or split
 * depending on the temp root. Convergence takes the write lock; this module only
 * records intent through the config coordinator.
 *
 * Design record: devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md.
 */
import { deleteConfigTopLevelKey, loadConfig, mutatePersistedConfig } from "../config";
import type { OcxClientIntegrationsConfig, OcxConfig } from "../types";
import { runStartupReadinessSync, type ReadinessGate, type SyncOutcomeLike } from "../server/readiness";

/** Clients whose durable intent this module owns. */
export type DurableIntentClientId = keyof OcxClientIntegrationsConfig;

/** Injectable for tests; production passes the real sync. */
/**
 * The startup sync result the caller needs to decide whether anything was
 * actually written (#1046). It used to be `unknown`, so "a write happened" was
 * not observable at the startup boundary and no post-write action could be
 * gated on it.
 */
export interface CodexStartupSyncOutcome {
  catalogWritten: boolean;
  cacheSynced: boolean;
  /** Readiness-observable fields carried by the raw startup sync. */
  ok?: boolean;
  warning?: string;
}
export type CodexStartupSync = (port: number) => Promise<SyncOutcomeLike | undefined>;

export type CodexDesiredStateResult =
  | { readonly ok: true; readonly status: "committed" | "unchanged"; readonly enabled: boolean }
  | {
      readonly ok: false;
      readonly reason: "missing" | "invalid" | "conflict";
      readonly retryable: boolean;
      readonly message: string;
    };

/**
 * Is native Codex integration wanted?
 *
 * Takes the config rather than reading it, so a caller that already holds an
 * admitted snapshot cannot accidentally answer from a fresher one — the whole
 * point of admission is that one decision uses one set of bytes.
 */
export function integrationEnabled(
  config: Pick<OcxConfig, "clientIntegrations">,
  client: DurableIntentClientId,
): boolean {
  return config.clientIntegrations?.[client] !== false;
}

export function codexIntegrationEnabled(config: Pick<OcxConfig, "clientIntegrations">): boolean {
  return integrationEnabled(config, "codex");
}

/** Whether a Codex sync is permitted for this admitted config snapshot. */
type LocalClientSyncConfig = Pick<
  OcxConfig,
  "clientIntegrations" | "runtimeRole" | "unauthenticatedLoopbackListener"
>;

function localClientSyncAllowed(config: LocalClientSyncConfig): boolean {
  return config.runtimeRole !== "hub"
    || config.unauthenticatedLoopbackListener?.enabled === true;
}

export function shouldSyncCodexOnStart(config: LocalClientSyncConfig): boolean {
  // A hub is a server for OTHER machines: it must not rewrite its own host's
  // Codex/Claude/Grok client configs on startup (interview decision Q6, and the
  // first clisu-oracle dogfood boot proved the failure mode — the hub marked
  // /readyz failed because it tried to run the full local client sync).
  // A hub can be a local client only through its explicitly enabled loopback
  // listener. The public hub bind remains outside this gate and still requires
  // admission; an explicit client OFF continues to win.
  return localClientSyncAllowed(config) && codexIntegrationEnabled(config);
}

/**
 * Grok's toggle SHIPPED without this, which is the bug: it strips the fence in
 * `~/.grok/config.toml` and records nothing, so the next `ocx start` calls
 * `syncGrokConfig` unconditionally and writes the fence straight back.
 */
export function grokIntegrationEnabled(config: Pick<OcxConfig, "clientIntegrations">): boolean {
  return integrationEnabled(config, "grok");
}

/** The same question when no snapshot is in hand. Reads the persisted config. */
export function codexIntegrationEnabledNow(): boolean {
  return codexIntegrationEnabled(loadConfig());
}

/**
 * Persist the desired state, touching only that one field.
 *
 * Field-scoped on purpose: the callback runs on a freshly rebased snapshot inside
 * the config coordinator, so a concurrent provider or model edit is preserved
 * instead of being clobbered by a whole-config write built from a stale read.
 */
export function setIntegrationEnabled(
  client: DurableIntentClientId,
  enabled: boolean,
): CodexDesiredStateResult {
  const outcome = mutatePersistedConfig(config => {
    const current = integrationEnabled(config, client);
    if (current === enabled) return { changed: false, value: enabled };
    const integrations = { ...(config.clientIntegrations ?? {}) };
    if (enabled) {
      // ON is the absence, not a stored `true`: writing `true` would make an
      // untouched config and a re-enabled one differ in bytes for no reason, and
      // every later reader has to treat them identically anyway.
      delete integrations[client];
    } else {
      integrations[client] = false;
    }
    // Drop the key entirely once nothing is left in it, so enabling twice does
    // not leave `"clientIntegrations": {}` behind in the user's file.
    if (Object.keys(integrations).length === 0) deleteConfigTopLevelKey(config, "clientIntegrations");
    else config.clientIntegrations = integrations;
    return { changed: true, value: enabled };
  });

  if (outcome.status !== "unavailable") {
    return { ok: true, status: outcome.status, enabled };
  }
  // `conflict` is the only retryable one: it means a competing writer won the
  // rebase, so the same call can succeed. A missing or malformed config will fail
  // identically forever, and telling a caller to retry that is how a UI ends up
  // spinning on a problem only the user can fix.
  const retryable = outcome.reason === "conflict";
  return {
    ok: false,
    reason: outcome.reason,
    retryable,
    message: outcome.reason === "conflict"
      ? "Another process changed the config while this switch was being written."
      : outcome.reason === "missing"
        ? "No config file exists to record the switch in."
        : "The config file is malformed; refusing to overwrite it.",
  };
}

export function setCodexIntegrationEnabled(enabled: boolean): CodexDesiredStateResult {
  return setIntegrationEnabled("codex", enabled);
}

export function setGrokIntegrationEnabled(enabled: boolean): CodexDesiredStateResult {
  return setIntegrationEnabled("grok", enabled);
}

/** Whether Claude Desktop's managed gateway profile is wanted. */
export function claudeDesktopIntegrationEnabled(config: Pick<OcxConfig, "clientIntegrations">): boolean {
  return integrationEnabled(config, "claude-desktop");
}

/** The same question when no admitted config snapshot is in hand. */
export function claudeDesktopIntegrationEnabledNow(): boolean {
  return claudeDesktopIntegrationEnabled(loadConfig());
}

export function setClaudeDesktopIntegrationEnabled(enabled: boolean): CodexDesiredStateResult {
  return setIntegrationEnabled("claude-desktop", enabled);
}

/**
 * The startup gate, as a function rather than an `if` buried in `handleStart`.
 *
 * `ocx start` used to call `syncModelsToCodex(port).catch(() => {})`
 * unconditionally, which is exactly why turning Codex off lasted until the next
 * start: the restore worked, and then start put the routing straight back. It
 * lived inline in a 600-line startup function that opens sockets and installs
 * services, so nothing could test it — and an untestable gate is how the
 * unconditional version survived this long.
 *
 * The `.catch` is deliberate and stays: a provider fetch failing at startup must
 * not stop the proxy from coming up. Swallowing a failure to APPLY is tolerable.
 * Swallowing the user's decision was not.
 *
 * Returns whether the sync ran, so a caller — or a test — can tell "skipped
 * because the user turned it off" from "ran and quietly failed", plus what it
 * wrote when it did run (#1046 — the caller warns about stale app-servers only
 * after a real write).
 */
export async function syncCodexOnStartIfEnabled(
  port: number,
  config: LocalClientSyncConfig,
  sync: CodexStartupSync = defaultStartupSync,
  readinessGate?: ReadinessGate,
): Promise<{ ran: boolean; catalogWritten: boolean; cacheSynced: boolean }> {
  if (!shouldSyncCodexOnStart(config)) {
    // The user explicitly turned Codex off: there is nothing to sync, so the
    // proxy is ready as soon as it is up. The gate is driven here so /readyz
    // does not stay pending forever for a deployment that deliberately disabled
    // the native Codex integration.
    readinessGate?.markReady();
    return { ran: false, catalogWritten: false, cacheSynced: false };
  }
  // The `.catch` is deliberate and stays: a failure to APPLY must not stop the
  // proxy from coming up. A failed sync simply reports no writes. The readiness
  // gate observes the real outcome so /readyz reflects the sync state exactly as
  // the PR contract defines (ready only on ok=true with no warning).
  const outcome = readinessGate
    ? await runStartupReadinessSync(readinessGate, async () => (await sync(port)) ?? null)
    : await sync(port).catch(() => undefined);
  return {
    ran: true,
    catalogWritten: outcome?.catalogWritten === true,
    cacheSynced: outcome?.cacheSynced === true,
  };
}

async function defaultStartupSync(port: number): Promise<CodexStartupSyncOutcome> {
  const { syncModelsToCodex } = await import("./sync");
  return syncModelsToCodex(port);
}

/**
 * The Grok startup gate.
 *
 * Grok's toggle shipped and then `ocx start` called `syncGrokConfig`
 * unconditionally, so switching Grok off lasted exactly one restart — the fence
 * came out of `~/.grok/config.toml` and the next start wrote it straight back.
 * Same defect as Codex had, in a different file.
 *
 * The caller keeps its own try/catch, because a Grok failure must never block
 * startup and its diagnostic is worth printing. This only answers whether to
 * attempt the sync at all.
 */
export function shouldSyncGrokOnStart(config: LocalClientSyncConfig): boolean {
  return localClientSyncAllowed(config) && grokIntegrationEnabled(config);
}
