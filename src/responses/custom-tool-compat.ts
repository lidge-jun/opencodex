type ProjectedField = "code" | "patch" | "input";
export type RoutedCustomToolProjection = "legacy" | "direct-first";

const ROUTED_CUSTOM_TOOL_PASSTHROUGH = new Set(["apply_patch"]);

export function projectedCustomToolField(name: string): ProjectedField {
  if (name === "exec") return "code";
  if (name === "apply_patch") return "patch";
  return "input";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function customToolInput(argumentsText: unknown): string {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isPlainObject(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch { /* malformed arguments stay visible to the client */ }
  return argumentsText;
}

export function customToolItemId(id: unknown): unknown {
  if (typeof id !== "string") return id;
  return id.startsWith("fc_") ? `ctc_${id.slice(3)}` : id;
}

export function collectRoutedCustomToolNames(
  body: unknown,
  projection: RoutedCustomToolProjection = "legacy",
): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isPlainObject(value)) return;
    if (
      value.type === "custom"
      && typeof value.name === "string"
      && (projection === "direct-first" || !ROUTED_CUSTOM_TOOL_PASSTHROUGH.has(value.name))
    ) {
      names.add(value.name);
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(body);
  return names;
}

function collectConvertedCallIds(value: unknown, names: ReadonlySet<string>, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectConvertedCallIds(entry, names, out);
    return;
  }
  if (!isPlainObject(value)) return;
  if (
    (value.type === "custom_tool_call" || value.type === "function_call")
    && typeof value.name === "string"
    && names.has(value.name)
    && typeof value.call_id === "string"
  ) {
    out.add(value.call_id);
  }
  for (const entry of Object.values(value)) collectConvertedCallIds(entry, names, out);
}

function rewriteForUpstream(
  value: unknown,
  names: ReadonlySet<string>,
  callIds: ReadonlySet<string>,
  projection: RoutedCustomToolProjection,
): unknown {
  if (Array.isArray(value)) return value.map(entry => rewriteForUpstream(entry, names, callIds, projection));
  if (!isPlainObject(value)) return value;

  if (value.type === "custom" && typeof value.name === "string" && names.has(value.name)) {
    const { format: _format, ...rest } = value;
    const isDefinition = typeof value.description === "string"
      || isPlainObject(value.format)
      || isPlainObject(value.parameters);
    if (!isDefinition) return { ...rest, type: "function" };
    const field = projection === "direct-first" ? projectedCustomToolField(value.name) : "input";
    const inputDescription = field === "code"
      ? "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command."
      : field === "patch"
        ? "Patch text for apply_patch, beginning exactly with `*** Begin Patch`."
        : "Raw input for this client-executed custom tool.";
    return {
      ...rest,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          [field]: {
            type: "string",
            description: inputDescription,
          },
        },
        required: [field],
        additionalProperties: false,
      },
    };
  }

  if (
    value.type === "custom_tool_call"
    && typeof value.name === "string"
    && names.has(value.name)
  ) {
    const { input, id: _id, ...rest } = value;
    const field = projection === "direct-first" ? projectedCustomToolField(value.name) : "input";
    return {
      ...rest,
      type: "function_call",
      arguments: JSON.stringify({ [field]: typeof input === "string" ? input : "" }),
    };
  }

  if (
    value.type === "custom_tool_call_output"
    && typeof value.call_id === "string"
    && callIds.has(value.call_id)
  ) {
    return { ...value, type: "function_call_output" };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rewritten = rewriteForUpstream(entry, names, callIds, projection);
    next[key] = rewritten;
    changed ||= rewritten !== entry;
  }
  return changed ? next : value;
}

function directFirstToolOrder(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  let changed = false;
  const next = { ...body };
  const moveExecLast = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    const direct = value.filter(entry => !(isPlainObject(entry) && entry.name === "exec"));
    const exec = value.filter(entry => isPlainObject(entry) && entry.name === "exec");
    if (exec.length === 0) return value;
    const ordered = [...direct, ...exec];
    return ordered.every((entry, index) => entry === value[index]) ? value : ordered;
  };
  const tools = moveExecLast(body.tools);
  if (tools !== body.tools) {
    next.tools = tools;
    changed = true;
  }
  if (Array.isArray(body.input)) {
    const originalInput = body.input;
    const input = originalInput.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools") return item;
      const additional = moveExecLast(item.tools);
      return additional === item.tools ? item : { ...item, tools: additional };
    });
    if (input.some((item, index) => item !== originalInput[index])) {
      next.input = input;
      changed = true;
    }
  }
  return changed ? next : body;
}

export function rewriteRoutedCustomToolsForUpstream(
  body: unknown,
  projection: RoutedCustomToolProjection = "legacy",
): {
  body: unknown;
  names: Set<string>;
} {
  const names = collectRoutedCustomToolNames(body, projection);
  if (names.size === 0) return { body, names };
  const callIds = new Set<string>();
  collectConvertedCallIds(body, names, callIds);
  const rewritten = rewriteForUpstream(body, names, callIds, projection);
  return {
    body: projection === "direct-first" ? directFirstToolOrder(rewritten) : rewritten,
    names,
  };
}

export function restoreRoutedCustomCalls(
  value: unknown,
  names: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map(entry => {
      const result = restoreRoutedCustomCalls(entry, names);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreRoutedCustomCalls(entry, names);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  if (value.type === "function_call" && typeof value.name === "string" && names.has(value.name)) {
    restored.type = "custom_tool_call";
    restored.id = customToolItemId(value.id);
    const field = projectedCustomToolField(value.name);
    let input = customToolInput(value.arguments);
    // Accept projected Responses arguments and legacy {input} history during replay.
    if (typeof value.arguments === "string") {
      try {
        const parsed = JSON.parse(value.arguments) as unknown;
        if (isPlainObject(parsed) && typeof parsed[field] === "string") input = parsed[field] as string;
      } catch { /* malformed arguments remain visible */ }
    }
    restored.input = input;
    delete restored.arguments;
    changed = true;
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function restoreRoutedCustomCallsInJson(
  text: string,
  names: ReadonlySet<string>,
): string {
  if (names.size === 0) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoreRoutedCustomCalls(payload, names);
  return restored.changed ? JSON.stringify(restored.value) : text;
}

export function unwrapRoutedCustomToolArguments(argumentsText: unknown, name?: string): string {
  if (typeof argumentsText !== "string" || !name) return customToolInput(argumentsText);
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isPlainObject(parsed)) {
      const field = projectedCustomToolField(name);
      if (typeof parsed[field] === "string") return parsed[field] as string;
    }
  } catch { /* malformed arguments stay visible */ }
  return customToolInput(argumentsText);
}
