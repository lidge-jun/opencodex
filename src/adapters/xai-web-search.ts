import type { OcxProviderConfig } from "../types";
import { debugProviderDiagnostic } from "../lib/debug";
import { isXaiResponsesDestination } from "../providers/xai-transport";
import { isOpenCodeGoResponsesUrl } from "./opencode-go-additional-tools";

const CODEX_WEB_SEARCH_TOOL = "web_search";
const CODEX_WEB_SEARCH_PREVIEW_TOOL = "web_search_preview";
const XAI_SEARCH_TOOL = "x_search";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCodexWebSearchToolType(value: unknown): boolean {
  return value === CODEX_WEB_SEARCH_TOOL || value === CODEX_WEB_SEARCH_PREVIEW_TOOL;
}

type ToolGroupRewrite = {
  tools: unknown[];
  changed: boolean;
};

/**
 * Translate Codex-private hosted-search fields to xAI's public Responses schema.
 *
 * xAI web search is live-only. A Codex cached/index-only declaration carries
 * `external_web_access: false`; dropping that flag while keeping the tool would silently widen
 * network access, so the whole tool is omitted instead. `true` maps to xAI's ordinary live
 * `{type:"web_search"}` declaration. Requests that omit the private flag are already public-API
 * shaped and retain their live-search behavior.
 */
function normalizeToolGroup(tools: unknown[]): ToolGroupRewrite {
  const normalized: unknown[] = [];
  let changed = false;

  for (const tool of tools) {
    if (!isPlainObject(tool) || !isCodexWebSearchToolType(tool.type)) {
      normalized.push(tool);
      continue;
    }

    const hasExternalAccess = Object.hasOwn(tool, "external_web_access");
    if (hasExternalAccess && tool.external_web_access !== true) {
      // xAI has no cached/index-only equivalent. Fail closed instead of turning it into live search.
      changed = true;
      continue;
    }

    const searchContentTypes = Array.isArray(tool.search_content_types)
      ? tool.search_content_types
      : undefined;
    const enableImageSearch = searchContentTypes?.includes("image") === true;
    const next: Record<string, unknown> = { ...tool, type: CODEX_WEB_SEARCH_TOOL };
    // Only the two fields xAI actually refuses are removed. Probed 2026-08-22, one field per
    // request, against BOTH xAI destinations (api.x.ai and cli-chat-proxy.grok.com): they behave
    // identically — `external_web_access` 400s on every value including `true`, and
    // `search_context_size` 400s, while `user_location`, `search_content_types`, `filters` and
    // `enable_image_search` are all accepted. Deleting the accepted ones was a silent capability
    // loss, and it contradicted the sibling layer, whose own probe note already records
    // user_location/filters as accepted (tests/responses/responses-routed-web-search-fields.test.ts).
    delete next.external_web_access;
    delete next.search_context_size;
    if (enableImageSearch && !Object.hasOwn(next, "enable_image_search")) {
      next.enable_image_search = true;
    }

    const toolChanged = Object.keys(next).length !== Object.keys(tool).length
      || Object.entries(next).some(([key, value]) => tool[key] !== value);
    changed ||= toolChanged;
    normalized.push(toolChanged ? next : tool);
  }

  return { tools: changed ? normalized : tools, changed };
}

function hasWebSearchTool(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.some(tool =>
    isPlainObject(tool) && isCodexWebSearchToolType(tool.type)
  )) return true;
  return Array.isArray(body.input) && body.input.some(item =>
    isPlainObject(item)
    && item.type === "additional_tools"
    && Array.isArray(item.tools)
    && item.tools.some(tool => isPlainObject(tool) && isCodexWebSearchToolType(tool.type))
  );
}

function hasAnyDeclaredTool(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  return Array.isArray(body.input) && body.input.some(item =>
    isPlainObject(item)
    && item.type === "additional_tools"
    && Array.isArray(item.tools)
    && item.tools.length > 0
  );
}

