const ROUTED_CUSTOM_TOOL_PASSTHROUGH = new Set(["apply_patch"]);

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

/**
 * Lazily enumerate a parsed object's own enumerable string keys. One generator stays
 * alive per open object level, so the iterative walks below never materialize key
 * arrays proportional to the payload.
 */
function* ownEnumerableKeys(record: Record<string, unknown>): Generator<string> {
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) yield key;
  }
}

export function collectRoutedCustomToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const value = stack.pop()!;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      continue;
    }
    if (!isPlainObject(value)) continue;
    if (
      value.type === "custom"
      && typeof value.name === "string"
      && !ROUTED_CUSTOM_TOOL_PASSTHROUGH.has(value.name)
    ) {
      names.add(value.name);
    }
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) stack.push(value[key]);
    }
  }
  return names;
}

function collectConvertedCallIds(value: unknown, names: ReadonlySet<string>, out: Set<string>): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
      continue;
    }
    if (!isPlainObject(current)) continue;
    if (
      (current.type === "custom_tool_call" || current.type === "function_call")
      && typeof current.name === "string"
      && names.has(current.name)
      && typeof current.call_id === "string"
    ) {
      out.add(current.call_id);
    }
    for (const key in current) {
      if (Object.prototype.hasOwnProperty.call(current, key)) stack.push(current[key]);
    }
  }
}

/**
 * Replace a node that the routed-custom-tool rewrite consumes wholesale, or return
 * undefined when the node must be traversed normally. These nodes are leaves for the
 * rewrite: their inner fields are replaced or dropped rather than rewritten.
 */
function rewriteCustomToolNode(
  node: unknown,
  names: ReadonlySet<string>,
  callIds: ReadonlySet<string>,
): unknown {
  if (!isPlainObject(node)) return undefined;
  if (node.type === "custom" && typeof node.name === "string" && names.has(node.name)) {
    const { format: _format, ...rest } = node;
    const isDefinition = typeof node.description === "string"
      || isPlainObject(node.format)
      || isPlainObject(node.parameters);
    if (!isDefinition) return { ...rest, type: "function" };
    return {
      ...rest,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Raw input for this client-executed custom tool.",
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
    };
  }
  if (
    node.type === "custom_tool_call"
    && typeof node.name === "string"
    && names.has(node.name)
  ) {
    const { input, id: _id, ...rest } = node;
    return {
      ...rest,
      type: "function_call",
      arguments: JSON.stringify({ input: typeof input === "string" ? input : "" }),
    };
  }
  if (
    node.type === "custom_tool_call_output"
    && typeof node.call_id === "string"
    && callIds.has(node.call_id)
  ) {
    return { ...node, type: "function_call_output" };
  }
  return undefined;
}

/**
 * Node transform for {@link mapJsonTree}. Return the replacement node, or undefined to
 * keep the node — pre-order mode then descends into it (a replacement is a leaf), while
 * post-order mode keeps its rebuilt form.
 */
type JsonTreeTransform = (node: Record<string, unknown>) => unknown | undefined;

/**
 * Copy-on-write JSON tree walk shared by the routed custom-tool upstream rewrite
 * (pre-order: a replaced node is a leaf) and the client-facing restore (post-order:
 * replacement happens after children are rebuilt). Iterative over container/index
 * frames with lazy key enumeration, so deeply nested client payloads cannot overflow
 * the call stack; unchanged subtrees keep their original references (change detection
 * is reference-based per child). Returns the transformed value and whether any node
 * (including the root) was replaced.
 */
