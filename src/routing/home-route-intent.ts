/** Upgrade bridge: existing journaled integrations are Home intent, never unowned file guesses. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { createIntegrationStateStore, type IntegrationStateStore } from "../integrations/store";
import { listAsideProfileStores } from "../integrations/aside-profile-context";
import { asideHomeDir } from "../clients/config-export";
import { parseRouteClientIntent, projectHomeRouteIntent, ROUTE_CLIENT_IDS, type RouteClientId, type RouteIntentState } from "../link/route-intent";
import { readRouteIntentState, updateRouteIntentState } from "./route-intent-state";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import type { OcxConfig } from "../types";

export function readHomeRouteIntentState(config: OcxConfig, options: { store?: IntegrationStateStore; home?: string; state?: RouteIntentState } = {}): RouteIntentState {
  const state = structuredClone(options.state ?? readRouteIntentState());
  const store = options.store ?? createIntegrationStateStore();
  const records = store.readRecordsStrict();
  for (const [client, owner] of Object.entries(records)) {
    if (state.defaults[client as keyof typeof state.defaults] !== undefined || !owner || client === "aside") continue;
    const intent = parseRouteClientIntent({ enabled: true, ...(owner.modelNames ? { modelNames: owner.modelNames } : {}) });
    if (intent) state.defaults[client as keyof typeof state.defaults] = intent;
  }
  if (state.defaults.aside !== undefined) return state;
  const scopes = listAsideProfileStores(store).filter(scope => scope.store.readRecordsStrict().aside);
  if (!records.aside && scopes.length === 0 && config.asideProfileSync?.allProfiles !== true) return state;
  if (config.asideProfileSync?.allProfiles === true) {
    state.defaults.aside = { enabled: true, accounts: "all" };
    return state;
  }
  const raw: unknown = JSON.parse(readBoundedRegularFileSync(join(asideHomeDir(process.env, options.home ?? homedir()), "accounts.json"), 4 * 1024 * 1024).toString("utf8"));
  if (!raw || typeof raw !== "object" || !("accounts" in raw) || !Array.isArray(raw.accounts)) throw new Error("existing Aside selection needs explicit route intent");
  const slots = new Set(scopes.map(scope => scope.profileId));
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
  state.defaults.aside = intent;
  return state;
}

/** Capture defaults before a local materializer changes legacy native switches or owners. */
export function initializeHomeRouteIntentDefaults(config: OcxConfig, version: string, decidingDefault?: RouteClientId): void {
  const prior = readRouteIntentState();
  if (decidingDefault) prior.defaults[decidingDefault] = { enabled: false };
  const inherited = projectHomeRouteIntent(config, version, undefined, readHomeRouteIntentState(config, { state: prior }));
  updateRouteIntentState(state => {
    for (const [client, intent] of Object.entries(inherited.clients)) {
      state.defaults[client as keyof typeof state.defaults] ??= intent;
    }
    return state;
  });
}

/** Provisioning runs under Home authority, before the read-only Child starts. */
export function seedRouteDeviceClients(config: OcxConfig, version: string, deviceId: string, selected: readonly RouteClientId[] = ["codex", "claude"], activeDeviceIds?: readonly string[]): void {
  withConfigMutationLockSync(() => {
    if (activeDeviceIds) reconcileHomeRouteDevices(activeDeviceIds);
    initializeHomeRouteIntentDefaults(config, version);
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