/** Remove selectors that would still force a cached-only tool omitted above. */
function normalizeToolChoice(body: Record<string, unknown>): Record<string, unknown> {
  const choice = body.tool_choice;
  if (choice === undefined) return body;
  const hasSearch = hasWebSearchTool(body);

  if (isPlainObject(choice) && isCodexWebSearchToolType(choice.type)) {
    if (!hasSearch) return { ...body, tool_choice: "none" };
    return choice.type === CODEX_WEB_SEARCH_TOOL
      ? body
      : { ...body, tool_choice: { ...choice, type: CODEX_WEB_SEARCH_TOOL } };
  }
  if (isPlainObject(choice) && choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    let changed = false;
    const tools: unknown[] = [];
    for (const tool of choice.tools) {
      if (!isPlainObject(tool) || !isCodexWebSearchToolType(tool.type)) {
        tools.push(tool);
        continue;
      }
      if (!hasSearch) {
        changed = true;
        continue;
      }
      if (tool.type === CODEX_WEB_SEARCH_PREVIEW_TOOL) {
        tools.push({ ...tool, type: CODEX_WEB_SEARCH_TOOL });
        changed = true;
      } else {
        tools.push(tool);
      }
    }
    if (!changed) return body;
    return {
      ...body,
      tool_choice: tools.length > 0 ? { ...choice, tools } : "none",
    };
  }
  if (choice === "required" && !hasAnyDeclaredTool(body)) {
    return { ...body, tool_choice: "none" };
  }
  return body;
}

function currentInputStart(inputLength: number, replayPrefixLength: number | undefined): number {
  if (typeof replayPrefixLength !== "number" || !Number.isFinite(replayPrefixLength)) return 0;
  return Math.min(inputLength, Math.max(0, Math.trunc(replayPrefixLength)));
}

function hasToolType(tools: unknown, type: string): boolean {
  return Array.isArray(tools) && tools.some(tool => isPlainObject(tool) && tool.type === type);
}

/**
 * OpenCode Go serves Grok on its Responses endpoint by relaying to xAI, and relays xAI's schema
 * verbatim. Probed 2026-09-26 on `https://opencode.ai/zen/go/v1/responses` with grok-4.6 and
 * grok-4.7, one field per request: `external_web_access` and `search_context_size` -> 400
 * "Argument not supported", `web_search_preview` -> 422 `unknown variant`, while a plain
 * `web_search` with `search_content_types`, `enable_image_search`, `user_location` or
 * `filters` -> 200 and performs live searches. That is the xAI dialect exactly, so the same
 * normalization applies. Sibling Go models (Luna, Muse Spark) accept the OpenAI fields and are
 * left alone. Membership is by family prefix: an exact-id match is what let grok-4.7 reach this
 * endpoint unnormalized once it joined grok-4.6 on the Responses wire.
 */
function isOpenCodeGoGrokResponses(modelId: unknown, responseUrl: string | undefined): boolean {
  return typeof modelId === "string"
    && modelId.trim().toLowerCase().startsWith("grok-")
    && typeof responseUrl === "string"
    && isOpenCodeGoResponsesUrl(responseUrl);
}

/**
 * Make Codex's hosted web-search declaration acceptable to xAI Responses without changing other
 * providers or mutating the caller-owned request body.
 *
 * Scoped to BOTH xAI Responses hosts, not just the public API. The 2026-08-22 probe recorded in
 * `normalizeToolGroup` and in `isXaiResponsesDestination` already found the two hosts to be one
 * dialect, but this gate stayed on `api.x.ai` alone, so the Grok CLI proxy — the OAuth lane — was
 * left unnormalized. Re-probed 2026-08-27 against `cli-chat-proxy.grok.com`:
 * `web_search_preview` -> 422 `unknown variant`, `external_web_access` -> 400 on every value,
 * `search_context_size` -> 400, while `user_location` and `search_content_types` -> 200. Identical
 * to the public API, which is what makes one shared gate correct.
 *
 * Grok models on the exact OpenCode Go Responses URL speak the same dialect and share this gate;
 * see `isOpenCodeGoGrokResponses`. `target` carries the final model id and request URL for that
 * check, and callers without it keep the xAI-host-only behavior.
 */
