/** Upgrade bridge: existing journaled integrations are Home intent, never unowned file guesses. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { createIntegrationStateStore, type IntegrationStateStore } from "../integrations/store";
import { listAsideProfileStores } from "../integrations/aside-profile-context";
import { asideHomeDir } from "../clients/config-export";
import { parseRouteClientIntent, projectHomeRouteIntent, ROUTE_CLIENT_IDS, type HomeRouteIntentDocument, type RouteClientId, type RouteClientIntent, type RouteIntentState } from "../link/route-intent";
import { dropHomeNativeOverrides, homeRouteIntentInUse, readRouteIntentState, setRouteClientIntent, updateRouteIntentState } from "./route-intent-state";
import { captureHomeRouteDefaults, durableHomeNativeRouteDefaults, fillHomeNativeRouteDefaults, homeHasLinks, type CaptureHomeRouteDefaultsOptions } from "./home-route-capture";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { readConfigDiagnostics } from "../config";
import { packageVersion } from "../lib/package-version";
import type { OcxConfig } from "../types";

/** Existing Aside ownership must be resolved explicitly, never projected as off. */
export class HomeAsideIntentDerivationError extends Error {
  constructor(cause: unknown) {
    super("Existing Aside ownership needs an explicit Home route intent", { cause });
    this.name = "HomeAsideIntentDerivationError";
  }
}

export function readHomeRouteIntentState(config: OcxConfig, options: { store?: IntegrationStateStore; home?: string; state?: RouteIntentState } = {}): RouteIntentState {
  const state = structuredClone(options.state ?? readRouteIntentState());
  const store = options.store ?? createIntegrationStateStore();
  const records = store.readRecordsStrict();
  for (const [client, owner] of Object.entries(records)) {
    if (state.defaults[client as keyof typeof state.defaults] !== undefined || !owner || client === "aside") continue;
    const intent = parseRouteClientIntent({ enabled: true, ...(owner.modelNames ? { modelNames: owner.modelNames } : {}) });
    if (intent) state.defaults[client as keyof typeof state.defaults] = intent;
  }
  // A Home override does not resolve the default inherited by Children.
  if (state.defaults.aside !== undefined) return state;
  // The Home decision may already have changed or removed its ownership records. They no longer
  // prove what Children inherited before that decision, even when there are no records left.
  if (state.devices.home?.aside !== undefined) throw new HomeAsideIntentDerivationError(undefined);
  const aside = deriveHomeAsideIntent(config, { store, home: options.home });
  if (aside) state.defaults.aside = aside;
  return state;
}

/**
 * For status reads and the Home's own sync: existing Aside ownership that cannot be named by stable
 * userIds leaves the Children's Aside default unresolved. The returned state then carries a
 * placeholder off default only so a document can be projected; a device without its own Aside entry
 * must be reported as unresolved (`routeToAsideUnresolved`), never as off.
 */
export function readHomeRouteIntentStateAsideTolerant(config: OcxConfig, options: { state?: RouteIntentState } = {}): { state: RouteIntentState; asideUnresolved: boolean } {
  try { return { state: readHomeRouteIntentState(config, options), asideUnresolved: false }; }
  catch (error) {
    if (!(error instanceof HomeAsideIntentDerivationError)) throw error;
    const pinned = structuredClone(options.state ?? readRouteIntentState());
    pinned.defaults.aside = { enabled: false };
    return { state: readHomeRouteIntentState(config, { state: pinned }), asideUnresolved: true };
  }
}

/**
 * The Aside intent the Home's current Aside ownership amounts to: the stable userIds of every owned
 * profile, all profiles under the all-profiles policy, or undefined when nothing is owned.
 * `extraProfileIds` adds profiles about to be enabled, so a caller can refuse before writing
 * anything when one of them has no stable userId. Throws HomeAsideIntentDerivationError.
 */
