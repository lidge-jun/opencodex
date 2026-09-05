import type { OcxRequestOptions, OcxTool } from "../types";
import { isObj } from "./parser-content";
import { WEB_SEARCH_TOOL_NAME } from "../web-search/synthetic-tool";
import { buildImageTool, IMAGE_GEN_TOOL_NAME } from "../images/synthetic-tool";
import { toolSearchDescription, toolSearchParameters } from "./tool-search-compat";

export function mapToolChoice(value: unknown): OcxRequestOptions["toolChoice"] {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObj(value) && "type" in value) {
    const t = (value as { type: string }).type;
    if ((t === "function" || t === "custom") && "name" in value) {
      return { name: (value as { name: string }).name };
    }
    // Hosted image tool types (with or without a name) map to the synthetic image_gen wire name.
    if (t === "image_generation" || t === "image_gen") {
      return { name: IMAGE_GEN_TOOL_NAME };
    }
    if (t === "allowed_tools" && Array.isArray(value.tools)) {
      const names = value.tools
        .map(allowedToolName)
        .filter((name): name is string => Boolean(name));
      return names.length > 0
        ? { allowedTools: [...new Set(names)], mode: value.mode === "required" ? "required" : "auto" }
        : "none";
    }
    return "auto";
  }
  return undefined;
}

function allowedToolName(tool: unknown): string | undefined {
  if (!isObj(tool)) return undefined;
  if (typeof tool.name === "string" && tool.name.length > 0) return tool.name;
  if (tool.type === "web_search" || tool.type === "web_search_preview") return WEB_SEARCH_TOOL_NAME;
  if (tool.type === "image_generation" || tool.type === "image_gen") return IMAGE_GEN_TOOL_NAME;
  if (tool.type === "tool_search") return "tool_search";
  return undefined;
}

