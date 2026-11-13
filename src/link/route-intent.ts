/** Home policy only. No filesystem paths, listener facts, credentials or profile slots. */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { EXPORT_CLIENT_IDS } from "../clients/client-ids";
import type { OcxConfig } from "../types";

export const ROUTE_CLIENT_IDS = ["codex", "claude", "claude-desktop", "grok", ...EXPORT_CLIENT_IDS] as const;
export type RouteClientId = (typeof ROUTE_CLIENT_IDS)[number];
export interface RouteClientIntent {
  enabled: boolean;
  modelNames?: "alias" | "routed";
  /** Stable Aside user ids, never machine-local profile slots. */
  accounts?: "all" | "none" | string[];
}
export interface HomeRouteIntentDocument {
  version: 1;
  home: { name: string; version: string };
  clients: Record<RouteClientId, RouteClientIntent>;
  /**
   * `native` appears only in the Home's own document: the Home's persisted native switch governs
   * that client there. Documents sent to a Child never carry it.
   */
  sources: Record<RouteClientId, "builtin" | "default" | "device" | "native">;
  /** Device decisions (including inherit) invalidate matching enrollment overrides. */
  clientRevisions?: Partial<Record<RouteClientId, number>>;
}
export interface RouteIntentState {
  version: 1;
  defaults: Partial<Record<RouteClientId, RouteClientIntent>>;
  devices: Record<string, Partial<Record<RouteClientId, RouteClientIntent>>>;
  revisions?: Record<string, Partial<Record<RouteClientId, number>>>;
}
export interface RouteClientOutcome {
  client: RouteClientId;
  outcome: "current" | "stale" | "not_installed" | "conflict" | "failed";
  /** A Child's off-only opt-out; Home policy remains unchanged. */
  source?: "local";
  target?: string;
  message?: string;
  intentDigest?: string;
  /** Display-only initial selection made during enrollment; never mutates Home policy. */
  initialIntent?: RouteClientIntent;
  initialRevision?: number;
}
export const ROUTE_INTENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export function isRouteClientId(value: unknown): value is RouteClientId {
  return typeof value === "string" && (ROUTE_CLIENT_IDS as readonly string[]).includes(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return record(value) && required.every(k => Object.hasOwn(value, k))
    && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
}
function label(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value);
}
export function parseRouteClientIntent(value: unknown, client?: RouteClientId): RouteClientIntent | null {
  if (!keys(value, ["enabled"], ["modelNames", "accounts"]) || typeof value.enabled !== "boolean") return null;
  if (Object.hasOwn(value, "modelNames") && value.modelNames !== "alias" && value.modelNames !== "routed") return null;
  const a = value.accounts;
  if (Object.hasOwn(value, "accounts")) {
    if (client !== undefined && client !== "aside") return null;
    if (a !== "all" && a !== "none" && (!Array.isArray(a) || a.length > 128 || a.length === 0
      || !a.every(id => label(id, 128) && /^[A-Za-z0-9@._+-]+$/.test(id) && !/^u[0-9]+$/i.test(id))
      || new Set(a).size !== a.length)) return null;
  }
  return { enabled: value.enabled, ...(value.modelNames === undefined ? {} : { modelNames: value.modelNames as "alias" | "routed" }),
    ...(a === undefined ? {} : { accounts: Array.isArray(a) ? [...a].sort() : a as "all" | "none" }) };
}
export function emptyRouteIntentState(): RouteIntentState {
  return { version: 1, defaults: {}, devices: {} };
}

export interface HomeRouteProjectionOptions {
  /**
   * The native client a Home write is deciding right now. The decision is applied through the
   * Home's native switch; every other native client on the Home reads that switch as it is.
   */
  decidedClient?: RouteClientId;
  /** The decided Home value. Absent, the decided client takes the default Children inherit. */
  decidedIntent?: RouteClientIntent;
}
export const HOME_NATIVE_ROUTE_CLIENTS = ["codex", "claude", "grok", "claude-desktop"] as const;
export type HomeNativeRouteClientId = (typeof HOME_NATIVE_ROUTE_CLIENTS)[number];
export function isHomeNativeRouteClient(client: RouteClientId): client is HomeNativeRouteClientId {
  return (HOME_NATIVE_ROUTE_CLIENTS as readonly string[]).includes(client);
}

