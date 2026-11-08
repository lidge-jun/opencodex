/**
 * Children inherit the Home's native switches as they stood when route intent began, never as they
 * are now: ocx restore, Messages off, Claude Desktop apply and the Claude toggle are Home-only.
 *
 * One idempotent capture freezes the four native defaults into route-intent.json. It runs before
 * any Home native switch writer changes a switch, when the Home's link listener binds, before a
 * Child projection, and inside every route-intent initialization. Once a default is saved it is
 * never captured again; only a Home default write (`ocx route to <client> on|off`) changes it.
 */
import { readConfigDiagnostics } from "../config";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { setIntegrationEnabled, type CodexDesiredStateResult, type DurableIntentClientId } from "../codex/desired-state";
import { linkStorePath } from "../link/paths";
import { readLinkStore } from "../link/store";
import { HOME_NATIVE_ROUTE_CLIENTS, homeNativeRouteDefaults, type HomeNativeRouteClientId, type RouteClientIntent } from "../link/route-intent";
import type { OcxConfig } from "../types";
import { readRouteIntentState, updateRouteIntentState, type RouteIntentState } from "./route-intent-state";

function captured(state: RouteIntentState): boolean {
  return HOME_NATIVE_ROUTE_CLIENTS.every(client => state.defaults[client] !== undefined);
}

/** Unreadable trust metadata counts as linked: a Child may still depend on these defaults. */
function homeHasLinks(): boolean {
  try { return readLinkStore(linkStorePath()).links.length > 0; } catch { return true; }
}

export interface CaptureHomeRouteDefaultsOptions {
  /** Switch writers pass this: a Home without any link has no Child to protect yet. */
  whenLinked?: boolean;
}

/** The native defaults the Home's durable switches give (`fallback` only when the file is unreadable); null on a Child. */
export function durableHomeNativeRouteDefaults(fallback?: OcxConfig): Record<HomeNativeRouteClientId, RouteClientIntent> | null {
  const latest = readConfigDiagnostics();
  const durable = latest.source === "file" && !latest.error ? latest.config : fallback;
  return !durable || durable.runtimeRole === "client" ? null : homeNativeRouteDefaults(durable);
}

/** Fills only the missing native defaults; a saved one is never captured again. */
export function fillHomeNativeRouteDefaults(state: RouteIntentState, defaults: Record<HomeNativeRouteClientId, RouteClientIntent>): boolean {
  let filled = false;
  for (const client of HOME_NATIVE_ROUTE_CLIENTS) {
    if (state.defaults[client] !== undefined) continue;
    state.defaults[client] = defaults[client];
    filled = true;
  }
  return filled;
}

/**
 * Saves the missing native defaults from the durable switches (`fallback` only when the config
 * file is unreadable). A Child never captures. Returns whether anything was saved.
 */
export function captureHomeRouteDefaults(fallback?: OcxConfig, options: CaptureHomeRouteDefaultsOptions = {}): boolean {
  if (fallback?.runtimeRole === "client") return false;
  if (options.whenLinked && !homeHasLinks()) return false;
  if (captured(readRouteIntentState())) return false;
  return withConfigMutationLockSync(() => {
    const defaults = durableHomeNativeRouteDefaults(fallback);
    if (!defaults) return false;
    let saved = false;
    updateRouteIntentState(state => { saved = fillHomeNativeRouteDefaults(state, defaults); return state; });
    return saved;
  });
}

/**
 * The Home-only switch writers (ocx restore, ocx restore back, Claude Desktop apply from the CLI
 * and the dashboard) go through here. desired-state.ts itself stays free of link state: it is on
 * the always-on request path (tests/lab/core-link-boundary.test.ts).
 */
export function setHomeIntegrationEnabled(client: DurableIntentClientId, enabled: boolean): CodexDesiredStateResult {
  captureHomeRouteDefaults(undefined, { whenLinked: true });
  return setIntegrationEnabled(client, enabled);
}