export function normalizeXaiResponsesWebSearch(
  body: unknown,
  provider: Pick<OcxProviderConfig, "baseUrl">,
  target?: { modelId?: unknown; responseUrl?: string },
): unknown {
  if (!isPlainObject(body)) return body;
  const xaiDestination = isXaiResponsesDestination(provider);
  if (!xaiDestination && !isOpenCodeGoGrokResponses(target?.modelId, target?.responseUrl)) return body;
  // On Go, a wrapper emptied here stays in place: Go promotion (opencode-go-additional-tools.ts)
  // removes every wrapper before the wire and splits them into history and current turn by
  // index against _replayPrefixLen, so deleting one would shift the current turn into history.
  const keepEmptiedWrappers = !xaiDestination;

  let next: Record<string, unknown> = body;
  if (Array.isArray(body.tools)) {
    const rewritten = normalizeToolGroup(body.tools);
    if (rewritten.changed) {
      next = { ...next };
      if (rewritten.tools.length > 0) next.tools = rewritten.tools;
      else delete next.tools;
    }
  }

  if (Array.isArray(next.input)) {
    let inputChanged = false;
    const input: unknown[] = [];
    for (const item of next.input) {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) {
        input.push(item);
        continue;
      }
      const rewritten = normalizeToolGroup(item.tools);
      if (!rewritten.changed) {
        input.push(item);
        continue;
      }
      inputChanged = true;
      if (rewritten.tools.length > 0 || keepEmptiedWrappers) input.push({ ...item, tools: rewritten.tools });
    }
    if (inputChanged) next = { ...next, input };
  }

  const normalized = normalizeToolChoice(next);
  const choice = normalized.tool_choice;
  if ((choice === "auto" || choice === "none") && !hasAnyDeclaredTool(normalized)) {
    debugProviderDiagnostic("xai", "tool-choice-omitted", { choice });
    const { tool_choice: _toolChoice, ...rest } = normalized;
    // `auto` selects from the catalog, so a catalog with nothing in it makes it meaningless and
    // the omission says nothing the request did not already say. `none` is the opposite: it is a
    // prohibition, and on a request whose catalog this normalizer just emptied it is the only
    // place the turn's client-call boundary is written down. Downstream repair reads that
    // boundary off the final outbound body, so omitting the word alone would hand back a call the
    // caller ruled out. Restate it as the explicit empty catalog, which carries the same deny-all
    // and which this destination already receives whenever a caller sends one itself.
    return choice === "none" && !Array.isArray(rest.tools) ? { ...rest, tools: [] } : rest;
  }
  return normalized;
}

function isLiveWebSearchTool(tool: unknown): boolean {
  return isPlainObject(tool)
    && tool.type === CODEX_WEB_SEARCH_TOOL
    && (!Object.hasOwn(tool, "external_web_access") || tool.external_web_access === true);
}

/**
 * Add xAI's hosted X search declaration without changing web-search normalization or selectors.
 * Destination classification belongs only to this opt-in injection path; the public-API
 * normalizer above intentionally retains its narrower causality boundary.
 */
export function injectXaiResponsesXSearch(
  body: unknown,
  provider: Pick<OcxProviderConfig, "baseUrl" | "xaiResponsesXSearch">,
  replayPrefixLength?: number,
): unknown {
  if (
    !isPlainObject(body)
    || !isXaiResponsesDestination(provider)
    || provider.xaiResponsesXSearch !== true
  ) return body;

  const input = Array.isArray(body.input) ? body.input : undefined;
  const inputStart = input ? currentInputStart(input.length, replayPrefixLength) : 0;
  const currentInput = input?.slice(inputStart) ?? [];
  const currentXSearchDeclared = hasToolType(body.tools, XAI_SEARCH_TOOL)
    || currentInput.some(item =>
      isPlainObject(item)
      && item.type === "additional_tools"
      && hasToolType(item.tools, XAI_SEARCH_TOOL)
    );
  if (currentXSearchDeclared) return body;

  const liveWebSearchSurvives = Array.isArray(body.tools) && body.tools.some(isLiveWebSearchTool)
    || currentInput.some(item =>
      isPlainObject(item)
      && item.type === "additional_tools"
      && Array.isArray(item.tools)
      && item.tools.some(isLiveWebSearchTool)
    );
  if (!liveWebSearchSurvives) return body;

  // Declaration does not grant selection when `tool_choice` names a specific tool or carries an
  // `allowed_tools` set that excludes x_search, so leave that selector byte-shape untouched.
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return { ...body, tools: [...tools, { type: XAI_SEARCH_TOOL }] };
}