/**
 * The defaults Children inherit for the native clients, captured once from the Home's durable
 * switches. Codex and Claude Code keep their switch meaning (only an explicit `false` is off).
 * Grok and Claude Desktop are never captured on: a Home switch enables them on the Home alone.
 */
export function homeNativeRouteDefaults(config: OcxConfig): Record<HomeNativeRouteClientId, RouteClientIntent> {
  return { codex: { enabled: config.clientIntegrations?.codex !== false }, claude: { enabled: config.claudeCode?.enabled !== false },
    grok: { enabled: false }, "claude-desktop": { enabled: false } };
}

/**
 * Pure projection. Persisted policy is supplied explicitly by the management owner.
 *
 * On the Home itself (`deviceId === "home"`) the native clients follow the Home's own persisted
 * switches with their usual meaning (only an explicit `false` is off), never captured defaults or
 * a `devices.home` entry: ocx restore, Messages off and native toggles change those switches
 * without recording route intent. Children never read those switches: a device override, then the
 * saved default, then the builtin (Codex and Claude Code on, everything else off).
 */
export function projectHomeRouteIntent(
  config: OcxConfig, version: string, deviceId?: string, state: RouteIntentState = emptyRouteIntentState(),
  options: HomeRouteProjectionOptions = {},
): HomeRouteIntentDocument {
  const clients = {} as HomeRouteIntentDocument["clients"];
  const sources = {} as HomeRouteIntentDocument["sources"];
  for (const client of ROUTE_CLIENT_IDS) {
    const home = state.defaults[client];
    if (deviceId === "home" && isHomeNativeRouteClient(client)) {
      const live = client === "claude" ? config.claudeCode?.enabled : config.clientIntegrations?.[client];
      const decided = options.decidedClient === client;
      const enabled = decided ? options.decidedIntent?.enabled ?? home?.enabled ?? (client === "codex" || client === "claude")
        : live !== false;
      clients[client] = { enabled };
      sources[client] = "native";
      continue;
    }
    const device = deviceId === undefined ? undefined : state.devices[deviceId]?.[client];
    const chosen = { enabled: client === "codex" || client === "claude", ...home, ...device };
    clients[client] = { ...chosen, ...(Array.isArray(chosen.accounts) ? { accounts: [...chosen.accounts].sort() } : {}) };
    sources[client] = device ? "device" : home ? "default" : "builtin";
  }
  const name = hostname();
  const revisions = deviceId === undefined ? undefined : state.revisions?.[deviceId];
  return { version: 1, home: { name: label(name, 255) ? name : "Home", version }, clients, sources,
    ...(revisions && Object.keys(revisions).length ? { clientRevisions: { ...revisions } } : {}) };
}
/** `allowNative` is for the Home's own local receipt; a document from a Home never carries it. */
export function parseHomeRouteIntentDocument(value: unknown, options: { allowNative?: boolean } = {}): HomeRouteIntentDocument | null {
  if (!keys(value, ["version", "home", "clients", "sources"], ["clientRevisions"]) || value.version !== 1
    || !keys(value.home, ["name", "version"]) || !label(value.home.name, 255) || !label(value.home.version, 64)
    || !keys(value.clients, ROUTE_CLIENT_IDS) || !keys(value.sources, ROUTE_CLIENT_IDS)) return null;
  const clients = {} as HomeRouteIntentDocument["clients"];
  const sources = {} as HomeRouteIntentDocument["sources"];
  for (const client of ROUTE_CLIENT_IDS) {
    const intent = parseRouteClientIntent(value.clients[client], client);
    const source = value.sources[client];
    if (!intent || (source !== "builtin" && source !== "default" && source !== "device"
      && !(source === "native" && options.allowNative === true && isHomeNativeRouteClient(client)))) return null;
    clients[client] = intent;
    sources[client] = source;
  }
  const revisions: Partial<Record<RouteClientId, number>> = {};
  if (value.clientRevisions !== undefined) {
    if (!record(value.clientRevisions)) return null;
    for (const [client, revision] of Object.entries(value.clientRevisions)) {
      if (!isRouteClientId(client) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
      revisions[client] = revision;
    }
  }
  return { version: 1, home: { name: value.home.name, version: value.home.version }, clients, sources,
    ...(value.clientRevisions === undefined ? {} : { clientRevisions: revisions }) };
}
/** Compact JSON: version, ordered clients (enabled/modelNames/accounts), ordered sources. */
export function routeIntentDigestPayload(document: HomeRouteIntentDocument): string {
  const clients = Object.fromEntries(ROUTE_CLIENT_IDS.map(client => {
    const intent = document.clients[client];
    return [client, { enabled: intent.enabled, ...(intent.modelNames === undefined ? {} : { modelNames: intent.modelNames }),
      ...(intent.accounts === undefined ? {} : { accounts: Array.isArray(intent.accounts) ? [...intent.accounts].sort() : intent.accounts }) }];
  }));
  return JSON.stringify({ version: 1, clients, sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(client => [client, document.sources[client]])) });
}
export function routeIntentDigest(document: HomeRouteIntentDocument): string {
  return createHash("sha256").update(routeIntentDigestPayload(document), "utf8").digest("hex");
}

