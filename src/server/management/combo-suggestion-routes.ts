/**
 * `GET|PUT /api/combo-suggestions`: the providers left out of the Combos page's suggested
 * combos (`comboSuggestionExcludedProviders`). Suggestions are computed in the dashboard; this
 * persists the exclusion list and saves suggested targets against current config policy.
 */
import { clearComboSelectionState, clearComboTargetCooldowns, comboPublicModelId } from "../../combos";
import { comboConfigIssues } from "../../combos/types";
import { channelTier, isMeteredTier, TIER_RANK } from "../../combos/suggestion-channel";
import { codexAccountNamespaceForModel } from "../../codex/account-namespace-match";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import type { OcxComboConfig, OcxConfig } from "../../types";
import { normalizeDecisionModelSelector, decisionModelRouteError } from "./decision-model-validation";
import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { mutatePersistedConfig } from "../../config";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";
import { isPlainRecord } from "./shared";

const MAX_PROVIDERS = 256;
const MAX_NAME_LENGTH = 256;

/** Trimmed, deduplicated, in the order given; null when the value is not a list of names. */
export function parseExcludedProviders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROVIDERS) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const name = entry.trim();
    if (!name || name.length > MAX_NAME_LENGTH) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function view(ctx: ManagementContext): Response {
  const response = jsonResponse({ excludedProviders: ctx.config.comboSuggestionExcludedProviders ?? [] }, 200, ctx.req, ctx.config);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function handleComboSuggestionRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname === "/api/combo-suggestions/save" && req.method === "POST") {
    return await saveSuggestion(ctx);
  }
  if (url.pathname === "/api/combo-suggestions" && req.method === "GET") {
    return view(ctx);
  }
  if (url.pathname === "/api/combo-suggestions" && req.method === "PUT") {
    return await writeExcluded(ctx);
  }
  return null;
}

async function writeExcluded(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: unknown;
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    return managementBodyTooLargeResponse(error, req, config)
      ?? jsonResponse({ error: "invalid JSON body", code: "invalid_request" }, 400, req, config);
  }
  const excluded = isPlainRecord(body) && Object.keys(body).every(key => key === "excludedProviders")
    ? parseExcludedProviders(body.excludedProviders)
    : null;
  if (!excluded) {
    return jsonResponse({ error: "excludedProviders must be a list of provider names", code: "invalid_request" }, 400, req, config);
  }
  const outcome = mutatePersistedConfig(persisted => {
    const before = JSON.stringify(persisted.comboSuggestionExcludedProviders ?? []);
    if (excluded.length === 0) delete persisted.comboSuggestionExcludedProviders;
    else persisted.comboSuggestionExcludedProviders = excluded;
    return { changed: before !== JSON.stringify(excluded), value: excluded };
  });
  if (outcome.status === "unavailable") {
    return jsonResponse({ error: `config.json is ${outcome.reason}; excluded providers were not saved`, code: "config_unavailable" }, 409, req, config);
  }
  if (excluded.length === 0) delete config.comboSuggestionExcludedProviders;
  else config.comboSuggestionExcludedProviders = excluded;
  return view(ctx);
}

type Target = Pick<OcxComboConfig["targets"][number], "provider" | "model">;

function parseTargets(value: unknown): Target[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PROVIDERS) return null;
  const targets: Target[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry) || Object.keys(entry).some(key => key !== "provider" && key !== "model")
      || typeof entry.provider !== "string" || typeof entry.model !== "string") return null;
    const provider = entry.provider.trim();
    const model = entry.model.trim();
    if (!provider || provider.length > MAX_NAME_LENGTH || !model) return null;
    if (!targets.some(target => target.provider === provider && target.model === model)) {
      targets.push({ provider, model });
    }
  }
  return targets;
}

