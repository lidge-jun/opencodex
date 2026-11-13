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
import { clearRouteIntentUnappliedProof, effectiveRouteIntent, readLocalRouteIntentOff, readRouteIntentReceipt, readRouteIntentReceiptStrict,
  writeRouteIntentReceipt } from "./route-intent-state";
import { resolveInitialRouteIntent, initialRouteOutcomeMetadata } from "./route-intent-initial";
import { LINK_ROUTE_CATALOG_PATH } from "../link/management-routes";
import { MAX_ROUTE_CATALOG_BYTES, parseRouteCatalogFacts } from "./route-intent-catalog";
import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../reasoning-effort";

/** Modalities the exporters serialize; anything else a served row declares is dropped. */
const SERVED_INPUT_MODALITIES: ReadonlySet<string> = new Set(["text", "image", "video", "audio"]);
const MAX_SERVED_EFFORTS = 16;

/**
 * The capability fields a Home's `/v1/models` row carries (see `modelCapabilityFields` in
 * `src/server/models-capabilities.ts`), read strictly from the served document.
 *
 * The row is remote input, so every value is type- and range-checked here and a malformed
 * field is dropped rather than forwarded: one bad modality or a non-numeric window would
 * either empty a Pi config or make a client offer a control the Home cannot honour. Nothing
 * is synthesized — a field the row omits stays absent, exactly as `toExportModel` projects
 * the local `/api/models` rows.
 */
function servedCapabilities(row: object): Partial<ExportModel> {
  const capabilities = "capabilities" in row && row.capabilities && typeof row.capabilities === "object"
    && !Array.isArray(row.capabilities) ? row.capabilities as Record<string, unknown> : {};
  const top = row as Record<string, unknown>;
  const limit = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value : undefined;
  const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
  const modalities = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const kept: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !SERVED_INPUT_MODALITIES.has(entry) || kept.includes(entry)) continue;
      kept.push(entry);
    }
    return kept.length > 0 ? kept : undefined;
  };
  const efforts = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const kept: string[] = [];
    for (const entry of value) {
      const effort = typeof entry === "string" ? entry
        : entry && typeof entry === "object" && "value" in entry && typeof entry.value === "string" ? entry.value : undefined;
      if (effort === undefined || !isDeclaredReasoningEffort(effort) || kept.includes(effort)) continue;
      kept.push(effort);
      if (kept.length >= MAX_SERVED_EFFORTS) break;
    }
    return kept.length > 0 ? canonicalizeReasoningEfforts(kept) : undefined;
  };
  const contextWindow = limit(top.context_window) ?? limit(top.context_length) ?? limit(capabilities.context_length);
  const maxTokens = limit(top.max_output_tokens) ?? limit(capabilities.max_output_tokens);
  const inputModalities = modalities(capabilities.input_modalities);
  const reasoningEfforts = efforts(top.reasoning_efforts) ?? efforts(capabilities.reasoning_effort);
  const supportsReasoning = flag(capabilities.supports_reasoning);
  const supportsThinkingToggle = flag(capabilities.supports_thinking_toggle);
  const supportsReasoningEffort = flag(capabilities.supports_reasoning_effort);
  const defaultThinkingEnabled = flag(capabilities.default_thinking_enabled);
  const declaredDefault = typeof top.reasoning_effort === "string" && isDeclaredReasoningEffort(top.reasoning_effort)
    ? top.reasoning_effort
    : Array.isArray(top.reasoning_efforts)
      ? top.reasoning_efforts.find(option => option && typeof option === "object" && "default" in option && option.default === true
        && "value" in option && typeof option.value === "string")?.value
      : undefined;
  const defaultReasoningEffort = declaredDefault !== undefined && reasoningEfforts?.includes(declaredDefault) ? declaredDefault : undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(supportsThinkingToggle !== undefined ? { supportsThinkingToggle } : {}),
    ...(supportsReasoningEffort !== undefined ? { supportsReasoningEffort } : {}),
    ...(defaultThinkingEnabled !== undefined ? { defaultThinkingEnabled } : {}),
    ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
  };
}

export interface PreparedConnectedRouteIntent { document: HomeRouteIntentDocument; fetchedAt: string; stale: boolean; localOnly?: true }

/**
 * The Home's `/v1/models` expands a listed combo into synthetic selectors the route catalog does
 * not list: `<base>--fast` (src/server/fast-row.ts) and `<base>--<effort>` (src/server/effort-row.ts).
 * Such a row routes to its base combo, so its identity is the base's when that base is verified.
 * Returns the base public id the selector grammar names, or undefined when it is not one.
 */
function expandedComboBase(publicId: string): string | undefined {
  const separator = publicId.lastIndexOf("--");
  if (separator <= 0) return undefined;
  const suffix = publicId.slice(separator + 2);
  if (suffix !== "fast" && (suffix === "none" || !isDeclaredReasoningEffort(suffix))) return undefined;
  return publicId.slice(0, separator);
}

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
  return raw.data.flatMap((row: unknown): ExportModel[] => {
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || !row.id || seen.has(row.id)) {
      throw new Error("Invalid or duplicate Child served model identifier");
    }
    seen.add(row.id);
    const owner = "owned_by" in row ? row.owned_by : undefined;
    if ("is_combo" in row && row.is_combo === true) {
      const listed = comboIdentity.get(row.id);
      const base = listed === undefined ? expandedComboBase(row.id) : undefined;
      // An expanded selector whose base is not verified is left out on its own: it never fails
      // the rest of the roster, and its id is never trusted.
      if (base !== undefined && !comboIdentity.has(base)) return [];
      const id = listed ?? (base === undefined ? undefined : comboIdentity.get(base));
      if (!id) throw new Error("The served combo has no verified route identity");
      return [{ namespaced: row.id, provider: COMBO_NAMESPACE, id, ...servedCapabilities(row) }];
    }
    const canonical = "native_id" in row ? row.native_id : row.id;
    if (typeof canonical !== "string" || !canonical || canonical !== canonical.trim() || canonical.length > 4096 || /[\x00-\x1f\x7f]/.test(canonical)) {
      throw new Error("Invalid canonical served model identity");
    }
    const slash = canonical.indexOf("/");
    const native = slash < 0 && owner !== COMBO_NAMESPACE && (nativeIds.has(canonical) || owner === "openai");
    if (slash < 0 && !native) throw new Error("The served alias has no verified canonical route identity");
    if (!native && (slash === 0 || slash === canonical.length - 1)) throw new Error("Invalid canonical routed model identity");
    return [{ namespaced: row.id, provider: native ? "openai" : canonical.slice(0, slash),
      id: native ? canonical : canonical.slice(slash + 1), ...(native ? { native: true } : {}), ...servedCapabilities(row) }];
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
    // An apply begins here: from now on only a receipt can prove what this link left behind.
    clearRouteIntentUnappliedProof(options.statePath);
    // Write-ahead, before any client changes: which file integrations were standalone. Only a
    // receipt read strictly proves a first apply; a corrupt one refuses here, before an owner the
    // link created could be recorded as standalone and the receipt naming it replaced.
    captureFileIntentOriginals(linkId, readRouteIntentReceiptStrict(options.statePath)?.linkId === undefined, store.readRecordsStrict());
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
