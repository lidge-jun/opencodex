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
 * Design record: devlog/_plan/260803_codex_desktop_toggle/030_desired_state.md.
 */
import { loadConfig, mutatePersistedConfig } from "../config";
import type { OcxClientIntegrationsConfig, OcxConfig } from "../types";

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
}
export type CodexStartupSync = (port: number) => Promise<CodexStartupSyncOutcome | undefined>;

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
    if (Object.keys(integrations).length === 0) delete config.clientIntegrations;
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
  config: Pick<OcxConfig, "clientIntegrations">,
  sync: CodexStartupSync = defaultStartupSync,
): Promise<{ ran: boolean; catalogWritten: boolean; cacheSynced: boolean }> {
  if (!codexIntegrationEnabled(config)) {
    return { ran: false, catalogWritten: false, cacheSynced: false };
  }
  // The `.catch` is deliberate and stays: a failure to APPLY must not stop the
  // proxy from coming up. A failed sync simply reports no writes.
  const outcome = await sync(port).catch(() => undefined);
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
export function shouldSyncGrokOnStart(config: Pick<OcxConfig, "clientIntegrations">): boolean {
  return grokIntegrationEnabled(config);
}