async function saveSuggestion(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  let body: unknown;
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    return managementBodyTooLargeResponse(error, req, config)
      ?? jsonResponse({ error: "invalid JSON body", code: "invalid_request" }, 400, req, config);
  }
  const invalid = () => jsonResponse({ error: "invalid suggested combo", code: "invalid_request" }, 400, req, config);
  if (!isPlainRecord(body) || Object.keys(body).some(key => key !== "id" && key !== "mode" && key !== "targets")
    || typeof body.id !== "string" || (body.mode !== "create" && body.mode !== "append")) return invalid();
  const id = body.id.trim();
  const targets = parseTargets(body.targets);
  if (!targets || !id) return invalid();
  const create = body.mode === "create";

  const rejected = (code: string, status = 409) => ({ changed: false, value: { code, status } });
  const outcome = mutatePersistedConfig<{ code: string; status: number } | { combos: NonNullable<OcxConfig["combos"]> }>(persisted => {
    const previous = Object.hasOwn(persisted.combos ?? {}, id) ? persisted.combos![id] : undefined;
    if (create ? previous : !previous) return rejected("suggestion_combo_changed");

    const nextTargets = [...(previous?.targets ?? [])];
    const providerFor = (snapshot: OcxConfig, name: string) =>
      Object.hasOwn(snapshot.providers, name) ? snapshot.providers[name] : undefined;
    const tierOf = (snapshot: OcxConfig, { provider, model }: Target) => {
      const current = providerFor(snapshot, provider);
      return current ? channelTier({ ...current, name: provider }, model) : "metered";
    };
    for (const target of targets) {
      if (nextTargets.some(({ provider, model }) => provider.trim() === target.provider && model.trim() === target.model)) continue;
      const provider = providerFor(persisted, target.provider);
      if (!provider || provider.disabled || provider.adapter === "jev-decision") {
        return rejected("suggestion_provider_unavailable");
      }
      if (persisted.comboSuggestionExcludedProviders?.includes(target.provider)) return rejected("suggestion_provider_excluded");
      const tier = tierOf(persisted, target);
      const liveTier = tierOf(config, target);
      const metered = isMeteredTier(tier) || isMeteredTier(liveTier);
      if (metered && previous?.allowMeteredTargets !== true) return rejected("suggestion_consent_required");
      const at = create ? -1 : nextTargets.findIndex(existing => TIER_RANK[tierOf(persisted, existing)] > TIER_RANK[tier]);
      nextTargets.splice(at < 0 ? nextTargets.length : at, 0, { ...target, ...(metered ? { metered: true } : {}) });
    }

    const combo: OcxComboConfig = { strategy: "failover", ...previous, targets: nextTargets };
    const combos = { ...persisted.combos, [id]: combo };
    const prospective = { ...persisted, combos };
    if (comboConfigIssues(id, combo, persisted.providers, {
      requireEnabledTarget: true,
      requireUsableDecisionService: true,
      combos,
      excludeComboId: id,
      normalizeDecisionModel: model => normalizeDecisionModelSelector(prospective, model),
    }).length) return rejected("invalid_request", 400);
    if (codexAccountNamespaceForModel(persisted.codexAccountNamespaces, comboPublicModelId(id, combo))) {
      return rejected("suggestion_combo_changed");
    }
    if (Object.entries(combos).some(([comboId, row]) => row.decisionModel
      && decisionModelRouteError(prospective, comboId, row.decisionModel))) return rejected("invalid_request", 400);

    persisted.combos = combos;
    return { changed: nextTargets.length !== (previous?.targets.length ?? 0), value: { combos } };
  });
  if (outcome.status === "unavailable") {
    return jsonResponse({ error: "suggestion could not be saved", code: "config_unavailable" }, 409, req, config);
  }
  if ("code" in outcome.value) {
    return jsonResponse({ error: "suggestion could not be saved", code: outcome.value.code }, outcome.value.status, req, config);
  }
  config.combos = outcome.value.combos;
  reconcileLiveStateStores();
  clearComboSelectionState(id);
  clearComboTargetCooldowns(id);
  const catalogRefresh = await ctx.convergeCodexCatalog();
  return jsonResponse({ success: true, catalogRefresh }, 200, req, config);
}
