import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelInList } from "../types";
import type { SidecarSettings } from "./executor";
import type { CodexAuthContext } from "../codex-auth-context";

export { runWithWebSearch } from "./loop";
export { buildWebSearchTool, extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";

const DEFAULT_SIDECAR_MODEL = "gpt-5.4-mini";
// "low" is the lightest effort the ChatGPT backend allows with web_search ("minimal" is rejected:
// "tools cannot be used with reasoning.effort 'minimal'") — keeps the sidecar fast/cheap.
const DEFAULT_SIDECAR_REASONING = "low";
const DEFAULT_MAX_SEARCHES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

/** First configured forward (ChatGPT passthrough) provider — the only path with server-side web_search. */
export function findForwardProvider(config: OcxConfig): OcxProviderConfig | undefined {
  for (const prov of Object.values(config.providers)) {
    if (prov.disabled === true) continue;
    if (prov.authMode === "forward") return prov;
  }
  return undefined;
}

export interface SidecarPlan {
  forwardProvider: OcxProviderConfig;
  hostedTool: Record<string, unknown>;
  settings: SidecarSettings;
  maxSearches: number;
}

/**
 * Decide whether the web-search sidecar should handle this request, returning the plan if so. Active
 * when: web_search was requested (`parsed._webSearch`), the route is NOT the passthrough adapter
 * (native gpt already searches server-side), a forward provider exists, the sidecar isn't disabled,
 * and the caller forwarded ChatGPT auth. Returns undefined otherwise (request takes the normal path).
 */
export function planWebSearch(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  isPassthrough: boolean,
  incomingHeaders: Headers,
  provider: OcxProviderConfig,
  modelId: string,
  authContext: CodexAuthContext = { kind: "main", accountId: null },
): SidecarPlan | undefined {
  if (!parsed._webSearch || isPassthrough) return undefined;
  const cfg = config.webSearchSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  if (authContext.kind === "main" && !incomingHeaders.get("authorization")) return undefined; // not logged into ChatGPT → sidecar can't run
  const forwardProvider = findForwardProvider(config);
  if (!forwardProvider) return undefined;
  return {
    forwardProvider,
    hostedTool: parsed._webSearch,
    settings: {
      model: cfg.model ?? DEFAULT_SIDECAR_MODEL,
      reasoning: cfg.reasoning ?? DEFAULT_SIDECAR_REASONING,
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // The routed model is text-only → have the search model verbalize image results.
      describeImages: modelInList(provider.noVisionModels, modelId),
    },
    maxSearches: cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES,
  };
}
