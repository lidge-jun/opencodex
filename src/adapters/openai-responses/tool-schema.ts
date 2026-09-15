import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig, type OcxUsage, type TierDecision } from "../../types";
import { isHostedToolUnsupportedForModel } from "../../responses/hosted-tool-policy";
import { debugProviderDiagnostic } from "../../lib/debug";
import { stripUnicodePropertyPatterns } from "../responses-tool-schema";
import {
  isXaiSchemaTarget,
  normalizeXaiToolParameters,
  XaiToolSchemaCompatibilityError,
} from "../xai-tool-schema";
import { isPlainObject } from "./internal";

function normalizeFunctionToolSchema(tool: unknown, xaiTarget: boolean): unknown | undefined {
  if (!isPlainObject(tool) || tool.type !== "function") return tool;
  // Runs for every Responses destination, forward auth included: the ChatGPT backend is where
  // the `\p{…}` rejection was observed, and it reaches this function through the same seam.
  const compatible = stripUnicodePropertyPatterns(tool);
  const source = isPlainObject(compatible) ? compatible : tool;
  if (xaiTarget) {
    const parameters = normalizeXaiToolParameters(isPlainObject(source.parameters) ? source.parameters : {});
    return parameters === undefined ? undefined : { ...source, parameters };
  }
  if (isPlainObject(source.parameters) && source.parameters.type === "object") return source;
  return {
    ...source,
    parameters: { ...(isPlainObject(source.parameters) ? source.parameters : {}), type: "object" },
  };
}

/**
 * Re-point `tool_choice` after an incompatible function was dropped from the catalog. Names here
 * are already wire names, because namespace lowering rewrote the declarations and the selector
 * together before this runs. A selector left naming an omitted tool reaches Grok as a dangling
 * reference it rejects, and silently relaxing it to `auto` is worse: the turn would quietly
 * proceed without the tool the caller required. So an `allowed_tools` list drops the omitted
 * entries while any remain, and a selection with nothing left to point at fails locally with the
 * same 400 the caller gets for a tool catalog this proxy cannot lower.
 */
function reconcileToolChoiceForOmittedTools(
  body: Record<string, unknown>,
  omittedFunctionNames: ReadonlySet<string>,
): Record<string, unknown> {
  if (omittedFunctionNames.size === 0) return body;
  const toolChoice = body.tool_choice;
  if (!isPlainObject(toolChoice)) return body;

  const refuse = (name: string): never => {
    throw new XaiToolSchemaCompatibilityError(
      `tool_choice requires function "${name}", but its parameter schema cannot be represented for this destination; `
      + "relax tool_choice or simplify the tool's parameter schema",
    );
  };

  if (toolChoice.type === "function" && typeof toolChoice.name === "string") {
    return omittedFunctionNames.has(toolChoice.name) ? refuse(toolChoice.name) : body;
  }

  if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    const omitted = toolChoice.tools.filter(tool =>
      isPlainObject(tool)
      && tool.type === "function"
      && typeof tool.name === "string"
      && omittedFunctionNames.has(tool.name));
    if (omitted.length === 0) return body;
    const kept = toolChoice.tools.filter(tool => !omitted.includes(tool));
    if (kept.length === 0) {
      const first = omitted[0];
      return refuse(isPlainObject(first) && typeof first.name === "string" ? first.name : "unknown");
    }
    return { ...body, tool_choice: { ...toolChoice, tools: kept } };
  }

  return body;
}

export function normalizeToolSchemas(body: unknown, xaiTarget: boolean): unknown {
  if (!isPlainObject(body)) return body;

  const omittedFunctionNames = new Set<string>();
  const normalizeTools = (tools: unknown[]): unknown[] => {
    let changed = false;
    const normalized: unknown[] = [];
    for (const tool of tools) {
      const fixed = normalizeFunctionToolSchema(tool, xaiTarget);
      if (fixed === undefined) {
        changed = true;
        if (isPlainObject(tool) && typeof tool.name === "string") omittedFunctionNames.add(tool.name);
        continue;
      }
      if (fixed !== tool) changed = true;
      normalized.push(fixed);
    }
    return changed ? normalized : tools;
  };

  let normalizedBody = body;
  if (Array.isArray(body.tools)) {
    const tools = normalizeTools(body.tools);
    if (tools !== body.tools) normalizedBody = { ...normalizedBody, tools };
  }
  if (Array.isArray(normalizedBody.input)) {
    let inputChanged = false;
    const input = normalizedBody.input.map((item) => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const tools = normalizeTools(item.tools);
      if (tools === item.tools) return item;
      inputChanged = true;
      return { ...item, tools };
    });
    if (inputChanged) normalizedBody = { ...normalizedBody, input };
  }
  if (omittedFunctionNames.size > 0) {
    // A dropped tool is a capability the caller declared and will not get, and the only other
    // trace of it is a turn that never makes the call. Name them so the cause is recoverable.
    debugProviderDiagnostic("openai-responses", "tool-schema-omitted", {
      omitted: [...omittedFunctionNames],
    });
  }
  return reconcileToolChoiceForOmittedTools(normalizedBody, omittedFunctionNames);
}

export function activateDeferredTool(tool: Record<string, unknown>): Record<string, unknown> {
  const { defer_loading: _, ...activeTool } = tool;
  if (tool.type !== "namespace" || !Array.isArray(tool.tools)) return activeTool;
  return {
    ...activeTool,
    tools: tool.tools.map(inner => isPlainObject(inner) ? activateDeferredTool(inner) : inner),
  };
}

