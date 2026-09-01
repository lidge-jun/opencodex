import type { SsePayloadRewrite } from "./sse-payload-rewrite";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Drop a tool-call `namespace` that merely repeats the call's own `name` (#3217).
 *
 * codex-rs resolves a client tool call as `ToolName::new(namespace, name)` and treats only
 * `None | "" | "functions"` as the default namespace; anything else is concatenated into a flat
 * name before routing. A backend answer of `{ name: "exec", namespace: "exec" }` therefore
 * becomes `execexec`, which no client tool matches, and Codex re-issues the same call forever.
 * That shape is never a legitimate identity — an MCP namespace is a server name, not the tool —
 * so it is safe to scrub without consulting the declared catalog. The adapter fix that stops
 * provoking the answer lives in `stripSparkCompatibility`; this is the belt to that suspender.
 */
export function scrubSelfNamedToolCallNamespace(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(entry => {
      const result = scrubSelfNamedToolCallNamespace(entry);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = scrubSelfNamedToolCallNamespace(entry);
    out[key] = result.value;
    changed ||= result.changed;
  }
  if (
    (value.type === "custom_tool_call" || value.type === "function_call")
    && typeof value.name === "string"
    && value.name.length > 0
    && value.namespace === value.name
  ) {
    delete out.namespace;
    changed = true;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

export function scrubSelfNamedToolCallNamespaceInJson(text: string): string {
  if (!text.includes("\"namespace\"")) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const result = scrubSelfNamedToolCallNamespace(payload);
  return result.changed ? JSON.stringify(result.value) : text;
}

export function createSelfNamedToolCallNamespaceScrubRewrite(): SsePayloadRewrite {
  return payload => scrubSelfNamedToolCallNamespaceInJson(payload);
}

