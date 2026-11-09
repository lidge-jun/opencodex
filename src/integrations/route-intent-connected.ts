/** Read-only Home fetches, followed by local materialization under the caller's sync fence. */
import type { ExportModel } from "../clients/config-export";
import { loadConfig } from "../config";
import { withClientLifecycleSync } from "../client/lifecycle-lock";
import { nativeOpenAiSlugs } from "../codex/catalog/metadata";
import { COMBO_NAMESPACE } from "../combos/identifiers";
import type { LocalRouteIntentOptions } from "../client/route-intent-apply";
import { clearHomeRouteIntentRecord, fetchHomeRouteIntent, homeRouteIntentReceipt, linkBoundFetch, readHomeRouteIntentRecord,
  writeHomeRouteIntentRecord, type LinkHomeConnection, type LinkHomeDeps } from "../client/link-home";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { ROUTE_CLIENT_IDS, type HomeRouteIntentDocument } from "../link/route-intent";
import type { OcxClientConnectionConfig } from "../types";
import type { RouteIntentReceipt } from "./route-intent-contract";
import { effectiveRouteIntent, readLocalRouteIntentOff, readRouteIntentReceipt, writeRouteIntentReceipt } from "./route-intent-state";
import { resolveInitialRouteIntent, initialRouteOutcomeMetadata } from "./route-intent-initial";
import { LINK_ROUTE_CATALOG_PATH } from "../link/management-routes";
import { MAX_ROUTE_CATALOG_BYTES, parseRouteCatalogFacts } from "./route-intent-catalog";

export interface PreparedConnectedRouteIntent { document: HomeRouteIntentDocument; fetchedAt: string; stale: boolean; localOnly?: true }

/** Provisioning preview; connect records its enabled-only choices after enrollment. */
export function initialConnectRouteIntent(
  prepared: PreparedConnectedRouteIntent | undefined, selected: OcxClientConnectionConfig["selectedClients"], explicit = false,
): PreparedConnectedRouteIntent | undefined {
  if (!prepared || !explicit) return prepared;
  const document = structuredClone(prepared.document);
  for (const client of ROUTE_CLIENT_IDS) {
    const enabled = selected.includes(client);
    if (client === "codex" || client === "claude" || enabled) {
      document.clients[client] = { ...document.clients[client], enabled };
      document.sources[client] = "device";
    }
  }
  return { ...prepared, document };
}

export async function prepareConnectedRouteIntent(
  connection: LinkHomeConnection, token: string, deps?: LinkHomeDeps, beforeWrite?: () => void,
): Promise<PreparedConnectedRouteIntent | undefined> {
  if (connection.transport !== "link" || !connection.link) return undefined;
  const fetched = await fetchHomeRouteIntent(connection, token, deps);
  if (fetched.kind === "fresh") return { document: resolveInitialRouteIntent(connection.link.linkId, fetched.document, beforeWrite), fetchedAt: new Date().toISOString(), stale: false };
  const previous = fetched.kind === "failed" ? readHomeRouteIntentRecord(connection.link.linkId) : null;
  return previous ? { document: resolveInitialRouteIntent(connection.link.linkId, previous.document, beforeWrite), fetchedAt: previous.fetchedAt, stale: true } : undefined;
}

export function connectedRouteSelectedClients(prepared: PreparedConnectedRouteIntent | undefined, fallback: OcxClientConnectionConfig["selectedClients"]) {
  const off = new Set(readLocalRouteIntentOff());
  return prepared ? effectiveRouteIntent(prepared.document).selectedClients : fallback.filter(id => !off.has(id));
}

