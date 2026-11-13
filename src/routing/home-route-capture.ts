/**
 * Children inherit the Home's native switches as they stood when route intent began, never as they
 * are now: ocx restore, Messages off, Claude Desktop apply and the Claude toggle are Home-only.
 *
 * One idempotent capture freezes the four native defaults into route-intent.json. It runs before
 * a Home default write and at Child enrollment, and, only once the Home has a link, when its link
 * listener binds (a failure there is retried, see link-listener.ts) and before any Home-only
 * decision changes a switch. On a Home with no link Home-only decisions leave route-intent.json
 * alone, so a Child enrolled later inherits the switches as they stand at enrollment unless a Home
 * default write already saved them. Reads never capture. Once a default is saved it is never
 * captured again; only a Home default write changes it.
 */
import { readConfigDiagnostics } from "../config";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { setIntegrationEnabled, type CodexDesiredStateResult, type DurableIntentClientId } from "../codex/desired-state";
import { linkStorePath } from "../link/paths";
import { readLinkStore } from "../link/store";
import { HOME_NATIVE_ROUTE_CLIENTS, homeNativeRouteDefaults, type HomeNativeRouteClientId, type RouteClientIntent } from "../link/route-intent";
import type { OcxConfig } from "../types";
import { readRouteIntentState, routeIntentStatePath, updateRouteIntentState, type RouteIntentState } from "./route-intent-state";

function captured(state: RouteIntentState): boolean {
  return HOME_NATIVE_ROUTE_CLIENTS.every(client => state.defaults[client] !== undefined);
}

/**
 * Whether a linked Child inherits these defaults. An ephemeral `ocx-child` never reads route intent,
 * so a Home whose only links are ephemeral has nothing to protect. Unreadable trust metadata counts
 * as linked: a Child may still depend on these defaults.
 */
export function homeHasLinks(): boolean {
  try { return readLinkStore(linkStorePath()).links.some(link => link.childKind !== "ephemeral"); } catch { return true; }
}

export interface CaptureHomeRouteDefaultsOptions {
  /**
   * Every Home-only switch writer passes this: a Home without any link has no Child to protect
   * yet, so route-intent.json is neither read nor written for it.
   */
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
 * A Home-only switch write refused because the Children's defaults could not be saved first.
 * Writing the switch anyway would change what Children inherit once the file is repaired.
 */
export interface HomeRouteCaptureRefusal {
  readonly ok: false;
  readonly reason: "unavailable";
  readonly retryable: boolean;
  readonly message: string;
}

export type HomeIntegrationResult = CodexDesiredStateResult | HomeRouteCaptureRefusal;

/** Only SQLITE_BUSY is contention worth retrying; any other lock failure repeats forever. */
function lockContention(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "CONFIG_MUTATION_LOCK_UNAVAILABLE"
    && (error as { cause?: { code?: unknown } }).cause?.code === "SQLITE_BUSY";
}

export function captureRefusal(error: unknown): HomeRouteCaptureRefusal {
  const path = routeIntentStatePath();
  if (lockContention(error)) return { ok: false, reason: "unavailable", retryable: true,
    message: `Another process is saving the configuration, so the Children's route defaults in ${path} could not be saved first; nothing was changed. Retry in a moment.` };
  return { ok: false, reason: "unavailable", retryable: false,
    message: `The Children's route defaults in ${path} could not be read or saved; nothing was changed. Inspect it, fix or remove it, then retry.` };
}

/** `captureHomeRouteDefaults` for the Home-only switch writers: a failure is a typed refusal, never a throw. */
export function captureHomeRouteDefaultsBeforeHomeSwitch(): HomeRouteCaptureRefusal | null {
  try {
    captureHomeRouteDefaults(undefined, { whenLinked: true });
    return null;
  } catch (error) {
    return captureRefusal(error);
  }
}

/**
 * The Home-only switch writers (ocx restore, ocx restore back, Claude Desktop apply from the CLI
 * and the dashboard) go through here. desired-state.ts itself stays free of link state: it is on
 * the always-on request path (tests/lab/core-link-boundary.test.ts).
 */
export function setHomeIntegrationEnabled(client: DurableIntentClientId, enabled: boolean): HomeIntegrationResult {
  return captureHomeRouteDefaultsBeforeHomeSwitch() ?? setIntegrationEnabled(client, enabled);
}
