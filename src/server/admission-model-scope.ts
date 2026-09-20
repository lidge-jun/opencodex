import type { DataPlaneAdmission } from "./auth-cors";
import type { OcxApiKeyEntry, OcxConfig } from "../types";

/**
 * Per-admission-key model and provider scope.
 *
 * A hub that serves several clients with their own `ocx_data_…` keys needs a
 * mail or cron key to be unable to spend a coding key's Grok or Claude quota.
 * Hub-level model selection cannot express that: it hides a model from
 * everyone or from no one (#5049).
 *
 * Two rules decide what this is and is not:
 *
 * A scope names DESTINATIONS, not selectors. It is evaluated against the
 * resolved route — the provider and model a turn will actually bill — never
 * against the string the client sent. A client-supplied label is not a
 * permission subject: alias resolution, a combo pick, a policy fallback and a
 * compaction override all rewrite that string, so a scope checked before them
 * would authorize one destination and reach another.
 *
 * A scope is never management authority. It narrows which models an inference
 * key may call and grants nothing else; reading or editing a scope stays on
 * the management credential.
 */
export interface AdmissionModelScope {
  /** Resolved provider names this key may reach. Empty means every provider. */
  readonly providers: readonly string[];
  /** Resolved destinations this key may reach. Empty means every model. */
  readonly models: readonly string[];
}

/** The resolved destination a scope decision is made about. */
export interface ScopedRoute {
  readonly providerName: string;
  readonly modelId: string;
}

const normalize = (value: string): string => value.trim().toLowerCase();

function normalizedList(values: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalize(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** Read the scope a stored key declares. An entry with neither list is unrestricted. */
export function admissionModelScopeOf(entry: Pick<OcxApiKeyEntry, "allowedProviders" | "allowedModels">): AdmissionModelScope | undefined {
  const providers = normalizedList(entry.allowedProviders);
  const models = normalizedList(entry.allowedModels);
  return providers.length === 0 && models.length === 0 ? undefined : { providers, models };
}

/**
 * The scope that applies to one request, or undefined when nothing is scoped.
 *
 * Only a configured key carries a scope. The environment token and loopback
 * admission have no stored record to attach one to, so they stay unrestricted;
 * an operator who wants them narrowed issues a configured key instead.
 */
export function resolveAdmissionModelScope(
  config: Pick<OcxConfig, "apiKeys">,
  admission: DataPlaneAdmission | undefined,
): AdmissionModelScope | undefined {
  if (!admission || admission.kind !== "configured") return undefined;
  const entry = (config.apiKeys ?? []).find(key => key.id === admission.keyId);
  return entry ? admissionModelScopeOf(entry) : undefined;
}

/**
 * Does this scope admit this resolved destination?
 *
 * The two lists are independent conditions and both must hold when both are
 * declared: a key allowed one provider and one model may not reach that
 * model on a different provider, which is what a combo child or a policy
 * fallback would otherwise do while the requested selector stayed the same.
 *
 * A model entry matches the bare resolved model id or the fully qualified
 * `provider/model` form, so an operator can scope one model everywhere or
 * pin it to a single provider without a second field.
 */
export function routeAllowedByScope(
  scope: AdmissionModelScope | undefined,
  route: ScopedRoute,
): boolean {
  if (!scope) return true;
  const provider = normalize(route.providerName);
  const model = normalize(route.modelId);
  if (scope.providers.length > 0 && !scope.providers.includes(provider)) return false;
  if (scope.models.length === 0) return true;
  return scope.models.includes(model) || scope.models.includes(provider + "/" + model);
}

/**
 * A request that asked for a destination its key may not reach.
 *
 * Carries the selector the client sent rather than the destination it resolved
 * to: the caller needs to know which of its own requests was refused, and a
 * key that may not reach a provider has no business learning that an alias it
 * named points there. The resolved destination goes to the server log.
 */
export class AdmissionModelDeniedError extends Error {
  readonly requestedModel: string;
  readonly deniedProvider: string;
  readonly deniedModel: string;
  constructor(requestedModel: string, route: ScopedRoute) {
    super("model " + requestedModel + " is not allowed for this API key");
    this.name = "AdmissionModelDeniedError";
    this.requestedModel = requestedModel;
    this.deniedProvider = route.providerName;
    this.deniedModel = route.modelId;
  }
}

/** Stable wire type for a scope refusal. */
export const MODEL_NOT_ALLOWED_FOR_KEY = "model_not_allowed_for_key";

/**
 * What a request that names no model resolves to for a scope decision.
 *
 * The relays beside the router — images and the search relay — copy the caller's
 * body upstream, so a missing model leaves the provider to pick one and there is
 * no destination a scoped key could be shown to be allowed to reach. A key with
 * a model list is refused rather than sent to whatever the upstream defaults to.
 * A key scoped only by provider is unaffected, and an unscoped key never reaches
 * this at all.
 */
export const UNNAMED_DESTINATION_MODEL = "(unnamed)";

/** The HTTP body a scope refusal returns. 403: authenticated, not permitted. */
export function admissionModelDeniedBody(error: AdmissionModelDeniedError): {
  error: { type: string; message: string; model: string };
} {
  return {
    error: {
      type: MODEL_NOT_ALLOWED_FOR_KEY,
      message: error.message,
      model: error.requestedModel,
    },
  };
}

/**
 * The refusal a scoped request gets: 403, not 404.
 *
 * The key authenticated; it simply may not reach this destination. Reporting
 * "not found" instead would tell a client its credential is wrong and invite
 * it to retry with another, and would make an operator's own denial
 * indistinguishable from a typo in the model name.
 */
export function admissionModelDeniedResponse(error: AdmissionModelDeniedError): Response {
  return new Response(JSON.stringify(admissionModelDeniedBody(error)), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Refuse a resolved destination this key may not reach.
 *
 * Every request-path site that produces or re-produces a route calls this, so
 * the direct name, an alias, a combo child, a policy or subagent fallback and
 * a compaction override are all checked at the point they become concrete
 * rather than once at the front door.
 */
export function assertRouteAllowedByScope(
  scope: AdmissionModelScope | undefined,
  requestedModel: string,
  route: ScopedRoute,
): void {
  if (!routeAllowedByScope(scope, route)) {
    throw new AdmissionModelDeniedError(requestedModel, route);
  }
}

/**
 * The refusal a non-routed data-plane surface returns, or undefined when the
 * destination is permitted.
 *
 * The Responses path resolves a route inside a try/catch and throws from the
 * point the destination becomes concrete. The endpoints beside it -- images,
 * audio, voice and the search relay -- have no router and no such boundary:
 * each picks its own upstream inline and returns a Response. This is the same
 * predicate against the same kind of resolved destination, shaped for that
 * control flow, so a key that may not reach a provider is refused identically
 * whichever surface it asked through.
 */
export function admissionScopeDenial(
  config: Pick<OcxConfig, "apiKeys">,
  admission: DataPlaneAdmission | undefined,
  requestedModel: string,
  route: ScopedRoute,
): Response | undefined {
  const scope = resolveAdmissionModelScope(config, admission);
  if (routeAllowedByScope(scope, route)) return undefined;
  return admissionModelDeniedResponse(new AdmissionModelDeniedError(requestedModel, route));
}