/** Read the exact /v1/models rows this Child relays, preserving ids byte-for-byte. */
export async function loadConnectedRouteModels(connection: LinkHomeConnection, token: string, deps: LinkHomeDeps = {}): Promise<ExportModel[]> {
  if (!connection.link) throw new Error("A Link connection is required for the local served roster");
  const fetchImpl = deps.fetchImpl ?? linkBoundFetch(connection, token);
  const response = await fetchImpl(`http://127.0.0.1:${connection.link.tunnelPort}/v1/models`, {
    method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("The Child served model roster is unavailable"); }
  const body = await readBoundedResponseBytes(response, { maxBytes: 8 * 1024 * 1024, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
  if (body.oversized) throw new Error("The Child served model roster is too large");
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  if (!raw || typeof raw !== "object" || !("data" in raw) || !Array.isArray(raw.data)) throw new Error("Invalid Child served model roster");
  const seen = new Set<string>();
  const nativeIds = new Set(nativeOpenAiSlugs());
  const comboIdentity = new Map<string, string>();
  if (raw.data.some(row => row && typeof row === "object" && row.is_combo === true)) {
    // is_combo describes the inbound adapter in owned_by. This separate passive projection
    // contains only public selectors and canonical combo keys, never model discovery.
    const response = await fetchImpl(`http://127.0.0.1:${connection.link.tunnelPort}${LINK_ROUTE_CATALOG_PATH}`, {
      method: "GET", headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Combo route identity is unavailable"); }
    const body = await readBoundedResponseBytes(response, { maxBytes: MAX_ROUTE_CATALOG_BYTES, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    if (body.oversized) throw new Error("Combo metadata is too large");
    const facts = parseRouteCatalogFacts(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)));
    if (!facts) throw new Error("Invalid combo route metadata");
    for (const row of facts.combos) comboIdentity.set(row.publicId, row.comboId);
  }
  return raw.data.map((row: unknown): ExportModel => {
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || !row.id || seen.has(row.id)) {
      throw new Error("Invalid or duplicate Child served model identifier");
    }
    seen.add(row.id);
    const owner = "owned_by" in row ? row.owned_by : undefined;
    if ("is_combo" in row && row.is_combo === true) {
      const id = comboIdentity.get(row.id);
      if (!id) throw new Error("The served combo has no verified route identity");
      return { namespaced: row.id, provider: COMBO_NAMESPACE, id };
    }
    const canonical = "native_id" in row ? row.native_id : row.id;
    if (typeof canonical !== "string" || !canonical || canonical !== canonical.trim() || canonical.length > 4096 || /[\x00-\x1f\x7f]/.test(canonical)) {
      throw new Error("Invalid canonical served model identity");
    }
    const slash = canonical.indexOf("/");
    const native = slash < 0 && owner !== COMBO_NAMESPACE && (nativeIds.has(canonical) || owner === "openai");
    if (slash < 0 && !native) throw new Error("The served alias has no verified canonical route identity");
    if (!native && (slash === 0 || slash === canonical.length - 1)) throw new Error("Invalid canonical routed model identity");
    return { namespaced: row.id, provider: native ? "openai" : canonical.slice(0, slash),
      id: native ? canonical : canonical.slice(slash + 1), ...(native ? { native: true } : {}) };
  });
}

export async function applyConnectedRouteIntent(
  connection: OcxClientConnectionConfig, token: string, prepared: PreparedConnectedRouteIntent | undefined,
  options: LocalRouteIntentOptions, deps: LinkHomeDeps = {},
): Promise<RouteIntentReceipt | undefined> {
  if (!connection.link) return undefined;
  const localOff = readLocalRouteIntentOff(options.statePath);
  if (!prepared && localOff.length > 0) {
    const previous = readRouteIntentReceipt(options.statePath);
    const document: HomeRouteIntentDocument = previous?.document ?? { version: 1, home: { name: "Home", version: "unavailable" },
      clients: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, { enabled: connection.selectedClients.includes(id) }])) as HomeRouteIntentDocument["clients"],
      sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, "builtin"])) as HomeRouteIntentDocument["sources"] };
    prepared = { document, stale: true, fetchedAt: new Date().toISOString(), localOnly: true };
    options = { ...options, onlyClients: localOff };
  }
  if (!prepared) return undefined;
  const { materializeLocalRouteIntent } = await import("../client/route-intent-apply");
  const intent = prepared;
  const linkId = connection.link.linkId;
  const guard = options.beforeWrite ?? (() => {});
  const previousModels = readRouteIntentReceipt(options.statePath)?.models ?? [];
  const local = loadConfig();
  const config = { ...local, hostname: "127.0.0.1", unauthenticatedLoopbackListener: undefined };
  const previousHomeRecord = readHomeRouteIntentRecord(linkId);
  const { createIntegrationStateStore } = await import("./store");
  const { captureFileIntentOriginals } = await import("../client/route-intent-file-originals");
  const store = options.store ?? createIntegrationStateStore();
  withClientLifecycleSync(() => {
    guard();
    // Write-ahead, before any client changes: which file integrations were standalone.
    captureFileIntentOriginals(linkId, readRouteIntentReceipt(options.statePath)?.linkId === undefined, store.readRecordsStrict());
    // A failed materialization must not leave the separately reportable Home proof current.
    clearHomeRouteIntentRecord();
  }, options.lifecycleLockDeps);
  const persist = (receipt: RouteIntentReceipt) => {
    receipt.outcomes = receipt.outcomes.map(initialRouteOutcomeMetadata(linkId, intent.document));
    withClientLifecycleSync(() => {
      guard();
      writeRouteIntentReceipt(receipt, options.statePath);
      if (intent.localOnly) { clearHomeRouteIntentRecord(); return; }
      const record = homeRouteIntentReceipt(linkId, intent.document, intent.fetchedAt, receipt.appliedAt, receipt.outcomes, previousHomeRecord);
      try { writeHomeRouteIntentRecord(record); }
      catch (error) { clearHomeRouteIntentRecord(); throw error; }
    }, options.lifecycleLockDeps);
  };
  // Disable and opt-out need no catalog. Their proven outcomes survive an offline Home;
  // every enabled client stays stale until its local served model roster is available.
  const effective = effectiveRouteIntent(intent.document, options.statePath);
  const off = ROUTE_CLIENT_IDS.filter(id => !effective.clients[id].enabled && (!options.onlyClients || options.onlyClients.includes(id)));
  const receipt = await materializeLocalRouteIntent(config, intent.document, previousModels, { ...options, onlyClients: off });
  persist(receipt);
  if (intent.localOnly) { receipt.catalogPending = true; persist(receipt); return receipt; }
  if (off.length === ROUTE_CLIENT_IDS.length) return receipt;
  let models: ExportModel[];
  try { models = await loadConnectedRouteModels(connection, token, deps); }
  catch {
    guard();
    receipt.catalogPending = true;
    persist(receipt);
    return receipt;
  }
  const applied = await materializeLocalRouteIntent(config, intent.document, models, options);
  persist(applied);
  return applied;
}
