import { isValidProviderName } from "../config/provider-name";
import { modelDisplayNamesConfigError } from "../config/provider-validation";
import { isValidModelDiscoveryModelId } from "../providers/model-discovery-limits";
import { normalizeCatalogDisposition } from "../codex/catalog-refresh-status";
import { printCatalogResult, runCatalogAction } from "./catalog-command-result";
import { serializeManagementJson } from "./json-input";
import {
  customPickerRows, isModelPickerUsage, isPickerOrderSaved, isPickerOrderSettings,
  modelPickerOrder, normalizePickerIds, pickerIdentityCoverage,
  type PickerModelIdentity, type PickerOrderSettings, type ModelPickerUsage,
} from "./model-picker-ordering";
import {
  CliUsageError, RuntimeApiError, printData, runtimeBaseUrl, runtimeRequest,
  takeFlag, takeOptionWithSyntax, type RuntimeApiDeps,
} from "./runtime-api";

const ORDER_USAGE = "Usage: ocx models order status|reset|set (--models CSV | --mode default|alphabetical|provider|most-used) [--json]";
const DISPLAY_USAGE = "Usage: ocx models display-name PROVIDER/MODEL (--set TEXT | --clear) [--json]";
const SETTINGS = "/api/subagent-models";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function unusable(): never { throw new Error("Invalid model management response"); }

async function readSettings(deps: RuntimeApiDeps): Promise<PickerOrderSettings> {
  const value = await runtimeRequest(SETTINGS, { redirect: "error" }, deps);
  if (!isPickerOrderSettings(value) || value.pickerAvailable.some(id => !id.includes("/"))
    || new Set(value.pickerAvailable).size !== value.pickerAvailable.length) unusable();
  return { pickerAvailable: value.pickerAvailable, pickerOrder: value.pickerOrder,
    pickerOrderMode: value.pickerOrderMode, ...(value.chosen === undefined ? {} : { chosen: value.chosen }) };
}
async function readIdentities(deps: RuntimeApiDeps): Promise<PickerModelIdentity[]> {
  const rows = await runtimeRequest("/api/models", { redirect: "error" }, deps);
  if (!Array.isArray(rows)) unusable();
  return rows.map(row => {
    if (!record(row) || typeof row.provider !== "string" || !row.provider.trim()
      || !isValidModelDiscoveryModelId(row.id) || !isValidModelDiscoveryModelId(row.namespaced)) unusable();
    return { provider: row.provider, id: row.id, namespaced: row.namespaced };
  });
}
function snapshot(settings: PickerOrderSettings, identities: PickerModelIdentity[]): string {
  return JSON.stringify([settings, identities]);
}
function assertRouted(settings: PickerOrderSettings): void {
  if (settings.pickerOrder.some(id => !id.includes("/"))) {
    throw new CliUsageError("Saved order includes native models. Run ocx models order reset before replacing it.");
  }
  if (settings.pickerAvailable.length === 0) throw new CliUsageError("No routed picker candidates are available.");
}
function manualOrder(csv: string, settings: PickerOrderSettings, identities: PickerModelIdentity[]): string[] {
  const tokens = csv.split(",").map(id => id.trim());
  const order = tokens.map(token => {
    if (!token) throw new CliUsageError("--models cannot contain blank entries", ORDER_USAGE);
    const result = normalizePickerIds([token], settings.pickerAvailable, identities);
    if (result.length !== 1) throw new CliUsageError("--models contains an unknown or ambiguous model", ORDER_USAGE);
    return result[0]!;
  });
  if (new Set(order).size !== order.length || order.length !== settings.pickerAvailable.length) {
    throw new CliUsageError("--models must contain every routed candidate exactly once", ORDER_USAGE);
  }
  const draft = customPickerRows(settings, identities);
  if (!draft) throw new CliUsageError("Featured state or model identities are incomplete. Read status before trying again.");
  if (!draft.fixed.every((id, index) => order[index] === id)) {
    throw new CliUsageError("--models must keep the current featured models as its exact leading prefix.");
  }
  return order;
}
async function readUsage(deps: RuntimeApiDeps): Promise<ModelPickerUsage[]> {
  const value = await runtimeRequest("/api/usage?range=all&surface=all", { redirect: "error" }, deps);
  if (!record(value) || (value.usageIncomplete !== undefined && value.usageIncomplete !== false)
    || !isModelPickerUsage(value.models)) unusable();
  return value.models;
}
function printOrderSave(value: unknown, expected: string[] | null, mode: string | null, wantsJson: boolean): number {
  if (!record(value) || value.ok !== true || !isPickerOrderSaved(value)
    || !stringList(value.applied) || (value.force !== null && typeof value.force !== "string")
    || JSON.stringify(value.pickerOrder) !== JSON.stringify(expected ?? []) || value.pickerOrderMode !== mode) unusable();
  return printCatalogResult({ ok: true, pickerOrder: value.pickerOrder, pickerOrderMode: value.pickerOrderMode,
    applied: value.applied, force: value.force }, value.catalogRefresh, wantsJson,
  ["Picker order saved.", `Order: ${value.pickerOrder.join(", ") || "default"}`]);
}

