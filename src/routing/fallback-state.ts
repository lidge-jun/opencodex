/**
 * OCX-11 fallback state: the `ocx.fallback/1` read model and the one scoped write.
 *
 * Off the request path: the management route, `ocx fallback` and `ocx status --json` use it.
 * The request path only resolves (`src/routing/fallback-policy.ts`).
 */
import type { OcxConfig } from "../types";
import type { OcxFallbackConfig, OcxFallbackDeviceConfig, OcxFallbackSwitches } from "../types/fallback";
import { FALLBACK_DEVICE_ID, FALLBACK_SELECTOR } from "../config/schema/fallback-policy";
import type { LinkRecord } from "../link/store";
import { recentFallbackEvents, type FallbackEvent } from "./fallback-policy";

export const FALLBACK_STATE_SCHEMA = "ocx.fallback/1";

export interface FallbackDeviceView {
  id: string;
  kind: "link" | "key";
  alias?: string;
  /** Permission for GOAT to move this device's work to its own providers while the Home is down. */
  localFallback: boolean;
  /** false: refused for this device whatever the other scopes say; null: not set. */
  model: boolean | null;
  provider: boolean | null;
}

export interface FallbackStateView {
  schema: typeof FALLBACK_STATE_SCHEMA;
  /** Effective global switches; absence reads true, today's behavior. */
  global: { model: boolean; provider: boolean };
  providers: Record<string, OcxFallbackSwitches>;
  routes: Record<string, OcxFallbackSwitches>;
  devices: FallbackDeviceView[];
  last: FallbackEvent | null;
  recent: FallbackEvent[];
}

function cleanSwitches(value: unknown): OcxFallbackSwitches {
  const out: OcxFallbackSwitches = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model === "boolean") out.model = raw.model;
  if (typeof raw.provider === "boolean") out.provider = raw.provider;
  return out;
}

function cleanMap(value: unknown, pattern: RegExp): Record<string, OcxFallbackSwitches> {
  const out: Record<string, OcxFallbackSwitches> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!pattern.test(key)) continue;
    const switches = cleanSwitches(entry);
    if (Object.keys(switches).length > 0) out[key] = switches;
  }
  return out;
}

/**
 * Build the read model. `passive` (a Remote Link Child's read through the management relay)
 * drops link aliases and per-event device ids, so a Child learns its own row by link id only.
 */
export function buildFallbackState(
  config: Pick<OcxConfig, "fallback">,
  options: { links?: readonly Pick<LinkRecord, "id" | "alias" | "apiKeyId">[]; passive?: boolean } = {},
): FallbackStateView {
  const policy: OcxFallbackConfig = config.fallback ?? {};
  const devicesRaw = policy.devices && typeof policy.devices === "object" ? policy.devices : {};
  const rows = new Map<string, FallbackDeviceView>();
  const deviceRow = (id: string, kind: "link" | "key", alias?: string): FallbackDeviceView => {
    const raw = (Object.hasOwn(devicesRaw, id) ? devicesRaw[id] : undefined) as OcxFallbackDeviceConfig | undefined;
    return {
      id,
      kind,
      ...(alias && !options.passive ? { alias } : {}),
      localFallback: raw?.localFallback === true,
      model: typeof raw?.model === "boolean" ? raw.model : null,
      provider: typeof raw?.provider === "boolean" ? raw.provider : null,
    };
  };
  for (const link of options.links ?? []) rows.set(link.id, deviceRow(link.id, "link", link.alias));
  for (const id of Object.keys(devicesRaw)) {
    if (!FALLBACK_DEVICE_ID.test(id) || rows.has(id)) continue;
    rows.set(id, deviceRow(id, id.startsWith("lnk_") ? "link" : "key"));
  }
  const recent = recentFallbackEvents().map(event => {
    if (!options.passive || event.deviceId === undefined) return event;
    const { deviceId: _omitted, ...rest } = event;
    return rest;
  });
  return {
    schema: FALLBACK_STATE_SCHEMA,
    global: { model: policy.model !== false, provider: policy.provider !== false },
    providers: cleanMap(policy.providers, FALLBACK_SELECTOR),
    routes: cleanMap(policy.routes, FALLBACK_SELECTOR),
    devices: [...rows.values()],
    last: recent.at(-1) ?? null,
    recent,
  };
}

