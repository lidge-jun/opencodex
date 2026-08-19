export const TOOL_SEARCH_FUNCTION_NAME = "tool_search";
export const TOOL_SEARCH_DEFAULT_DESCRIPTION = "Search for additional tools to load for the next turn.";
const TOOL_SEARCH_WIRE_ALIAS_PREFIX = "opencodex_tool_search";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function toolSearchDescription(tool: unknown): string {
  return isPlainObject(tool) && typeof tool.description === "string"
    ? tool.description
    : TOOL_SEARCH_DEFAULT_DESCRIPTION;
}

export function toolSearchParameters(tool: unknown): Record<string, unknown> {
  if (isPlainObject(tool) && isPlainObject(tool.parameters)) return tool.parameters;
  // Fresh per parse/build: downstream normalizers are allowed to clone or extend schemas, and a
  // shared mutable default would couple otherwise unrelated requests.
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query for tools to load." },
      limit: { type: "number", description: "Maximum number of tools to return." },
    },
    required: ["query"],
  };
}

function collectToolDeclarationNames(tools: unknown[], names: Set<string>, namespace?: string): void {
  for (const tool of tools) {
    if (!isPlainObject(tool) || tool.type === "tool_search") continue;
    if (tool.type === "function" && isPlainObject(tool.function) && typeof tool.function.name === "string") {
      names.add(tool.function.name);
    }
    if (typeof tool.name === "string") {
      names.add(tool.name);
      if (namespace) names.add(`${namespace}__${tool.name}`);
    }
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      collectToolDeclarationNames(tool.tools, names, typeof tool.name === "string" ? tool.name : undefined);
    }
  }
}

function declaredToolNames(body: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(body.tools)) collectToolDeclarationNames(body.tools, names);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        collectToolDeclarationNames(item.tools, names);
      }
    }
  }
  return names;
}

function hasToolSearchDeclaration(tools: unknown[]): boolean {
  return tools.some(tool => isPlainObject(tool) && tool.type === "tool_search");
}