export function deriveHomeAsideIntent(config: OcxConfig, options: { store?: IntegrationStateStore; home?: string; extraProfileIds?: readonly number[] | "all" } = {}): RouteClientIntent | undefined {
  const store = options.store ?? createIntegrationStateStore();
  const records = store.readRecordsStrict();
  const scopes = listAsideProfileStores(store).filter(scope => scope.store.readRecordsStrict().aside);
  const extra = options.extraProfileIds ?? [];
  if (!records.aside && scopes.length === 0 && extra.length === 0 && config.asideProfileSync?.allProfiles !== true) return undefined;
  if (config.asideProfileSync?.allProfiles === true) return { enabled: true, accounts: "all" };
  try {
    const raw: unknown = JSON.parse(readBoundedRegularFileSync(join(asideHomeDir(process.env, options.home ?? homedir()), "accounts.json"), 4 * 1024 * 1024).toString("utf8"));
    if (!raw || typeof raw !== "object" || !("accounts" in raw) || !Array.isArray(raw.accounts)) throw new Error("existing Aside selection needs explicit route intent");
    const every = extra === "all" ? raw.accounts.flatMap((row: unknown) => row && typeof row === "object" && "id" in row && typeof row.id === "number" ? [row.id] : []) : extra;
    const slots = new Set([...scopes.map(scope => scope.profileId), ...every]);
    if (records.aside) {
      const root = asideHomeDir(process.env, options.home ?? homedir());
      const owned = resolve(records.aside.configPath);
      const matches = raw.accounts.filter((row: unknown) => row && typeof row === "object" && "id" in row
        && typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id >= 0
        && resolve(join(root, "u", String(row.id), "models.json")) === owned);
      if (matches.length !== 1) throw new Error("existing Aside owner needs explicit route intent");
      slots.add(matches[0].id);
    }
    const userIds: string[] = [];
    for (const slot of slots) {
      const row = raw.accounts.find((value: unknown) => value && typeof value === "object" && "id" in value && value.id === slot);
      if (!row || typeof row !== "object" || !("userId" in row) || typeof row.userId !== "string") throw new Error("existing Aside selection needs explicit stable userIds");
      userIds.push(row.userId);
    }
    const intent = parseRouteClientIntent({ enabled: true, accounts: [...new Set(userIds)] }, "aside");
    if (!intent) throw new Error("existing Aside selection needs explicit stable userIds");
    return intent;
  } catch (cause) {
    throw new HomeAsideIntentDerivationError(cause);
  }
}

/**
 * Records a Home Aside profile change (the dashboard, `ocx integration client enable --client aside
 * --profile N`, an Aside restore) as the Home's `devices.home.aside` decision, naming the stable
 * userIds of every profile it owns afterwards, so ocx sync keeps it. Only once the Home uses route
 * intent; returns whether a decision was recorded. Throws HomeAsideIntentDerivationError.
 */
export function recordHomeAsideDecision(config: OcxConfig): boolean {
  return withConfigMutationLockSync(() => {
    if (!homeRouteIntentInUse(readRouteIntentState())) return false;
    setRouteClientIntent("aside", deriveHomeAsideIntent(config) ?? { enabled: false }, "home");
    return true;
  });
}

/**
 * Capture defaults before a local materializer changes native switches or owners. The native
 * defaults come from the shared one-time capture; every other client from ownership or builtin.
 * A Home-only decision passes `whenLinked`, the rule every Home-only switch writer follows: a Home
 * without links has no Child to protect, so nothing reads or writes route-intent.json for it. Saving
 * ownership defaults there would pin clients the dashboard later turns on (ocx sync applies saved
 * defaults), and a damaged file would block a toggle that never needed it.
 */
