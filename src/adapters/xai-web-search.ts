import type { OcxProviderConfig } from "../types";

const CODEX_WEB_SEARCH_TOOL = "web_search";
const CODEX_WEB_SEARCH_PREVIEW_TOOL = "web_search_preview";
const XAI_API_HOST = "api.x.ai";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCodexWebSearchToolType(value: unknown): boolean {
  return value === CODEX_WEB_SEARCH_TOOL || value === CODEX_WEB_SEARCH_PREVIEW_TOOL;
}

/** Match only xAI's documented public API, not arbitrary Responses-compatible gateways. */
function isXaiPublicApi(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === XAI_API_HOST
      && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
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
    delete next.external_web_access;
    delete next.search_context_size;
    delete next.search_content_types;
    delete next.user_location;
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

/**
 * Make Codex's hosted web-search declaration acceptable to xAI Responses without changing other
 * providers or mutating the caller-owned request body.
 */
export function normalizeXaiResponsesWebSearch(
  body: unknown,
  provider: Pick<OcxProviderConfig, "baseUrl">,
): unknown {
  if (!isXaiPublicApi(provider) || !isPlainObject(body)) return body;

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
      if (rewritten.tools.length > 0) input.push({ ...item, tools: rewritten.tools });
    }
    if (inputChanged) next = { ...next, input };
  }

  return normalizeToolChoice(next);
}