export function mapJsonTree(
  value: unknown,
  transform: JsonTreeTransform,
  mode: "pre" | "post",
): { value: unknown; changed: boolean } {
  type Slot = { value: unknown };
  type Changed = { flag: boolean };
  type Frame =
    | { kind: "node"; node: unknown; slot: Slot }
    | { kind: "array"; array: unknown[]; index: number; next: unknown[]; changed: Changed; slot: Slot }
    | { kind: "object"; record: Record<string, unknown>; keys: Generator<string>; next: Record<string, unknown>; changed: Changed; slot: Slot }
    | { kind: "array-assign"; next: unknown[]; changed: Changed; index: number; child: unknown; slot: Slot }
    | { kind: "object-assign"; next: Record<string, unknown>; changed: Changed; key: string; child: unknown; slot: Slot };

  const rootChanged: Changed = { flag: false };
  const rootSlot: Slot = { value };
  const stack: Frame[] = [{ kind: "node", node: value, slot: rootSlot }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "node") {
      const node = frame.node;
      if (mode === "pre" && isPlainObject(node)) {
        const leaf = transform(node);
        if (leaf !== undefined) {
          frame.slot.value = leaf;
          if (frame.slot === rootSlot) rootChanged.flag = true;
          continue;
        }
      }
      if (Array.isArray(node)) {
        const changed = frame.slot === rootSlot ? rootChanged : { flag: false };
        stack.push({
          kind: "array",
          array: node,
          index: 0,
          next: new Array<unknown>(node.length),
          changed,
          slot: frame.slot,
        });
      } else if (isPlainObject(node)) {
        const changed = frame.slot === rootSlot ? rootChanged : { flag: false };
        stack.push({
          kind: "object",
          record: node,
          keys: ownEnumerableKeys(node),
          next: {},
          changed,
          slot: frame.slot,
        });
      } else {
        frame.slot.value = node;
      }
    } else if (frame.kind === "array") {
      if (frame.index < frame.array.length) {
        const child = frame.array[frame.index];
        const childSlot: Slot = { value: child };
        stack.push({ kind: "array", array: frame.array, index: frame.index + 1, next: frame.next, changed: frame.changed, slot: frame.slot });
        stack.push({ kind: "array-assign", next: frame.next, changed: frame.changed, index: frame.index, child, slot: childSlot });
        stack.push({ kind: "node", node: child, slot: childSlot });
      } else {
        frame.slot.value = frame.changed.flag ? frame.next : frame.array;
      }
    } else if (frame.kind === "object") {
      const nextKey = frame.keys.next();
      if (nextKey.done) {
        const source = frame.changed.flag ? frame.next : frame.record;
        if (mode === "post") {
          const replacement = transform(source);
          if (replacement !== undefined) {
            frame.slot.value = replacement;
            frame.changed.flag = true;
          } else {
            frame.slot.value = source;
          }
        } else {
          frame.slot.value = source;
        }
      } else {
        const key = nextKey.value;
        const child = frame.record[key];
        const childSlot: Slot = { value: child };
        stack.push({ kind: "object", record: frame.record, keys: frame.keys, next: frame.next, changed: frame.changed, slot: frame.slot });
        stack.push({ kind: "object-assign", next: frame.next, changed: frame.changed, key, child, slot: childSlot });
        stack.push({ kind: "node", node: child, slot: childSlot });
      }
    } else if (frame.kind === "array-assign") {
      frame.next[frame.index] = frame.slot.value;
      frame.changed.flag ||= frame.slot.value !== frame.child;
    } else {
      frame.next[frame.key] = frame.slot.value;
      frame.changed.flag ||= frame.slot.value !== frame.child;
    }
  }
  return { value: rootSlot.value, changed: rootChanged.flag };
}

function rewriteForUpstream(
  value: unknown,
  names: ReadonlySet<string>,
  callIds: ReadonlySet<string>,
): unknown {
  return mapJsonTree(value, (node) => rewriteCustomToolNode(node, names, callIds), "pre").value;
}

export function rewriteRoutedCustomToolsForUpstream(body: unknown): {
  body: unknown;
  names: Set<string>;
} {
  const names = collectRoutedCustomToolNames(body);
  if (names.size === 0) return { body, names };
  const callIds = new Set<string>();
  collectConvertedCallIds(body, names, callIds);
  return { body: rewriteForUpstream(body, names, callIds), names };
}

export function restoreRoutedCustomCalls(
  value: unknown,
  names: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  return mapJsonTree(value, (node) => {
    if (
      node.type === "function_call"
      && typeof node.name === "string"
      && names.has(node.name)
    ) {
      const restored: Record<string, unknown> = {
        ...node,
        type: "custom_tool_call",
        id: customToolItemId(node.id),
        input: customToolInput(node.arguments),
      };
      delete restored.arguments;
      return restored;
    }
    return undefined;
  }, "post");
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

export function unwrapRoutedCustomToolArguments(argumentsText: unknown): string {
  return customToolInput(argumentsText);
}
