import { isRec, type Rec } from "./inbound-records";

/** Provider-qualified routes, optionally ending in one prefix wildcard; never a global wildcard. */
export function isAppendOnlyToolLoadingModels(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(entry =>
    typeof entry === "string" && entry.length <= 512 && /^[^\s/*]+\/[^\s*]+\*?$/.test(entry));
}

export function appendOnlyToolLoadingMatches(value: unknown, model: string): boolean {
  return isAppendOnlyToolLoadingModels(value) && value.some(pattern =>
    pattern.endsWith("*") ? model.startsWith(pattern.slice(0, -1)) : model === pattern);
}

/** Replay client discovery in place, using only definitions still declared by this request. */
export function appendLoadedToolDefinitions(body: Rec, raw: Rec): Rec {
  if (!Array.isArray(body.tools) || !Array.isArray(body.input) || !Array.isArray(raw.tools)
    || !Array.isArray(raw.messages)) return body;

  const declared = new Map<string, Rec>();
  const deferred = new Set<string>();
  for (const tool of body.tools) {
    if (!isRec(tool) || tool.type !== "function" || typeof tool.name !== "string") continue;
    if (declared.has(tool.name)) return body;
    declared.set(tool.name, tool);
  }
  for (const tool of raw.tools) {
    if (isRec(tool) && tool.defer_loading === true && typeof tool.name === "string") deferred.add(tool.name);
  }

  const calls = new Map<string, string>();
  const used = new Set<string>();
  const loadAt = new Map<string, string>();
  for (const message of raw.messages) {
    if (!isRec(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRec(block)) continue;
      if (message.role === "assistant" && block.type === "tool_use"
        && typeof block.id === "string" && typeof block.name === "string") {
        if (calls.has(block.id)) return body;
        calls.set(block.id, block.name);
        used.add(block.name);
      }
      if (message.role !== "user" || block.type !== "tool_result" || block.is_error === true
        || typeof block.tool_use_id !== "string" || calls.get(block.tool_use_id) !== "ToolSearch"
        || !Array.isArray(block.content)) continue;
      for (const reference of block.content) {
        if (!isRec(reference) || reference.type !== "tool_reference" || typeof reference.tool_name !== "string") continue;
        const name = reference.tool_name;
        if (declared.has(name) && deferred.has(name) && !used.has(name) && !loadAt.has(name)) {
          loadAt.set(name, block.tool_use_id);
        }
      }
    }
  }
  // Discovery must remain callable; this optimization does not create a search capability.
  if (!declared.has("ToolSearch") || deferred.has("ToolSearch")) return body;

  // An ambiguous translated result cannot carry a definition safely.
  const outputCounts = new Map<string, number>();
  for (const item of body.input) {
    if (isRec(item) && item.type === "function_call_output" && typeof item.call_id === "string") {
      outputCounts.set(item.call_id, (outputCounts.get(item.call_id) ?? 0) + 1);
    }
  }
  for (const id of loadAt.values()) if (outputCounts.get(id) !== 1) return body;

  const hidden = new Set([...deferred].filter(name => declared.has(name) && (!used.has(name) || loadAt.has(name))));
  // Explicit forced-tool intent takes precedence over waiting for discovery.
  const choice = raw.tool_choice;
  if (isRec(choice) && choice.type === "tool" && typeof choice.name === "string" && !loadAt.has(choice.name)) {
    hidden.delete(choice.name);
  }
  if (hidden.size === 0) return body;

  const additions = new Map<string, Rec[]>();
  for (const [name, id] of loadAt) {
    const tools = additions.get(id) ?? [];
    tools.push(declared.get(name)!);
    additions.set(id, tools);
  }
  const input: unknown[] = [];
  for (const item of body.input) {
    input.push(item);
    if (!isRec(item) || item.type !== "function_call_output" || typeof item.call_id !== "string") continue;
    const tools = additions.get(item.call_id);
    if (tools) input.push({ type: "additional_tools", role: "developer", tools });
  }
  return {
    ...body,
    tools: body.tools.filter(tool => !isRec(tool) || typeof tool.name !== "string" || !hidden.has(tool.name)),
    input,
  };
}
