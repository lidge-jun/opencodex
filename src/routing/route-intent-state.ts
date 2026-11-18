/** Home-owned desired policy. Reads never create or repair a file. */
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { emptyRouteIntentState, HOME_NATIVE_ROUTE_CLIENTS, isHomeNativeRouteClient, isRouteClientId, parseRouteClientIntent,
  type HomeNativeRouteClientId, type RouteClientId, type RouteClientIntent, type RouteIntentState } from "../link/route-intent";
export type { RouteIntentState } from "../link/route-intent";

const MAX_STATE_BYTES = 1024 * 1024;
export function routeIntentStatePath(): string { return join(getConfigDir(), "route-intent.json"); }

/**
 * `route-intent.json` exists but cannot be read or parsed. Writers answer it with a typed refusal
 * that names the file, because only the operator can fix or remove it.
 */
export class RouteIntentStateUnreadableError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`Route intent in ${path} could not be read; nothing was changed. Inspect it, fix or remove it, then retry.`, { cause });
    this.name = "RouteIntentStateUnreadableError";
    this.path = path;
  }
}
function deviceIdAllowed(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
}
function parseIntentMap(value: unknown): Partial<Record<RouteClientId, RouteClientIntent>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid route intent map");
  const result: Partial<Record<RouteClientId, RouteClientIntent>> = {};
  for (const [client, raw] of Object.entries(value)) {
    if (!isRouteClientId(client)) throw new Error("unknown route client");
    const intent = parseRouteClientIntent(raw, client);
    if (!intent) throw new Error("invalid route client intent");
    result[client] = intent;
  }
  return result;
}
export function parseRouteIntentState(value: unknown): RouteIntentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid route intent state");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || Object.keys(raw).some(key => !["version", "defaults", "devices", "revisions"].includes(key)) || !Object.hasOwn(raw, "defaults") || !Object.hasOwn(raw, "devices")
    || !raw.devices || typeof raw.devices !== "object" || Array.isArray(raw.devices)) throw new Error("invalid route intent state");
  const state = emptyRouteIntentState();
  state.defaults = parseIntentMap(raw.defaults);
  for (const [id, map] of Object.entries(raw.devices)) {
    if (!deviceIdAllowed(id)) throw new Error("invalid route device id");
    state.devices[id] = parseIntentMap(map);
  }
  if (raw.revisions !== undefined) {
    if (!raw.revisions || typeof raw.revisions !== "object" || Array.isArray(raw.revisions)) throw new Error("invalid route device revisions");
    state.revisions = {};
    for (const [id, map] of Object.entries(raw.revisions)) {
      if (!deviceIdAllowed(id) || !map || typeof map !== "object" || Array.isArray(map)) throw new Error("invalid route device revisions");
      const revisions: Partial<Record<RouteClientId, number>> = {};
      for (const [client, revision] of Object.entries(map)) {
        if (!isRouteClientId(client) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid route client revision");
        revisions[client] = revision;
      }
      state.revisions[id] = revisions;
    }
  }
  return state;
}
export function readRouteIntentState(path = routeIntentStatePath()): RouteIntentState {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("invalid route intent state file");
    return parseRouteIntentState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (isMissingPathError(error)) return emptyRouteIntentState();
    throw new RouteIntentStateUnreadableError(path, error);
  }
}
function writeState(state: RouteIntentState, path: string): void {
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dir);
  const body = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("route intent state too large");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(path, body);
}
export function writeRouteIntentState(state: RouteIntentState, path = routeIntentStatePath()): void {
  const parsed = parseRouteIntentState(state);
  withConfigMutationLockSync(() => writeState(parsed, path), dirname(path));
}
export function updateRouteIntentState(update: (state: RouteIntentState) => RouteIntentState, path = routeIntentStatePath()): RouteIntentState {
  return withConfigMutationLockSync(() => {
    const next = parseRouteIntentState(update(readRouteIntentState(path)));
    writeState(next, path);
    return next;
  }, dirname(path));
}
export function setRouteClientIntent(client: RouteClientId, intent: RouteClientIntent, deviceId?: string): RouteIntentState {
  const parsed = parseRouteClientIntent(intent, client);
  if (!isRouteClientId(client) || !parsed || (deviceId !== undefined && !deviceIdAllowed(deviceId))) throw new Error("invalid route intent selection");
  if (deviceId === "home" && isHomeNativeRouteClient(client)) throw new Error("A Home native decision is its native switch; use recordHomeNativeDecision");
  return updateRouteIntentState(state => {
    const map = deviceId === undefined ? state.defaults : (state.devices[deviceId] ??= {});
    map[client] = { ...map[client], ...parsed };
    if (deviceId !== undefined) advanceRevision(state, deviceId, client);
    return state;
  });
}
export function clearRouteClientIntent(client: RouteClientId, deviceId: string): RouteIntentState {
  if (!isRouteClientId(client) || !deviceIdAllowed(deviceId)) throw new Error("invalid route intent selection");
  if (deviceId === "home" && isHomeNativeRouteClient(client)) throw new Error("A Home native decision is its native switch; use recordHomeNativeDecision");
  return updateRouteIntentState(state => {
    const map = state.devices[deviceId];
    if (map) { delete map[client]; if (Object.keys(map).length === 0) delete state.devices[deviceId]; }
    advanceRevision(state, deviceId, client);
    return state;
  });
}

