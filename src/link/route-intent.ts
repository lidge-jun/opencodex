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
  sources: Record<RouteClientId, "builtin" | "default" | "device">;
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

/** Pure projection. Persisted policy is supplied explicitly by the management owner. */
export function projectHomeRouteIntent(
  config: OcxConfig, version: string, deviceId?: string, state: RouteIntentState = emptyRouteIntentState(),
): HomeRouteIntentDocument {
  const clients = {} as HomeRouteIntentDocument["clients"];
  const sources = {} as HomeRouteIntentDocument["sources"];
  for (const client of ROUTE_CLIENT_IDS) {
    // Preserve explicit native toggles on upgrades; absent settings use the route builtins.
    const legacy = client === "claude" ? config.claudeCode?.enabled
      : client === "codex" || client === "grok" || client === "claude-desktop" ? config.clientIntegrations?.[client] : undefined;
    const home = state.defaults[client] ?? (typeof legacy === "boolean" ? { enabled: legacy } : undefined);
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
export function parseHomeRouteIntentDocument(value: unknown): HomeRouteIntentDocument | null {
  if (!keys(value, ["version", "home", "clients", "sources"], ["clientRevisions"]) || value.version !== 1
    || !keys(value.home, ["name", "version"]) || !label(value.home.name, 255) || !label(value.home.version, 64)
    || !keys(value.clients, ROUTE_CLIENT_IDS) || !keys(value.sources, ROUTE_CLIENT_IDS)) return null;
  const clients = {} as HomeRouteIntentDocument["clients"];
  const sources = {} as HomeRouteIntentDocument["sources"];
  for (const client of ROUTE_CLIENT_IDS) {
    const intent = parseRouteClientIntent(value.clients[client], client);
    const source = value.sources[client];
    if (!intent || (source !== "builtin" && source !== "default" && source !== "device")) return null;
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