export function buildTools(tools: unknown[] | undefined): OcxTool[] | undefined {
  if (!tools) return undefined;
  const out: OcxTool[] = [];
  const normalizeParameters = (raw: unknown): Record<string, unknown> => {
    if (isObj(raw) && raw.type === "object") return raw;
    return { ...(isObj(raw) ? raw : {}), type: "object" };
  };
  const pushFn = (t: Record<string, unknown>, namespace?: string) => {
    // Hosted image_generation already installed the synthetic root tool. A later
    // ordinary root `image_gen` must not create a second un-namespaced identity.
    if (
      !namespace
      && t.name === IMAGE_GEN_TOOL_NAME
      && out.some(tool => tool.name === IMAGE_GEN_TOOL_NAME && !tool.namespace && tool.imageGeneration)
    ) {
      return;
    }
    const tool: OcxTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: normalizeParameters(t.parameters),
    };
    if (t.strict !== undefined) tool.strict = t.strict as boolean;
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  const pushCustom = (t: Record<string, unknown>, namespace?: string) => {
    // Hosted image_generation already installed the synthetic root tool. A later
    // root custom `image_gen` would collide on the same wire name with a different
    // `freeform` flag and throw `ambiguous tool catalog`.
    if (
      !namespace
      && t.name === IMAGE_GEN_TOOL_NAME
      && out.some(tool => tool.name === IMAGE_GEN_TOOL_NAME && !tool.namespace && tool.imageGeneration)
    ) {
      return;
    }
    // Freeform custom tools are lowered to a single string `input` because chat models cannot
    // emit Responses grammar payloads directly. Keep tool-specific input guidance scoped to the
    // tool that owns it: leaking apply_patch syntax into `exec` or another freeform tool teaches
    // routed models that the nested helper name is itself a callable top-level tool.
    const inputDescription = t.name === "apply_patch"
      ? "Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope."
      : "Raw freeform input for this tool.";
    const tool: OcxTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: { type: "object", properties: { input: { type: "string", description: inputDescription } }, required: ["input"] },
      freeform: true,
    };
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (t.type === "function" && isObj(t.function) && typeof t.function.name === "string" && t.function.name.length > 0) {
      pushFn(t.function as Record<string, unknown>);
      continue;
    }
    if (t.type === "function" && typeof t.name === "string") {
      pushFn(t);
    } else if (t.type === "namespace" && Array.isArray(t.tools)) {
      // Codex 0.147 groups its ordinary client tools under the reserved `functions` namespace,
      // including freeform custom tools such as code-mode `exec`. Those children are still
      // top-level Responses tools, so flatten them without a namespace. Other namespace groups
      // are MCP-style and keep their namespace for round-trip routing.
      const builtinFunctions = t.name === "functions";
      const ns = typeof t.name === "string" && !builtinFunctions ? t.name : undefined;
      for (const inner of t.tools as unknown[]) {
        if (isObj(inner) && inner.type === "function" && typeof inner.name === "string") pushFn(inner, ns);
        else if (isObj(inner) && inner.type === "custom" && typeof inner.name === "string") pushCustom(inner, ns);
      }
    }
    else if (t.type === "custom" && typeof t.name === "string") {
      pushCustom(t);
    }
    else if (t.type === "tool_search") {
      // Client-executed tool discovery — the gateway to deferred tools (subagents, extra MCP tools).
      // Expose as a function so chat models can call it; the bridge relays it as a tool_search_call.
      out.push({
        name: "tool_search",
        description: toolSearchDescription(t),
        parameters: normalizeParameters(toolSearchParameters(t)),
        toolSearch: true,
      });
    }
    else if (t.type === "image_generation" || t.type === "image_gen") {
      // Keep Codex's image_gen visible to routed chat models. The hosted OpenAI tool
      // cannot execute on Grok; the model still has to see a callable image_gen so
      // Codex's client-side /v1/images request can fire and be relayed to xAI.
      // Identity is the un-namespaced synthetic root (`imageGeneration: true`), not
      // the bare name: a namespaced ordinary `image_gen` must not suppress it.
      const synthetic = buildImageTool();
      // Every un-namespaced `image_gen` collides on one wire name, so removing only
      // the first leaves a second root behind and the catalog stays ambiguous.
      // Drop all root collisions, keep namespaced entries, then insert exactly one
      // synthetic root — at the earliest colliding position so declaration order is
      // preserved for models that read the catalog positionally.
      let insertAt = -1;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const tool = out[i]!;
        if (tool.name !== IMAGE_GEN_TOOL_NAME || tool.namespace) continue;
        out.splice(i, 1);
        insertAt = i;
      }
      if (insertAt >= 0) out.splice(insertAt, 0, synthetic);
      else out.push(synthetic);
    }
    else if (typeof t.name === "string" && t.type !== "web_search" && t.type !== "image_generation") {
      // Any OTHER named tool (e.g. a native/computer-use tool type opencodex doesn't explicitly
      // model) is client-executed — pass it through as a function so the routed model can read and
      // call it naturally; the bridge relays its call as a function_call. Previously such tools were
      // silently dropped, so the model never saw them.
      pushFn(t);
    }
    // Hosted web_search is still dropped here — the web-search sidecar re-injects it.
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Namespace a custom tool was declared under, by its bare name.
 *
 * A `custom_tool_call` echoed back by the client carries only the bare name — the bridge
 * emits `{"type":"custom_tool_call","name":"exec"}` even when the tool was declared as
 * `mcp__functions__exec`. Without this lookup the namespace is lost on the return trip,
 * and the adapters replay history through `namespacedToolName(namespace, name)`, which
 * then produces a bare `exec` the provider may not have. Ordinary `function_call` items
 * do not need this: they carry `namespace` on the wire.
 */
export function customToolNamespaces(tools: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(tools)) return out;
  for (const spec of tools) {
    if (!isObj(spec) || spec.type !== "namespace" || !Array.isArray(spec.tools)) continue;
    const namespace = typeof spec.name === "string" ? spec.name : undefined;
    // Codex 0.147 groups ordinary client tools under the reserved `functions` namespace and
    // buildTools deliberately flattens those without a namespace. Mirror that here, or the
    // reconstruction would invent a namespace the request never advertised.
    if (!namespace || namespace === "functions") continue;
    for (const inner of spec.tools) {
      if (!isObj(inner) || inner.type !== "custom" || typeof inner.name !== "string") continue;
      // Ambiguous bare names are already rejected upstream, so first declaration wins.
      if (!out.has(inner.name)) out.set(inner.name, namespace);
    }
  }
  return out;
}