/**
 * Earlier versions recorded Home native decisions as `devices.home` entries. The Home's native
 * switches govern those clients now, so such an entry is dropped instead of pinning anything.
 */
export function dropHomeNativeOverrides(state: RouteIntentState, clients: readonly HomeNativeRouteClientId[] = HOME_NATIVE_ROUTE_CLIENTS): void {
  const map = state.devices.home;
  if (!map) return;
  for (const client of clients) delete map[client];
  if (Object.keys(map).length === 0) delete state.devices.home;
}

/** Drops those legacy entries from the file, writing only when one is there. */
export function dropLegacyHomeNativeOverrides(): void {
  withConfigMutationLockSync(() => {
    const map = readRouteIntentState().devices.home;
    if (!map || !HOME_NATIVE_ROUTE_CLIENTS.some(client => map[client] !== undefined)) return;
    updateRouteIntentState(state => { dropHomeNativeOverrides(state); return state; });
  });
}

/**
 * Bookkeeping for a Home decision about a native client, which itself is written to the Home's
 * native switch. No `devices.home` entry is kept. The caller has already captured the Children's
 * native defaults (src/routing/home-route-capture.ts), so the switch never becomes one.
 */
export function recordHomeNativeDecision(client: HomeNativeRouteClientId): RouteIntentState {
  return updateRouteIntentState(state => {
    dropHomeNativeOverrides(state, [client]);
    return state;
  });
}

/** ocx sync applies route intent to every Home client once the file holds a default or a Home entry. */
export function homeRouteIntentInUse(state: RouteIntentState): boolean {
  return Object.keys(state.defaults).length > 0 || Object.keys(state.devices.home ?? {}).length > 0;
}

/**
 * A file integration toggle on the Home (the dashboard, `PUT /api/client-integrations/<id>`) is the
 * Home's own decision for that client. Once the Home uses route intent, ocx sync applies it to every
 * client, so the toggle is recorded as a `devices.home` entry and Children keep their defaults.
 * Without route intent nothing is written. Returns whether a decision was recorded.
 */
export function recordHomeFileIntegrationDecision(client: RouteClientId, intent: RouteClientIntent): boolean {
  if (isHomeNativeRouteClient(client) || client === "aside") return false;
  return withConfigMutationLockSync(() => {
    if (!homeRouteIntentInUse(readRouteIntentState())) return false;
    setRouteClientIntent(client, intent, "home");
    return true;
  });
}

function advanceRevision(state: RouteIntentState, deviceId: string, client: RouteClientId): void {
  const revisions = ((state.revisions ??= {})[deviceId] ??= {});
  const next = (revisions[client] ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("route device revision exhausted");
  revisions[client] = next;
}