export type FallbackWriteScope = "global" | "provider" | "route" | "device";
export type FallbackWriteSetting = "model" | "provider" | "localFallback";

export interface FallbackWrite {
  scope: FallbackWriteScope;
  key?: string;
  setting: FallbackWriteSetting;
  /** true or false sets the leaf; null removes it so the scope inherits again. */
  value: boolean | null;
}

/** Validate a write body; the error text is operator-facing. */
export function parseFallbackWrite(body: unknown): { ok: true; write: FallbackWrite } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "expected a JSON object" };
  const raw = body as Record<string, unknown>;
  const scope = raw.scope;
  const setting = raw.setting;
  const value = raw.value;
  if (scope !== "global" && scope !== "provider" && scope !== "route" && scope !== "device") {
    return { ok: false, error: "scope must be global, provider, route or device" };
  }
  if (setting !== "model" && setting !== "provider" && setting !== "localFallback") {
    return { ok: false, error: "setting must be model, provider or localFallback" };
  }
  if (value !== true && value !== false && value !== null) return { ok: false, error: "value must be true, false or null" };
  if (setting === "localFallback" && scope !== "device") return { ok: false, error: "localFallback is set per device" };
  if (scope === "global") {
    if (raw.key !== undefined) return { ok: false, error: "a global write takes no key" };
    return { ok: true, write: { scope, setting, value } };
  }
  const key = raw.key;
  const pattern = scope === "device" ? FALLBACK_DEVICE_ID : FALLBACK_SELECTOR;
  if (typeof key !== "string" || !pattern.test(key)) return { ok: false, error: scope + " key is missing or malformed" };
  return { ok: true, write: { scope, key, setting, value } };
}

/** Up to 8 writes applied in one config mutation: `{ writes: [...] }`, or a single write. */
export const MAX_FALLBACK_WRITES = 8;

export function parseFallbackWrites(body: unknown): { ok: true; writes: FallbackWrite[] } | { ok: false; error: string } {
  const list = body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, "writes")
    ? (body as { writes: unknown }).writes
    : [body];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_FALLBACK_WRITES) {
    return { ok: false, error: "writes must hold 1 to " + MAX_FALLBACK_WRITES + " entries" };
  }
  const writes: FallbackWrite[] = [];
  for (const entry of list) {
    const parsed = parseFallbackWrite(entry);
    if (!parsed.ok) return parsed;
    writes.push(parsed.write);
  }
  return { ok: true, writes };
}

function setLeaf(target: Record<string, unknown>, setting: string, value: boolean | null): void {
  if (value === null) delete target[setting];
  else target[setting] = value;
}

/** Apply one write to a config in place; reports whether anything changed. */
export function applyFallbackWrite(config: OcxConfig, write: FallbackWrite): boolean {
  const before = JSON.stringify(config.fallback ?? null);
  const policy: Record<string, unknown> = { ...(config.fallback ?? {}) };
  if (write.scope === "global") {
    setLeaf(policy, write.setting, write.value);
  } else {
    const mapName = write.scope === "provider" ? "providers" : write.scope === "route" ? "routes" : "devices";
    const map: Record<string, Record<string, unknown>> = { ...((policy[mapName] as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const entry = { ...(Object.hasOwn(map, write.key!) ? map[write.key!] : {}) };
    setLeaf(entry, write.setting, write.value);
    if (Object.keys(entry).length > 0) map[write.key!] = entry;
    else delete map[write.key!];
    if (Object.keys(map).length > 0) policy[mapName] = map;
    else delete policy[mapName];
  }
  if (Object.keys(policy).length > 0) config.fallback = policy as OcxFallbackConfig;
  else delete config.fallback;
  return JSON.stringify(config.fallback ?? null) !== before;
}