export function routeClientIntentDigest(document: HomeRouteIntentDocument, client: RouteClientId): string {
  const intent = parseRouteClientIntent(document.clients[client], client)!;
  return createHash("sha256").update(JSON.stringify({ version: 1, client, intent, source: document.sources[client] }), "utf8").digest("hex");
}

/** Peer outcomes carry closed fields; local diagnostics are never copied onto the wire. */
export function parseRouteClientOutcomes(value: unknown): RouteClientOutcome[] | null {
  if (!Array.isArray(value) || value.length > ROUTE_CLIENT_IDS.length) return null;
  const seen = new Set<string>();
  const out: RouteClientOutcome[] = [];
  for (const row of value) {
    if (!keys(row, ["client", "outcome"], ["source", "target", "message", "intentDigest", "initialIntent", "initialRevision"]) || !isRouteClientId(row.client)
      || seen.has(row.client) || !["current", "stale", "not_installed", "conflict", "failed"].includes(row.outcome as string)
      || (row.source !== undefined && row.source !== "local")
      || (row.target !== undefined && !label(row.target, 256)) || (row.message !== undefined && !label(row.message, 256))) return null;
    if (row.intentDigest !== undefined && (typeof row.intentDigest !== "string" || !ROUTE_INTENT_DIGEST_PATTERN.test(row.intentDigest))) return null;
    const initialIntent = row.initialIntent === undefined ? undefined : parseRouteClientIntent(row.initialIntent, row.client);
    if (row.initialIntent !== undefined && (!initialIntent || Object.keys(initialIntent).some(key => key !== "enabled") || typeof row.initialRevision !== "number" || !Number.isSafeInteger(row.initialRevision) || row.initialRevision < 0)) return null;
    if (row.initialIntent === undefined && row.initialRevision !== undefined) return null;
    seen.add(row.client);
    out.push({ client: row.client, outcome: row.outcome as RouteClientOutcome["outcome"], ...(row.source === "local" ? { source: "local" as const } : {}),
      ...(row.target === undefined ? {} : { target: row.target as string }), ...(row.message === undefined ? {} : { message: row.message as string }),
      ...(row.intentDigest === undefined ? {} : { intentDigest: row.intentDigest }),
      ...(initialIntent ? { initialIntent, initialRevision: row.initialRevision as number } : {}) });
  }
  return out;
}
/** Publish only client identity, disposition and opt-out; target/message can expose local files or secrets. */
export function routeClientOutcomesForPeer(outcomes: readonly RouteClientOutcome[]): RouteClientOutcome[] {
  return outcomes.map(({ client, outcome, source, target, intentDigest, initialIntent, initialRevision }) => ({ client, outcome, ...(source === "local" ? { source } : {}),
    ...(intentDigest ? { intentDigest } : {}), ...(initialIntent ? { initialIntent: { enabled: initialIntent.enabled }, initialRevision } : {}),
    ...(client === "aside" && typeof target === "string" && /^u[0-9]+(?:,u[0-9]+)*$/.test(target) && target.length <= 256 ? { target } : {}) }));
}
