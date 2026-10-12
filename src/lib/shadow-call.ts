/**
 * Shadow-call intercept source models.
 *
 * Codex 0.154.0+ sends `gpt-6-luna` for helper calls. Clients from 0.145.0
 * through 0.153.x sent `gpt-5.6-luna`, which stays a default prefix so those
 * clients keep their interception. Clients through 0.144.x used `gpt-5.4-mini`;
 * operators supporting them can restore that prefix with the `sourceModels`
 * override. The GPT-6 slug comes first because surfaces show the list in order.
 * Every surface that names the
 * intercepted model (management API, GUI badges/tooltips, CLI) reads it from
 * here instead of hard-coding a slug that goes stale on the next client bump.
 */
export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const;

/**
 * Optional blocked model redirects at the shared routing layer.
 * When `blockedModelRedirects` is configured (e.g. `{ "gpt-5.6-terra": "gpt-5.6-luna" }`),
 * requests targeting those models are rewritten to the substitute model with
 * routeReason "blocked-model-redirect".
 * Returns undefined when not configured or the model is not in the redirect map.
 */
export function resolveBlockedModelRedirect(
  config: { blockedModelRedirects?: Record<string, string> } | undefined,
  modelId: string,
): string | undefined {
  if (!config?.blockedModelRedirects || typeof config.blockedModelRedirects !== "object"
    || modelId === "__proto__" || modelId === "prototype" || modelId === "constructor") {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(config.blockedModelRedirects, modelId)
    ? config.blockedModelRedirects[modelId]
    : undefined;
}

/** Normalize a persisted `sourceModels` override; falls back to the defaults. */
export function shadowSourceModels(configured?: unknown): string[] {
  const configuredStrings = Array.isArray(configured)
    ? configured
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map(v => v.trim())
    : [];
  return configuredStrings.length > 0 ? configuredStrings : [...DEFAULT_SHADOW_SOURCE_MODELS];
}

/**
 * True when `modelId` is one of Codex's helper/shadow source models.
 * Routed ids (`provider/model`) are hard-excluded: a shadow call is always a
 * bare native slug, and an explicit routed selection must never be hijacked.
 */
export function isShadowSourceModel(modelId: string, configured?: unknown): boolean {
  if (modelId.includes("/")) return false;
  return shadowSourceModels(configured).some(prefix => modelId.startsWith(prefix));
}

/**
 * The configured source prefix this model matched, or undefined.
 *
 * Callers that RECORD the intercepted model must record this rather than the caller's raw
 * `modelId`. Matching is by prefix, so `gpt-5.6-luna` plus arbitrary trailing text still
 * intercepts — and the raw string is caller-controlled, reaches `usage.jsonl` and `/api/logs`,
 * and only passes a pattern-based redactor on the way. A credential family that redactor does
 * not recognize survives verbatim. Returning the operator-configured prefix keeps the log
 * field inside a set the operator chose, so no caller string is ever persisted.
 */
export function shadowSourceModelPrefix(modelId: string, configured?: unknown): string | undefined {
  if (modelId.includes("/")) return undefined;
  return shadowSourceModels(configured).find(prefix => modelId.startsWith(prefix));
}

export interface ShadowCallModelIdentity {
  providerName: string;
  modelId: string;
}

/** Match a source prefix and replacement as a provider+model pair, never by slug alone. */
export function shadowCallTargetsIntersect(
  source: ShadowCallModelIdentity,
  target: ShadowCallModelIdentity,
): boolean {
  return source.providerName === target.providerName
    && target.modelId.startsWith(source.modelId);
}

/**
 * Preserve explicit user turns and spawned children before either intercept site.
 * HTTP provenance is `x-codex-turn-metadata` or `x-openai-subagent: collab_spawn`.
 * `x-openai-subagent` is connection-level on both transports: a child session opens
 * its own connection, so a `collab_spawn` upgrade header still names every frame.
 * Turn metadata is per-frame on WebSocket (`CODEX_WS_FRAME_HEADERS`): only the frame's
 * `client_metadata["x-codex-turn-metadata"]` describes this turn, because the
 * upgrade's copy can describe an earlier user or helper turn.
 * `request_kind: "turn"` alone is not user provenance (#1684). Maintenance
 * markers such as `x-openai-subagent: compact`/`review` and metadata naming
 * `memory_consolidation` remain eligible helpers, subject to memory routing.
 * Missing/malformed metadata retains the legacy opt-in source-prefix behavior.
 */
export function shadowCallPreservesSelectedModel(
  body: unknown,
  headers: Headers,
  transport?: "websocket",
): boolean {
  if (headers.get("x-openai-subagent") === "collab_spawn") return true;
  let metadata: unknown = headers.get("x-codex-turn-metadata");
  if (transport === "websocket") {
    const client = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).client_metadata : undefined;
    metadata = client && typeof client === "object" && !Array.isArray(client)
      && Object.hasOwn(client, "x-codex-turn-metadata")
      ? (client as Record<string, unknown>)["x-codex-turn-metadata"] : undefined;
  }
  if (typeof metadata !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const turn = parsed as Record<string, unknown>;
    return turn.subagent_kind === "thread_spawn"
      || (turn.request_kind === "turn" && turn.thread_source === "user");
  } catch {
    return false;
  }
}

/**
 * Decide whether a matching source model should use the opt-in intercept.
 *
 * Before Codex 0.147.0 this checked x-codex-turn-metadata and exempted
 * request_kind "turn". Codex 0.147.0 can label background helper calls as
 * "turn", causing them to bypass the intercept (#1684). Request kind alone
 * cannot exempt a configured source model: callers first preserve explicit
 * user/child provenance with `shadowCallPreservesSelectedModel` (#6921).
 * A replacement intersecting the same provider+model source set remains a
 * no-op because rewriting it would only create self-interception (#2706).
 *
 * `gpt-6-luna` is both the helper slug and a selectable user/sub-agent model;
 * explicit user turns and spawned children must keep the model they chose.
 */
export function shouldInterceptShadowCall(
  modelId: string,
  configured: unknown,
  source: ShadowCallModelIdentity,
  target: ShadowCallModelIdentity,
): boolean {
  return isShadowSourceModel(modelId, configured)
    && !shadowCallTargetsIntersect(source, target);
}