export function initializeHomeRouteIntentDefaults(config: OcxConfig, version: string, decidingDefault?: RouteClientId,
  options: CaptureHomeRouteDefaultsOptions = {}): void {
  if (options.whenLinked && !homeHasLinks()) return;
  withConfigMutationLockSync(() => {
    // Every default is derived before anything is written: an Aside refusal leaves the file as it was.
    const native = durableHomeNativeRouteDefaults(config);
    const prior = readRouteIntentState();
    if (native) fillHomeNativeRouteDefaults(prior, native);
    if (decidingDefault) prior.defaults[decidingDefault] = { enabled: false };
    const inherited = projectHomeRouteIntent(config, version, undefined, readHomeRouteIntentState(config, { state: prior }));
    updateRouteIntentState(state => {
      if (native) fillHomeNativeRouteDefaults(state, native);
      for (const [client, intent] of Object.entries(inherited.clients)) state.defaults[client as keyof typeof state.defaults] ??= intent;
      // A `devices.home` native entry from an earlier version no longer decides anything.
      dropHomeNativeOverrides(state);
      return state;
    });
  });
}

/**
 * The link listener's capture of every default a Child inherits, from the Home's durable config:
 * the native switches and the file clients' ownership, frozen in one write. An upgraded Home that
 * saved only the native defaults gets the rest here, so a later dashboard toggle cannot move a
 * Child's default. When existing Aside ownership cannot be resolved nothing else is saved; the
 * native defaults are then captured on their own and the error is raised so the listener retries.
 */
export function captureChildRouteDefaults(): void {
  const latest = readConfigDiagnostics();
  if (latest.error) throw new Error("the configuration could not be read");
  if (latest.config.runtimeRole === "client") return;
  try {
    initializeHomeRouteIntentDefaults(latest.config, packageVersion("0.0.0"), undefined, { whenLinked: true });
  } catch (error) {
    if (error instanceof HomeAsideIntentDerivationError) captureHomeRouteDefaults(undefined, { whenLinked: true });
    throw error;
  }
}

/**
 * What a Child inherits. Never reads the Home's live native switches; see home-route-capture.
 * A pure read: enrollment and the link listener's start have already captured the native defaults.
 */
export function projectChildRouteIntent(config: OcxConfig, version: string, deviceId: string): HomeRouteIntentDocument {
  const { state, asideUnresolved } = readHomeRouteIntentStateAsideTolerant(config);
  if (asideUnresolved && state.devices[deviceId]?.aside === undefined) throw new HomeAsideIntentDerivationError(undefined);
  return projectHomeRouteIntent(config, version, deviceId, state);
}

/** Provisioning runs under Home authority, before the read-only Child starts. */
export function seedRouteDeviceClients(config: OcxConfig, version: string, deviceId: string, selected?: readonly RouteClientId[], activeDeviceIds?: readonly string[]): void {
  withConfigMutationLockSync(() => {
    if (activeDeviceIds) reconcileHomeRouteDevices(activeDeviceIds);
    initializeHomeRouteIntentDefaults(config, version);
    // Absence means inherit, not an implicit device selection that masks Home changes.
    if (selected === undefined) return;
    updateRouteIntentState(state => {
      const overrides = (state.devices[deviceId] ??= {});
      const revisions = ((state.revisions ??= {})[deviceId] ??= {});
      for (const client of ROUTE_CLIENT_IDS) {
        if (client !== "codex" && client !== "claude" && !selected.includes(client)) continue;
        overrides[client] = { ...(overrides[client] ?? {}), enabled: selected.includes(client) };
        revisions[client] = (revisions[client] ?? 0) + 1;
      }
      return state;
    });
  });
}

/** Trust retirement also retires policy/revisions; Home and live peers retain their state. */
export function reconcileHomeRouteDevices(activeDeviceIds: readonly string[]): void {
  const live = new Set(["home", ...activeDeviceIds]);
  updateRouteIntentState(state => {
    for (const map of [state.devices, state.revisions]) {
      for (const id of Object.keys(map ?? {})) if (!live.has(id)) delete map![id];
    }
    return state;
  });
}
