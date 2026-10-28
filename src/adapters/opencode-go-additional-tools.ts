import { hasItemProvenance, isHistoricalItem } from "../responses/item-provenance";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * True only for the exact OpenCode Go Responses resource. Lookalike hosts, other Zen paths,
 * credentials, queries, fragments and unparsable URLs are all excluded, so a custom provider
 * that merely resembles Go never inherits a Go-specific body rewrite.
 */
export function isOpenCodeGoResponsesUrl(responseUrl: string): boolean {
  let destination: URL;
  try {
    destination = new URL(responseUrl);
  } catch {
    return false;
  }
  return destination.origin === "https://opencode.ai"
    && destination.pathname === "/zen/go/v1/responses"
    && !destination.username && !destination.password
    && !destination.href.includes("?") && !destination.href.includes("#");
}

const XAI_RESPONSES_HOSTS = new Set(["api.x.ai", "cli-chat-proxy.grok.com"]);

/**
 * True when the Responses target is an official xAI endpoint (public API or Grok CLI proxy).
 */
export function isXaiResponsesUrl(responseUrl: string): boolean {
  let destination: URL;
  try {
    destination = new URL(responseUrl);
  } catch {
    return false;
  }
  return destination.protocol === "https:"
    && XAI_RESPONSES_HOSTS.has(destination.hostname.toLowerCase())
    && (destination.port === "" || destination.port === "443");
}

/**
 * Promotes client-loaded `additional_tools` input items into top-level `tools` and strips
 * the wrapper from `input`. Required for gateways whose Rust/OpenAI-strict deserializer
 * rejects unknown items in the `input` array.
 */
export function promoteResponsesAdditionalTools(
  body: unknown,
  replayPrefixLength = 0,
): unknown {
  if (!isRecord(body) || !Array.isArray(body.input)) return body;
  // Do not replace a malformed top-level catalog with a partial promoted one.
  if (body.tools !== undefined && !Array.isArray(body.tools)) return body;

  const input: unknown[] = [];
  const promoted: unknown[] = [];
  const currentTurnStart = Number.isFinite(replayPrefixLength)
    ? Math.min(body.input.length, Math.max(0, Math.trunc(replayPrefixLength)))
    : 0;
  const hasProvenance = body.input.some(hasItemProvenance);
  let changed = false;
  for (const [index, item] of body.input.entries()) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
      changed = true;
      // Replayed wrappers are conversation history, not authority for the current request.
      // Gateways cannot accept the wrapper itself, so remove it without promoting its catalog.
      const isHistorical = hasProvenance ? isHistoricalItem(item) : (index < currentTurnStart);
      if (isHistorical) continue;
      // Custom/search/namespace lowering already owns identity and deduplication. This pass
      // only moves declarations, including hosted tools that intentionally have no name.
      for (const tool of item.tools) promoted.push(tool);
    } else {
      input.push(item);
    }
  }
  return changed ? { ...body, input, tools: [...(body.tools ?? []), ...promoted] } : body;
}

/** Console Go accepts public tools but rejects the private additional_tools input wrapper. */
export function normalizeOpenCodeGoAdditionalTools(
  body: unknown,
  responseUrl: string,
  replayPrefixLength = 0,
): unknown {
  if (!isOpenCodeGoResponsesUrl(responseUrl)) return body;
  return promoteResponsesAdditionalTools(body, replayPrefixLength);
}
