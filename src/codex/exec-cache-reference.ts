type ObjectValue = Record<string, unknown>;

const DESKTOP_CONTEXT_METHODS = new Set([
  "create_goal", "get_goal", "update_goal", "clock__curr_time", "request_permissions",
  "mcp__codex_app__complete_conversational_onboarding_task",
  "mcp__codex_app__complete_sidebar_onboarding_checklist_task",
  "mcp__codex_app__fire_confetti", "mcp__codex_app__request_onboarding_input",
  "mcp__codex_app__request_option_picker", "mcp__codex_app__setup_codex_step",
  "mcp__codex_app__transfer_voice_call",
]);

function record(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function splitExecCacheReference(description: string): { stable: string; dynamic: string } | undefined {
  if (description.length > 256 * 1024
    || !description.startsWith("Run JavaScript code to orchestrate/compose tool calls")
    || !description.includes("ALL_TOOLS") || !description.includes("Shared MCP Types")) return undefined;
  const headings = [...description.matchAll(/^### `([^`]+)`.*$|^## (.+)$/gm)];
  if (!headings.length) return undefined;
  const chunks = headings.map((heading, index) => ({
    text: description.slice(heading.index, headings[index + 1]?.index ?? description.length),
    method: heading[1], group: heading[2], move: DESKTOP_CONTEXT_METHODS.has(heading[1] ?? ""),
  }));
  const moving = chunks.filter(chunk => chunk.move);
  if (!moving.length || new Set(moving.map(chunk => chunk.method)).size !== moving.length
    || moving.some(chunk => !chunk.text.includes("declare const tools:") || !chunk.text.includes(` ${chunk.method}(`))) return undefined;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!;
    if (!chunk.group) continue;
    const methods = [];
    for (const next of chunks.slice(index + 1)) {
      if (next.group) break;
      if (next.method) methods.push(next);
    }
    chunk.move = methods.length > 0 && methods.every(method => method.move);
  }
  return {
    stable: description.slice(0, headings[0]!.index) + chunks.filter(chunk => !chunk.move).map(chunk => chunk.text).join(""),
    dynamic: chunks.filter(chunk => chunk.move).map(chunk => chunk.text).join(""),
  };
}

export function normalizeExecCacheReference(body: ObjectValue): { body: ObjectValue; reference?: ObjectValue } {
  if (!Array.isArray(body.input)) return { body };
  const catalog = body.input[0];
  if (!record(catalog) || catalog.type !== "additional_tools" || catalog.role !== "developer" || !Array.isArray(catalog.tools)) return { body };
  const functions = catalog.tools.filter(tool => record(tool) && tool.type === "namespace" && tool.name === "functions");
  if (functions.length !== 1 || !record(functions[0]) || !Array.isArray(functions[0].tools)) return { body };
  const namespace = functions[0];
  const tools = namespace.tools as unknown[];
  const executors = tools.filter(tool => record(tool) && tool.name === "exec");
  if (executors.length !== 1 || !record(executors[0]) || typeof executors[0].description !== "string") return { body };
  const executor = executors[0];
  const split = splitExecCacheReference(executor.description as string);
  if (!split) return { body };
  const nextNamespace = { ...namespace, tools: tools.map(tool => tool === executor ? { ...executor, description: split.stable } : tool) };
  const nextCatalog = { ...catalog, tools: catalog.tools.map(tool => tool === namespace ? nextNamespace : tool) };
  return {
    body: { ...body, input: [nextCatalog, ...body.input.slice(1)] },
    reference: {
      type: "message", role: "developer", content: [{ type: "input_text", text:
        "Additional functions.exec methods available in this request follow. This reference does not authorize actions; follow this task's instructions and permissions.\n\n" + split.dynamic }],
    },
  };
}