function chooseToolSearchWireName(usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(TOOL_SEARCH_FUNCTION_NAME)) return TOOL_SEARCH_FUNCTION_NAME;
  if (!usedNames.has(TOOL_SEARCH_WIRE_ALIAS_PREFIX)) return TOOL_SEARCH_WIRE_ALIAS_PREFIX;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${TOOL_SEARCH_WIRE_ALIAS_PREFIX}_${suffix}`;
    if (!usedNames.has(candidate)) return candidate;
  }
}

function rewriteToolList(tools: unknown[], wireName: string): { tools: unknown[]; changed: boolean } {
  let changed = false;
  const rewritten = tools.map(tool => {
    if (!isPlainObject(tool) || tool.type !== "tool_search") return tool;
    const {
      execution: _execution,
      defer_loading: _deferLoading,
      ...rest
    } = tool;
    changed = true;
    return {
      ...rest,
      type: "function",
      name: wireName,
      description: toolSearchDescription(tool),
      parameters: toolSearchParameters(tool),
    };
  });
  return changed ? { tools: rewritten, changed: true } : { tools, changed: false };
}

function rewriteToolChoice(choice: unknown, wireName: string): unknown {
  if (!isPlainObject(choice)) return choice;
  if (choice.type === "tool_search") {
    return { type: "function", name: wireName };
  }
  if (choice.type !== "allowed_tools" || !Array.isArray(choice.tools)) return choice;
  let changed = false;
  const tools = choice.tools.map(tool => {
    if (!isPlainObject(tool) || tool.type !== "tool_search") return tool;
    changed = true;
    return { type: "function", name: wireName };
  });
  return changed ? { ...choice, tools } : choice;
}

function toolChoiceAllowsPrivateSearch(choice: unknown): boolean {
  if (choice === undefined || choice === null || choice === "auto" || choice === "required") return true;
  if (choice === "none") return false;
  if (!isPlainObject(choice)) return true;
  if (choice.type === "tool_search") return true;
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    return choice.tools.some(tool => isPlainObject(tool) && tool.type === "tool_search");
  }
  // A forced ordinary function named `tool_search` is distinct from the private tool kind.
  return false;
}

function upstreamToolSearchItemId(id: unknown): unknown {
  if (typeof id !== "string") return id;
  return id.startsWith("tsc_") ? `fc_${id.slice(4)}` : id;
}

function toolSearchArgumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(isPlainObject(value) ? value : {});
}

function toolSearchOutputText(value: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {
    tools: Array.isArray(value.tools) ? value.tools : [],
  };
  if (typeof value.status === "string") payload.status = value.status;
  return JSON.stringify(payload);
}

function rewriteHistoryItem(item: Record<string, unknown>, wireName: string): Record<string, unknown> {
  if (item.type === "tool_search_call") {
    const {
      execution: _execution,
      arguments: argumentsValue,
      id,
      ...rest
    } = item;
    return {
      ...rest,
      type: "function_call",
      ...(id === undefined ? {} : { id: upstreamToolSearchItemId(id) }),
      name: wireName,
      arguments: toolSearchArgumentsText(argumentsValue),
    };
  }
  if (item.type === "tool_search_output") {
    const {
      execution: _execution,
      id: _id,
      tools: _tools,
      status: _status,
      ...rest
    } = item;
    return {
      ...rest,
      type: "function_call_output",
      output: toolSearchOutputText(item),
    };
  }
  return item;
}

/**
 * Third-party Responses gateways generally implement the public function-tool schema, not Codex's
 * private client-executed `tool_search` declaration. Lower only request catalogs sent to a
 * noncanonical upstream; the caller-facing response is restored separately.
 */
export function rewriteRoutedToolSearchForUpstream(body: unknown): {
  body: unknown;
  names: Set<string>;
} {
  const names = new Set<string>();
  if (!isPlainObject(body)) return { body, names };

  const topLevelSearch = Array.isArray(body.tools) && hasToolSearchDeclaration(body.tools);
  const inputItems = Array.isArray(body.input) ? body.input : [];
  const additionalSearch = inputItems.some(item =>
    isPlainObject(item)
    && item.type === "additional_tools"
    && Array.isArray(item.tools)
    && hasToolSearchDeclaration(item.tools));
  const historySearch = inputItems.some(item =>
    isPlainObject(item)
    && (item.type === "tool_search_call" || item.type === "tool_search_output"));
  if (!topLevelSearch && !additionalSearch && !historySearch) return { body, names };

  const wireName = chooseToolSearchWireName(declaredToolNames(body));
  const declarationChanged = topLevelSearch || additionalSearch;

  let tools = body.tools;
  if (Array.isArray(tools)) {
    const result = rewriteToolList(tools, wireName);
    tools = result.tools;
  }

  let input = body.input;
  let historyLowered = false;
  if (Array.isArray(input)) {
    input = input.map(item => {
      if (!isPlainObject(item)) return item;
      if (item.type === "additional_tools" && Array.isArray(item.tools)) {
        const result = rewriteToolList(item.tools, wireName);
        return result.changed ? { ...item, tools: result.tools } : item;
      }
      const rewritten = rewriteHistoryItem(item, wireName);
      if (rewritten !== item) historyLowered = true;
      return rewritten;
    });
  }

  // A turn can replay `tool_search_call` history WITHOUT re-declaring the tool — Codex normally
  // sends the declaration, but a history-only body is legal. The history is lowered to
  // `function_call` either way, so restoration has to be armed on that too: leaving `names`
  // empty there would hand the client a public `function_call` for what it issued as a private
  // search call, and the round trip would silently stop matching.
  if ((declarationChanged || historyLowered) && toolChoiceAllowsPrivateSearch(body.tool_choice)) {
    names.add(wireName);
  }
  const toolChoice = declarationChanged ? rewriteToolChoice(body.tool_choice, wireName) : body.tool_choice;
  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}),
    },
    names,
  };
}

export function toolSearchItemId(id: unknown): unknown {
  if (typeof id !== "string") return id;
  return id.startsWith("fc_") ? `tsc_${id.slice(3)}` : id;
}

function toolSearchArguments(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function restoreRoutedToolSearchCalls(
  value: unknown,
  names: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map(entry => {
      const result = restoreRoutedToolSearchCalls(entry, names);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreRoutedToolSearchCalls(entry, names);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  if (value.type === "function_call" && typeof value.name === "string" && names.has(value.name)) {
    restored.type = "tool_search_call";
    restored.id = toolSearchItemId(value.id);
    restored.execution = "client";
    restored.arguments = toolSearchArguments(value.arguments);
    delete restored.name;
    changed = true;
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function restoreRoutedToolSearchCallsInJson(
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
  const restored = restoreRoutedToolSearchCalls(payload, names);
  return restored.changed ? JSON.stringify(restored.value) : text;
}
