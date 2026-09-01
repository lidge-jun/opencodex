import type { SsePayloadRewrite } from "./sse-payload-rewrite";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface SelfNamedNamespaceScrubAuthorization {
  customToolCallNames: ReadonlySet<string>;
  functionCallNames: ReadonlySet<string>;
}

function collectBareCustomToolSpecs(
  bareNames: Set<string>,
  sameNameNamespacedCustomNames: Set<string>,
  sameNameNamespacedFunctionNames: Set<string>,
  specs: unknown,
): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec)) continue;
    if (spec.type === "namespace" && Array.isArray(spec.tools)) {
      const namespace = typeof spec.name === "string" ? spec.name : undefined;
      for (const inner of spec.tools) {
        if (!isPlainObject(inner) || typeof inner.name !== "string") continue;
        if (namespace === inner.name) {
          if (inner.type === "custom") sameNameNamespacedCustomNames.add(inner.name);
          else if (inner.type === "function") sameNameNamespacedFunctionNames.add(inner.name);
        }
        if (inner.type === "custom" && namespace === "functions") bareNames.add(inner.name);
      }
      continue;
    }
    if (typeof spec.name !== "string") continue;
    const namespace = typeof spec.namespace === "string" ? spec.namespace : undefined;
    if (namespace === spec.name) {
      if (spec.type === "custom") sameNameNamespacedCustomNames.add(spec.name);
      else if (spec.type === "function") sameNameNamespacedFunctionNames.add(spec.name);
    }
    if (spec.type === "custom" && (!namespace || namespace === "functions")) bareNames.add(spec.name);
  }
}

/** Bare custom tools authorized by this turn, scoped to each response call type. */
export function collectSelfNamedNamespaceScrubAuthorization(
  body: unknown,
  authorizedBareCustomToolNames: ReadonlySet<string>,
): SelfNamedNamespaceScrubAuthorization {
  const bareNames = new Set<string>();
  const sameNameNamespacedCustomNames = new Set<string>();
  const sameNameNamespacedFunctionNames = new Set<string>();
  if (isPlainObject(body)) {
    collectBareCustomToolSpecs(
      bareNames,
      sameNameNamespacedCustomNames,
      sameNameNamespacedFunctionNames,
      body.tools,
    );
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (
          isPlainObject(item)
          && (item.type === "additional_tools" || item.type === "tool_search_output")
        ) {
          collectBareCustomToolSpecs(
            bareNames,
            sameNameNamespacedCustomNames,
            sameNameNamespacedFunctionNames,
            item.tools,
          );
        }
      }
    }
  }
  const authorizedNames = [...bareNames].filter(name => authorizedBareCustomToolNames.has(name));
  return {
    customToolCallNames: new Set(
      authorizedNames.filter(name => !sameNameNamespacedCustomNames.has(name)),
    ),
    functionCallNames: new Set(
      authorizedNames.filter(name => !sameNameNamespacedFunctionNames.has(name)),
    ),
  };
}

/**
 * Drop a tool-call `namespace` that merely repeats the call's own `name` (#3217).
 *
 * codex-rs resolves a client tool call as `ToolName::new(namespace, name)` and treats only
 * `None | "" | "functions"` as the default namespace; anything else is concatenated into a flat
 * name before routing. A backend answer of `{ name: "exec", namespace: "exec" }` therefore
 * becomes `execexec`, which no client tool matches, and Codex re-issues the same call forever.
 * The malformed Spark shape is scrubbed only when the current turn authorized a bare custom tool
 * with that name. A genuine namespaced tool may intentionally use the same namespace and name.
 * The adapter fix that stops provoking the answer lives in `stripSparkCompatibility`; this is the
 * belt to that suspender.
 */
export function scrubSelfNamedToolCallNamespace(
  value: unknown,
  authorization: SelfNamedNamespaceScrubAuthorization,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(entry => {
      const result = scrubSelfNamedToolCallNamespace(entry, authorization);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = scrubSelfNamedToolCallNamespace(entry, authorization);
    out[key] = result.value;
    changed ||= result.changed;
  }
  const authorizedNames = value.type === "custom_tool_call"
    ? authorization.customToolCallNames
    : value.type === "function_call"
      ? authorization.functionCallNames
      : undefined;
  if (
    authorizedNames
    && typeof value.name === "string"
    && value.name.length > 0
    && value.namespace === value.name
    && authorizedNames.has(value.name)
  ) {
    delete out.namespace;
    changed = true;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

export function scrubSelfNamedToolCallNamespaceInJson(
  text: string,
  authorization: SelfNamedNamespaceScrubAuthorization,
): string {
  if (!text.includes("\"namespace\"")) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const result = scrubSelfNamedToolCallNamespace(payload, authorization);
  return result.changed ? JSON.stringify(result.value) : text;
}

export function createSelfNamedToolCallNamespaceScrubRewrite(
  authorization: SelfNamedNamespaceScrubAuthorization,
): SsePayloadRewrite {
  return payload => scrubSelfNamedToolCallNamespaceInJson(payload, authorization);
}