export async function handleModelsOrderCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const sub = args.shift();
    const wantsJson = takeFlag(args, "--json");
    const csv = takeOptionWithSyntax(args, "--models")?.value;
    const mode = takeOptionWithSyntax(args, "--mode")?.value;
    if (args.length || !["status", "reset", "set"].includes(sub ?? "")
      || (sub !== "set" && (csv !== undefined || mode !== undefined))
      || (sub === "set" && ((csv === undefined) === (mode === undefined)))
      || (mode !== undefined && !["default", "alphabetical", "provider", "most-used"].includes(mode))) {
      throw new CliUsageError("Invalid picker order arguments", ORDER_USAGE);
    }
    // Refuse lexical manual-input failures before discovering a target.
    if (csv !== undefined) {
      const tokens = csv.split(",").map(id => id.trim());
      if (tokens.some(id => !id) || new Set(tokens).size !== tokens.length) {
        throw new CliUsageError("--models requires unique nonblank entries", ORDER_USAGE);
      }
    }
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    if (sub === "status") {
      const settings = await readSettings(pinned);
      printData(settings, wantsJson, [
        `Saved mode: ${settings.pickerOrderMode ?? (settings.pickerOrder.length ? "custom" : "default")}`,
        `Saved order: ${settings.pickerOrder.join(", ") || "default"}`,
        `Routed candidates: ${settings.pickerAvailable.join(", ") || "none"}`,
        `Featured: ${settings.chosen === undefined ? "unknown" : settings.chosen.join(", ") || "none"}`,
      ]);
      return 0;
    }
    let order: string[] | null = null;
    let savedMode: string | null = null;
    if (sub !== "reset" && mode !== "default") {
      const settings = await readSettings(pinned);
      assertRouted(settings);
      const identities = await readIdentities(pinned);
      if (!pickerIdentityCoverage(settings.pickerAvailable, identities)) {
        throw new CliUsageError("Model identities are incomplete or ambiguous; picker order was not changed.");
      }
      if (csv !== undefined) {
        order = manualOrder(csv, settings, identities);
        const freshSettings = await readSettings(pinned);
        const freshIdentities = await readIdentities(pinned);
        if (snapshot(settings, identities) !== snapshot(freshSettings, freshIdentities)) {
          throw new RuntimeApiError("Picker state changed", 409, null);
        }
      } else {
        const preset = mode as "alphabetical" | "provider" | "most-used";
        order = modelPickerOrder(preset, settings.pickerAvailable, preset === "most-used" ? await readUsage(pinned) : [], identities);
        savedMode = preset;
      }
    }
    const value = await runtimeRequest(SETTINGS, { method: "PUT", redirect: "error",
      body: serializeManagementJson({ pickerOrder: order, pickerOrderMode: savedMode }) }, pinned);
    return printOrderSave(value, order, savedMode, wantsJson);
  });
}

function displayReceipt(value: unknown, provider: string, modelId: string, label: string | null, partial: boolean): Record<string, unknown> {
  if (!record(value) || value.provider !== provider || value.modelId !== modelId
    || value.displayNameOverride !== label || (partial ? value.saved !== true : value.ok !== true)) unusable();
  const projected: Record<string, unknown> = { ...(partial ? { saved: true } : { ok: true }), provider, modelId,
    displayNameOverride: value.displayNameOverride };
  if (partial) {
    if (normalizeCatalogDisposition(value.catalogRefresh)?.status !== "failed") unusable();
  } else {
    if (typeof value.displayName !== "string" || !value.displayName.trim()
      || typeof value.displayNameSource !== "string"
      || !["operator", "provider", "fallback"].includes(value.displayNameSource)) unusable();
    projected.displayName = value.displayName;
    projected.displayNameSource = value.displayNameSource;
  }
  return projected;
}
export async function handleModelsDisplayNameCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const selector = args.shift() ?? "";
    const wantsJson = takeFlag(args, "--json");
    const set = takeOptionWithSyntax(args, "--set")?.value;
    const clear = takeFlag(args, "--clear");
    const slash = selector.indexOf("/");
    const provider = selector.slice(0, slash), modelId = selector.slice(slash + 1);
    if (args.length || slash < 1 || !isValidProviderName(provider) || !isValidModelDiscoveryModelId(modelId)
      || (set !== undefined) === clear) throw new CliUsageError("Invalid display-name arguments", DISPLAY_USAGE);
    const label = set === undefined ? null : set.trim();
    if (label !== null && modelDisplayNamesConfigError({ [modelId]: label }) !== null) {
      throw new CliUsageError("Display name must be a valid nonblank label without slashes or control characters", DISPLAY_USAGE);
    }
    const body = serializeManagementJson({ modelId, displayName: label });
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    let value: unknown;
    let partial = false;
    try {
      value = await runtimeRequest(`/api/providers/${encodeURIComponent(provider)}/model-display-names`, {
        method: "PUT", redirect: "error", body,
      }, pinned);
    } catch (error) {
      if (!(error instanceof RuntimeApiError) || error.status !== 503) throw error;
      value = error.body;
      partial = true;
    }
    const result = displayReceipt(value, provider, modelId, label, partial);
    const refresh = (value as Record<string, unknown>).catalogRefresh;
    return printCatalogResult(result, refresh, wantsJson,
      [`Display name saved for ${provider}/${modelId}: ${label ?? "override cleared"}.`]);
  });
}