function mergeLoadedTools(declaredTools: unknown[], loadedTools: unknown[]): unknown[] {
  const merged = [...declaredTools];
  let changed = false;

  for (const candidate of loadedTools) {
    if (!isPlainObject(candidate) || typeof candidate.name !== "string") continue;
    const loaded = activateDeferredTool(candidate);
    if (loaded.type === "namespace" && Array.isArray(loaded.tools)) {
      const namespaceIndex = merged.findIndex(tool =>
        isPlainObject(tool) && tool.type === "namespace" && tool.name === loaded.name
      );
      if (namespaceIndex < 0) {
        merged.push(loaded);
        changed = true;
        continue;
      }

      const namespace = merged[namespaceIndex];
      if (!isPlainObject(namespace)) continue;
      const namespaceTools = Array.isArray(namespace.tools) ? namespace.tools : [];
      const nextNamespaceTools = [...namespaceTools];
      let namespaceChanged = "defer_loading" in namespace;
      for (const tool of loaded.tools) {
        if (!isPlainObject(tool) || typeof tool.name !== "string") continue;
        const declaredIndex = nextNamespaceTools.findIndex(declared =>
          isPlainObject(declared) && declared.name === tool.name
        );
        if (declaredIndex < 0) {
          nextNamespaceTools.push(tool);
          namespaceChanged = true;
          continue;
        }
        const declared = nextNamespaceTools[declaredIndex];
        if (isPlainObject(declared) && "defer_loading" in declared) {
          nextNamespaceTools[declaredIndex] = activateDeferredTool(declared);
          namespaceChanged = true;
        }
      }
      if (!namespaceChanged) continue;
      const { defer_loading: _, ...activeNamespace } = namespace;
      merged[namespaceIndex] = { ...activeNamespace, tools: nextNamespaceTools };
      changed = true;
      continue;
    }

    const declaredIndex = merged.findIndex(tool =>
      isPlainObject(tool) && tool.type !== "namespace" && tool.name === loaded.name
    );
    if (declaredIndex < 0) {
      merged.push(loaded);
      changed = true;
    } else {
      const declared = merged[declaredIndex];
      if (isPlainObject(declared) && "defer_loading" in declared) {
        merged[declaredIndex] = activateDeferredTool(declared);
        changed = true;
      }
    }
  }

  return changed ? merged : declaredTools;
}

/**
 * Client-executed tool search only changes Codex's parsed tool context. Routed passthrough keeps
 * serializing the raw request, so activate those returned definitions for upstreams that do not
 * implement the native deferred-loading handshake themselves.
 */
export function promoteClientLoadedTools(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  const loadedTools = body.input.flatMap(item =>
    isPlainObject(item) && item.type === "tool_search_output" && Array.isArray(item.tools)
      ? item.tools
      : []
  );
  if (loadedTools.length === 0) return body;

  if (Array.isArray(body.tools)) {
    const tools = mergeLoadedTools(body.tools, loadedTools);
    return tools === body.tools ? body : { ...body, tools };
  }

  const additionalToolsIndex = body.input.findIndex(item =>
    isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)
  );
  if (additionalToolsIndex < 0) return { ...body, tools: mergeLoadedTools([], loadedTools) };

  const additionalTools = body.input[additionalToolsIndex];
  if (!isPlainObject(additionalTools) || !Array.isArray(additionalTools.tools)) return body;
  const tools = mergeLoadedTools(additionalTools.tools, loadedTools);
  if (tools === additionalTools.tools) return body;
  const input = [...body.input];
  input[additionalToolsIndex] = { ...additionalTools, tools };
  return { ...body, input };
}

/**
 * Remove hosted tool entries the target native slug rejects, so the OAuth-passthrough body never
 * carries a tool the upstream model 400s on. No-op (returns the original reference) when nothing
 * matches, keeping the common path allocation-free.
 */
export function stripUnsupportedHostedTools(body: unknown, provider: Pick<OcxProviderConfig, "baseUrl">): unknown {
  if (!isPlainObject(body)) return body;
  const model = typeof body.model === "string" ? body.model : "";
  const filterTools = (tools: unknown[]): unknown[] => {
    const filtered = tools.filter(t => {
      const type = isPlainObject(t) && typeof t.type === "string" ? t.type : undefined;
      return !type || !isHostedToolUnsupportedForModel(model, type, provider.baseUrl);
    });
    return filtered.length === tools.length ? tools : filtered;
  };

  let next: Record<string, unknown> = body;
  let changed = false;
  if (Array.isArray(body.tools)) {
    const tools = filterTools(body.tools);
    if (tools !== body.tools) {
      next = { ...next, tools };
      changed = true;
    }
  }
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const input = body.input.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const tools = filterTools(item.tools);
      if (tools === item.tools) return item;
      inputChanged = true;
      return { ...item, tools };
    });
    if (inputChanged) {
      next = { ...next, input };
      changed = true;
    }
  }

  const toolChoice = next.tool_choice;
  if (isPlainObject(toolChoice) && toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    const tools = filterTools(toolChoice.tools);
    if (tools !== toolChoice.tools) {
      next = { ...next, tool_choice: tools.length > 0 ? { ...toolChoice, tools } : "none" };
      changed = true;
    }
  } else if (
    isPlainObject(toolChoice)
    && typeof toolChoice.type === "string"
    && isHostedToolUnsupportedForModel(model, toolChoice.type, provider.baseUrl)
  ) {
    next = { ...next, tool_choice: "none" };
    changed = true;
  } else if (changed && toolChoice === "required") {
    const hasDeclaredTools = (Array.isArray(next.tools) && next.tools.length > 0)
      || (Array.isArray(next.input) && next.input.some(item =>
        isPlainObject(item)
        && item.type === "additional_tools"
        && Array.isArray(item.tools)
        && item.tools.length > 0));
    if (!hasDeclaredTools) {
      next = { ...next, tool_choice: "none" };
    }
  }
  return changed ? next : body;
}
