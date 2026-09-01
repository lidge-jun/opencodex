import type { SsePayloadRewrite } from "./sse-payload-rewrite";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectBareCustomToolSpecs(
  bareNames: Set<string>,
  sameNameNamespacedNames: Set<string>,
  specs: unknown,
): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec)) continue;
    if (spec.type === "namespace" && Array.isArray(spec.tools)) {
      const namespace = typeof spec.name === "string" ? spec.name : undefined;
      for (const inner of spec.tools) {
        if (!isPlainObject(inner) || typeof inner.name !== "string") continue;
        if (
          (inner.type === "custom" || inner.type === "function")
          && namespace === inner.name
        ) sameNameNamespacedNames.add(inner.name);
        if (inner.type === "custom" && namespace === "functions") bareNames.add(inner.name);
      }
      continue;
    }
    if (typeof spec.name !== "string") continue;
    const namespace = typeof spec.namespace === "string" ? spec.namespace : undefined;
    if (
      (spec.type === "custom" || spec.type === "function")
      && namespace === spec.name
    ) sameNameNamespacedNames.add(spec.name);
    if (spec.type !== "custom") continue;
    if (!namespace || namespace === "functions") bareNames.add(spec.name);
  }
}

/** Bare custom tools both declared by this turn and authorized by its tool_choice. */
export function collectAuthorizedBareCustomToolNames(
  body: unknown,
  authorizedFreeformToolNames: ReadonlySet<string>,
): Set<string> {
  const bareNames = new Set<string>();
  const sameNameNamespacedNames = new Set<string>();
  if (!isPlainObject(body)) return bareNames;
  collectBareCustomToolSpecs(bareNames, sameNameNamespacedNames, body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) collectBareCustomToolSpecs(bareNames, sameNameNamespacedNames, item.tools);
    }
  }
  return new Set(
    [...bareNames].filter(name => (
      authorizedFreeformToolNames.has(name)
      && !sameNameNamespacedNames.has(name)
    )),
  );
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
  authorizedBareCustomToolNames: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(entry => {
      const result = scrubSelfNamedToolCallNamespace(entry, authorizedBareCustomToolNames);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: out, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = scrubSelfNamedToolCallNamespace(entry, authorizedBareCustomToolNames);
    out[key] = result.value;
    changed ||= result.changed;
  }
  if (
    (value.type === "custom_tool_call" || value.type === "function_call")
    && typeof value.name === "string"
    && value.name.length > 0
    && value.namespace === value.name
    && authorizedBareCustomToolNames.has(value.name)
  ) {
    delete out.namespace;
    changed = true;
  }
  return changed ? { value: out, changed: true } : { value, changed: false };
}

export function scrubSelfNamedToolCallNamespaceInJson(
  text: string,
  authorizedBareCustomToolNames: ReadonlySet<string>,
): string {
  if (!text.includes("\"namespace\"")) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const result = scrubSelfNamedToolCallNamespace(payload, authorizedBareCustomToolNames);
  return result.changed ? JSON.stringify(result.value) : text;
}

export function createSelfNamedToolCallNamespaceScrubRewrite(
  authorizedBareCustomToolNames: ReadonlySet<string>,
): SsePayloadRewrite {
  return payload => scrubSelfNamedToolCallNamespaceInJson(payload, authorizedBareCustomToolNames);
}

