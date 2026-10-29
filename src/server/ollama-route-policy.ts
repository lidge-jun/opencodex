import type { OcxConfig } from "../types";
import { captureRouteStaticPolicy, previewRouteModel, type RouteResult } from "../router";
import { POLICY_NAMESPACE, resolvePolicyProfileId } from "../routing/profile";
import { isShadowSourceModel } from "../lib/shadow-call";
import { providerConsumesCallerAuthorization } from "../providers/caller-authorization";
import { resolveOpenCodeGoTransport } from "../providers/opencode-go-transport";
import { resolveWireProtocolOverride } from "./adapter-resolve";
import { parseSyntheticRowId } from "./fast-row";
import { getOrAllocateRequestSessionLane } from "./request-log-conversation";

export { linkRequestSessionLane } from "./request-log-conversation";

export type OllamaRouteError =
  | { status: 400; code: "unsupported_synthetic_selector" | "unsupported_shadow_rewrite"; message: string }
  | { status: 403; code: "unsupported_credential_domain"; message: string }
  | { status: 404; code: "model_not_found"; message: string };
export type OllamaRoutePreflight = { ok: true; route: RouteResult } | { ok: false; error: OllamaRouteError };

function fail(error: OllamaRouteError): OllamaRoutePreflight { return { ok: false, error }; }
const credentialError = (): OllamaRoutePreflight => fail({ status: 403, code: "unsupported_credential_domain", message: "This model requires an unsupported credential domain" });

/** Resolve exactly the Chat transport before admitting a native request. No send occurs here. */
export function preflightOllamaRoute(config: OcxConfig, selector: string, req: Request): OllamaRoutePreflight {
  const { fastRow, effortRow } = parseSyntheticRowId(selector, config);
  if (fastRow || effortRow) return fail({ status: 400, code: "unsupported_synthetic_selector", message: "Synthetic model selectors are unsupported" });
  if (config.shadowCallIntercept?.enabled && isShadowSourceModel(selector, config.shadowCallIntercept.sourceModels)) {
    return fail({ status: 400, code: "unsupported_shadow_rewrite", message: "Shadow model rewrites are unsupported" });
  }
  if (resolvePolicyProfileId(config, selector) !== null || selector === POLICY_NAMESPACE || selector.startsWith(`${POLICY_NAMESPACE}/`)) return credentialError();
  let route: RouteResult;
  try { route = previewRouteModel(config, selector); }
  catch { return fail({ status: 404, code: "model_not_found", message: "Model route not found" }); }
  const routedProvider = route.provider;
  route.staticPolicy = captureRouteStaticPolicy(route.providerName, route.modelId, routedProvider, route.staticPolicy.effectiveAlias, "chat");
  const wireProvider = resolveWireProtocolOverride(route.providerName, route.modelId, routedProvider, "chat", route.staticPolicy);
  route.provider = resolveOpenCodeGoTransport(wireProvider, getOrAllocateRequestSessionLane(req), routedProvider);
  if (route.combo || route.routeKind === "combo" || route.routeKind === "policy" || route.credentialDomainRewrite || providerConsumesCallerAuthorization(route.provider)) return credentialError();
  if (!Object.hasOwn(config.providers, route.providerName) || config.providers[route.providerName]?.disabled === true) {
    return fail({ status: 404, code: "model_not_found", message: "Model route not found" });
  }
  return { ok: true, route };
}

/** Configuration-only inventory; this does not imply any locally stored Ollama model. */
export function listOllamaRoutes(config: OcxConfig, req: Request): Array<{ selector: string; route: RouteResult }> {
  const rows: Array<{ selector: string; route: RouteResult }> = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.disabled === true) continue;
    const models = new Set([...(provider.models ?? []), ...(provider.defaultModel ? [provider.defaultModel] : []),
      ...(provider.retainModels ?? []), ...(provider.selectedModels ?? []),
      ...(config.customModels ?? []).filter(model => model.provider === name).map(model => model.modelId)]);
    for (const model of models) {
      if (!model || (provider.selectedModels?.length && !provider.selectedModels.includes(model))) continue;
      const selector = `${name}/${model}`;
      const result = preflightOllamaRoute(config, selector, req);
      if (result.ok && result.route.providerName === name && result.route.modelId === model) rows.push({ selector, route: result.route });
    }
  }
  return rows;
}
