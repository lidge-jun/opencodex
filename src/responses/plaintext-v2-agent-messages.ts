const COLLABORATION_NAMESPACE = "collaboration";
export const PLAINTEXT_V2_COLLABORATION_NAMESPACE = "collaboration-optimize";
const COLLABORATION_NAME_PREFIX = `${COLLABORATION_NAMESPACE}__`;
const COLLABORATION_DOTTED_NAME_PREFIX = `${COLLABORATION_NAMESPACE}.`;
const PLAINTEXT_V2_COLLABORATION_NAME_PREFIX = `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}__`;
const PLAINTEXT_V2_COLLABORATION_DOTTED_NAME_PREFIX = `${PLAINTEXT_V2_COLLABORATION_NAMESPACE}.`;

const PLAINTEXT_V2_AGENT_MESSAGE_TOOLS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

const PLAINTEXT_V2_AGENT_MESSAGE_TOOL_ALIASES = new Map<string, string>([
  ["spawn_agent", "start_delegated_task"],
  ["send_message", "deliver_delegated_message"],
  ["followup_task", "continue_delegated_task"],
]);

const PLAINTEXT_V2_AGENT_MESSAGE_TOOL_NAMES = new Map<string, string>(
  [...PLAINTEXT_V2_AGENT_MESSAGE_TOOL_ALIASES].map(([name, alias]) => [alias, name]),
);

export function shouldPreparePlaintextV2AgentMessages(args: {
  enabled: boolean;
  inboundWire: string;
  canonicalChatGpt: boolean;
  requestBody: unknown;
}): boolean {
  return args.enabled
    && args.inboundWire === "responses"
    && args.canonicalChatGpt
    && hasPlaintextV2CollaborationCatalog(args.requestBody);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseToolCatalogs(body: Record<string, unknown>): unknown[][] {
  const catalogs: unknown[][] = [];
  if (Array.isArray(body.tools)) catalogs.push(body.tools);
  if (!Array.isArray(body.input)) return catalogs;
  for (const item of body.input) {
    if (
      isPlainObject(item)
      && item.type === "additional_tools"
      && Array.isArray(item.tools)
    ) {
      catalogs.push(item.tools);
    }
  }
  return catalogs;
}

function collaborationCatalogInfo(catalogs: readonly unknown[][]): {
  hasV2Catalog: boolean;
  toolNames: Set<string>;
  aliasedAgentMessageToolNames: Set<string>;
} {
  let hasV2Catalog = false;
  const toolNames = new Set<string>();
  const aliasedAgentMessageToolNames = new Set<string>();
  for (const tools of catalogs) {
    for (const tool of tools) {
      if (
        !isPlainObject(tool)
        || tool.type !== "namespace"
        || tool.name !== COLLABORATION_NAMESPACE
        || !Array.isArray(tool.tools)
      ) {
        continue;
      }
      for (const child of tool.tools) {
        if (
          isPlainObject(child)
          && (child.type === "function" || child.type === "custom")
          && typeof child.name === "string"
        ) {
          toolNames.add(child.name);
          if (
            child.type === "function"
            && PLAINTEXT_V2_AGENT_MESSAGE_TOOL_ALIASES.has(child.name)
          ) {
            aliasedAgentMessageToolNames.add(child.name);
          }
          if (child.type === "function" && child.name === "spawn_agent") hasV2Catalog = true;
        }
      }
    }
  }
  return { hasV2Catalog, toolNames, aliasedAgentMessageToolNames };
}

export function hasPlaintextV2CollaborationCatalog(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  return Array.isArray(body.tools) && collaborationCatalogInfo([body.tools]).hasV2Catalog;
}

function hasOptimizedNamespaceConflict(catalogs: readonly unknown[][]): boolean {
  const pending = [...catalogs];
  while (pending.length > 0) {
    const tools = pending.pop()!;
    for (const tool of tools) {
      if (!isPlainObject(tool)) continue;
      if (
        typeof tool.name === "string"
        && (
          tool.name === PLAINTEXT_V2_COLLABORATION_NAMESPACE
          || tool.name.startsWith(PLAINTEXT_V2_COLLABORATION_NAME_PREFIX)
          || tool.name.startsWith(PLAINTEXT_V2_COLLABORATION_DOTTED_NAME_PREFIX)
        )
      ) {
        return true;
      }
      if (tool.type === "namespace" && Array.isArray(tool.tools)) pending.push(tool.tools);
    }
  }
  return false;
}

function isToolIdentity(value: Record<string, unknown>): boolean {
  return value.type === "function"
    || value.type === "custom"
    || value.type === "function_call"
    || value.type === "custom_tool_call";
}

function isOptimizedToolIdentity(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (
    isToolIdentity(value)
    && (
      value.namespace === PLAINTEXT_V2_COLLABORATION_NAMESPACE
      || (
        typeof value.name === "string"
        && (
          value.name === PLAINTEXT_V2_COLLABORATION_NAMESPACE
          || value.name.startsWith(PLAINTEXT_V2_COLLABORATION_NAME_PREFIX)
          || value.name.startsWith(PLAINTEXT_V2_COLLABORATION_DOTTED_NAME_PREFIX)
        )
      )
    )
  ) {
    return true;
  }
  return value.type === "namespace" && value.name === PLAINTEXT_V2_COLLABORATION_NAMESPACE;
}

function hasOptimizedReferenceConflict(body: Record<string, unknown>): boolean {
  if (isOptimizedToolIdentity(body.tool_choice)) return true;
  if (
    isPlainObject(body.tool_choice)
    && Array.isArray(body.tool_choice.tools)
    && body.tool_choice.tools.some(isOptimizedToolIdentity)
  ) {
    return true;
  }
  if (!Array.isArray(body.input)) return false;
  return body.input.some(item => (
    isPlainObject(item)
    && (item.type === "function_call" || item.type === "custom_tool_call")
    && isOptimizedToolIdentity(item)
  ));
}

function hasToolSearchCollaborationConflict(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.input)) return false;
  for (const item of body.input) {
    if (!isPlainObject(item) || item.type !== "tool_search_output" || !Array.isArray(item.tools)) {
      continue;
    }
    const pending = [item.tools];
    while (pending.length > 0) {
      const tools = pending.pop()!;
      for (const tool of tools) {
        if (!isPlainObject(tool)) continue;
        if (
          typeof tool.name === "string"
          && (tool.name === COLLABORATION_NAMESPACE
            || tool.name === PLAINTEXT_V2_COLLABORATION_NAMESPACE
            || tool.name.startsWith(COLLABORATION_NAME_PREFIX)
              || tool.name.startsWith(COLLABORATION_DOTTED_NAME_PREFIX)
              || tool.name.startsWith(PLAINTEXT_V2_COLLABORATION_NAME_PREFIX)
            || tool.name.startsWith(PLAINTEXT_V2_COLLABORATION_DOTTED_NAME_PREFIX))
        ) {
          return true;
        }
        if (tool.type === "namespace" && Array.isArray(tool.tools)) pending.push(tool.tools);
      }
    }
  }
  return false;
}

function hasAgentMessageEncryptionMarker(tool: Record<string, unknown>): boolean {
  return tool.type === "function"
    && typeof tool.name === "string"
    && PLAINTEXT_V2_AGENT_MESSAGE_TOOLS.has(tool.name)
    && isPlainObject(tool.parameters)
    && isPlainObject(tool.parameters.properties)
    && isPlainObject(tool.parameters.properties.message)
    && tool.parameters.properties.message.encrypted === true;
}

function rewriteAgentMessageToolDeclaration(tool: Record<string, unknown>): Record<string, unknown> {
  const alias = tool.type === "function" && typeof tool.name === "string"
    ? PLAINTEXT_V2_AGENT_MESSAGE_TOOL_ALIASES.get(tool.name)
    : undefined;
  if (!alias) return tool;

  let rewritten: Record<string, unknown> = { ...tool, name: alias };
  if (
    hasAgentMessageEncryptionMarker(tool)
    && isPlainObject(tool.parameters)
    && isPlainObject(tool.parameters.properties)
    && isPlainObject(tool.parameters.properties.message)
  ) {
    const { encrypted: _encrypted, ...messageSchema } = tool.parameters.properties.message;
    rewritten = {
      ...rewritten,
      parameters: {
        ...tool.parameters,
        properties: {
          ...tool.parameters.properties,
          message: messageSchema,
        },
      },
    };
  }
  return rewritten;
}

function hasPrivateToolName(name: string): boolean {
  return name === PLAINTEXT_V2_COLLABORATION_NAMESPACE
    || name.startsWith(PLAINTEXT_V2_COLLABORATION_NAME_PREFIX)
    || name.startsWith(PLAINTEXT_V2_COLLABORATION_DOTTED_NAME_PREFIX)
    || PLAINTEXT_V2_AGENT_MESSAGE_TOOL_NAMES.has(name.split(/__|\./).at(-1)!);
}

function hasAgentMessageToolAliasCatalogConflict(
  body: Record<string, unknown>,
  catalogs: readonly unknown[][],
): boolean {
  const pending = [...catalogs];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && item.type === "tool_search_output"
        && Array.isArray(item.tools)
      ) {
        pending.push(item.tools);
      }
    }
  }
  while (pending.length > 0) {
    const tools = pending.pop()!;
    for (const tool of tools) {
      if (!isPlainObject(tool)) continue;
      if (
        typeof tool.name === "string"
        && hasPrivateToolName(tool.name)
      ) {
        return true;
      }
      if (tool.type === "namespace" && Array.isArray(tool.tools)) pending.push(tool.tools);
    }
  }
  return false;
}

function hasAgentMessageToolAliasReference(value: unknown): boolean {
  if (!isPlainObject(value) || !isToolIdentity(value) || typeof value.name !== "string") {
    return false;
  }
  if (hasPrivateToolName(value.name)) return true;
  for (const prefix of [COLLABORATION_NAME_PREFIX, COLLABORATION_DOTTED_NAME_PREFIX]) {
    if (
      value.name.startsWith(prefix)
      && PLAINTEXT_V2_AGENT_MESSAGE_TOOL_NAMES.has(value.name.slice(prefix.length))
    ) {
      return true;
    }
  }
  return false;
}

function hasAgentMessageToolAliasReferenceConflict(body: Record<string, unknown>): boolean {
  if (hasAgentMessageToolAliasReference(body.tool_choice)) return true;
  if (
    isPlainObject(body.tool_choice)
    && Array.isArray(body.tool_choice.tools)
    && body.tool_choice.tools.some(hasAgentMessageToolAliasReference)
  ) {
    return true;
  }
  if (!Array.isArray(body.input)) return false;
  return body.input.some(item => (
    isPlainObject(item)
    && (item.type === "function_call" || item.type === "custom_tool_call")
    && hasAgentMessageToolAliasReference(item)
  ));
}

function hasFlattenedCollaborationDeclarationConflict(
  catalogs: readonly unknown[][],
  collaborationToolNames: ReadonlySet<string>,
): boolean {
  const qualifiedNames = new Set(
    [...collaborationToolNames].flatMap(name => [
      `${COLLABORATION_NAME_PREFIX}${name}`,
      `${COLLABORATION_DOTTED_NAME_PREFIX}${name}`,
    ]),
  );
  const pending = catalogs.map(tools => ({ tools, collaborationNamespace: false }));
  while (pending.length > 0) {
    const { tools, collaborationNamespace } = pending.pop()!;
    for (const tool of tools) {
      if (!isPlainObject(tool)) continue;
      if (
        !collaborationNamespace
        && (tool.type === "function" || tool.type === "custom")
        && typeof tool.name === "string"
        && qualifiedNames.has(tool.name)
      ) {
        return true;
      }
      if (tool.type === "namespace" && Array.isArray(tool.tools)) {
        pending.push({
          tools: tool.tools,
          collaborationNamespace: tool.name === COLLABORATION_NAMESPACE,
        });
      }
    }
  }
  return false;
}

function rewriteToolCatalog(tools: unknown[]): {
  tools: unknown[];
  namespaceAliased: boolean;
} {
  let namespaceAliased = false;
  let changed = false;
  const rewritten = tools.map(tool => {
    if (
      !isPlainObject(tool)
      || tool.type !== "namespace"
      || tool.name !== COLLABORATION_NAMESPACE
      || !Array.isArray(tool.tools)
    ) {
      return tool;
    }
    const childTools = tool.tools.map(child => (
      isPlainObject(child) ? rewriteAgentMessageToolDeclaration(child) : child
    ));
    namespaceAliased = true;
    changed = true;
    return {
      ...tool,
      name: PLAINTEXT_V2_COLLABORATION_NAMESPACE,
      tools: childTools,
    };
  });
  return { tools: changed ? rewritten : tools, namespaceAliased };
}

function aliasCollaborationReference(
  value: unknown,
  collaborationToolNames: ReadonlySet<string>,
): unknown {
  if (!isPlainObject(value)) return value;
  const type = value.type;
  const canCarryNamespace = isToolIdentity(value);
  if (canCarryNamespace && value.namespace !== undefined && value.namespace !== COLLABORATION_NAMESPACE) return value;
  let rewritten = value;
  if (canCarryNamespace && value.namespace === COLLABORATION_NAMESPACE) {
    const name = (type === "function" || type === "function_call") && typeof value.name === "string"
      ? PLAINTEXT_V2_AGENT_MESSAGE_TOOL_ALIASES.get(value.name) ?? value.name
      : value.name;
    rewritten = { ...rewritten, namespace: PLAINTEXT_V2_COLLABORATION_NAMESPACE, name };
  }
  if (type === "namespace" && value.name === COLLABORATION_NAMESPACE) {
    rewritten = { ...rewritten, name: PLAINTEXT_V2_COLLABORATION_NAMESPACE };
  } else if (
    canCarryNamespace
    && typeof value.name === "string"
    && value.name.startsWith(COLLABORATION_NAME_PREFIX)
    && collaborationToolNames.has(value.name.slice(COLLABORATION_NAME_PREFIX.length))
  ) {
    const childName = value.name.slice(COLLABORATION_NAME_PREFIX.length);
    rewritten = {
      ...rewritten,
      name: `${PLAINTEXT_V2_COLLABORATION_NAME_PREFIX}${
        (type === "function" || type === "function_call")
          ? PLAINTEXT_V2_AGENT_MESSAGE_TOOL_ALIASES.get(childName) ?? childName
          : childName
      }`,
    };
  } else if (
    canCarryNamespace
    && typeof value.name === "string"
    && value.name.startsWith(COLLABORATION_DOTTED_NAME_PREFIX)
    && collaborationToolNames.has(value.name.slice(COLLABORATION_DOTTED_NAME_PREFIX.length))
  ) {
    const childName = value.name.slice(COLLABORATION_DOTTED_NAME_PREFIX.length);
    rewritten = {
      ...rewritten,
      name: `${PLAINTEXT_V2_COLLABORATION_DOTTED_NAME_PREFIX}${
        (type === "function" || type === "function_call")
          ? PLAINTEXT_V2_AGENT_MESSAGE_TOOL_ALIASES.get(childName) ?? childName
          : childName
      }`,
    };
  }
  return rewritten;
}

function aliasCollaborationToolChoice(
  toolChoice: unknown,
  collaborationToolNames: ReadonlySet<string>,
): unknown {
  if (!isPlainObject(toolChoice)) return toolChoice;
  let rewritten = aliasCollaborationReference(
    toolChoice,
    collaborationToolNames,
  ) as Record<string, unknown>;
  if (!Array.isArray(toolChoice.tools)) return rewritten;
  let toolsChanged = false;
  const tools = toolChoice.tools.map(tool => {
    const aliased = aliasCollaborationReference(tool, collaborationToolNames);
    toolsChanged ||= aliased !== tool;
    return aliased;
  });
  if (toolsChanged) rewritten = { ...rewritten, tools };
  return rewritten;
}

/**
 * Prepare v2 collaboration tools for plaintext messages on the canonical ChatGPT wire.
 *
 * ChatGPT reserves both `collaboration` and the three message-tool names. The request therefore
 * uses fixed, request-scoped aliases for both, then restores every identity before Codex sees it.
 */
export function preparePlaintextV2AgentMessages(body: unknown): {
  body: unknown;
  namespaceAliased: boolean;
  toolNames: ReadonlySet<string>;
  aliasedAgentMessageToolNames: ReadonlySet<string>;
} {
  if (!isPlainObject(body)) {
    return {
      body,
      namespaceAliased: false,
      toolNames: new Set(),
      aliasedAgentMessageToolNames: new Set(),
    };
  }
  const catalogs = responseToolCatalogs(body);
  const catalogInfo = collaborationCatalogInfo(catalogs);
  if (
    !hasPlaintextV2CollaborationCatalog(body)
    || hasOptimizedNamespaceConflict(catalogs)
    || hasOptimizedReferenceConflict(body)
    || hasToolSearchCollaborationConflict(body)
    || hasFlattenedCollaborationDeclarationConflict(catalogs, catalogInfo.toolNames)
    || hasAgentMessageToolAliasCatalogConflict(body, catalogs)
    || hasAgentMessageToolAliasReferenceConflict(body)
  ) {
    return {
      body,
      namespaceAliased: false,
      toolNames: new Set(),
      aliasedAgentMessageToolNames: new Set(),
    };
  }

  let namespaceAliased = false;
  let tools = body.tools;
  if (Array.isArray(body.tools)) {
    const rewritten = rewriteToolCatalog(body.tools);
    tools = rewritten.tools;
    namespaceAliased ||= rewritten.namespaceAliased;
  }

  let input = body.input;
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const rewrittenInput = body.input.map(item => {
      if (
        !isPlainObject(item)
        || item.type !== "additional_tools"
        || !Array.isArray(item.tools)
      ) {
        return item;
      }
      const rewritten = rewriteToolCatalog(item.tools);
      namespaceAliased ||= rewritten.namespaceAliased;
      if (rewritten.tools === item.tools) return item;
      inputChanged = true;
      return { ...item, tools: rewritten.tools };
    });
    if (inputChanged) input = rewrittenInput;
  }

  let toolChoice = body.tool_choice;
  if (namespaceAliased) {
    toolChoice = aliasCollaborationToolChoice(body.tool_choice, catalogInfo.toolNames);
    if (Array.isArray(input)) {
      let inputChanged = false;
      const aliasedInput = input.map(item => {
        if (!isPlainObject(item)) return item;
        if (item.type !== "function_call" && item.type !== "custom_tool_call") return item;
        const aliased = aliasCollaborationReference(item, catalogInfo.toolNames);
        inputChanged ||= aliased !== item;
        return aliased;
      });
      if (inputChanged) input = aliasedInput;
    }
  }

  if (!namespaceAliased || (tools === body.tools && input === body.input && toolChoice === body.tool_choice)) {
    return {
      body,
      namespaceAliased: false,
      toolNames: new Set(),
      aliasedAgentMessageToolNames: new Set(),
    };
  }
  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}),
    },
    namespaceAliased,
    toolNames: new Set(catalogInfo.toolNames),
    aliasedAgentMessageToolNames: new Set(catalogInfo.aliasedAgentMessageToolNames),
  };
}

const MAX_RESTORED_TOOL_IDENTITIES = 10_000;
export const PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE =
  "plaintext V2 agent-message response could not be restored within safe identity limits";

export class PlaintextV2AgentMessageRestoreOverflowError extends Error {
  constructor() {
    super(PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE);
    this.name = "PlaintextV2AgentMessageRestoreOverflowError";
  }
}

type RestoreOutcome = {
  value: unknown;
  changed: boolean;
  overflow: boolean;
};

type RestoreContext = {
  toolNames: ReadonlySet<string>;
  aliasedAgentMessageToolNames: ReadonlySet<string>;
  remainingIdentities: number;
};

const unchanged = (value: unknown): RestoreOutcome => ({ value, changed: false, overflow: false });

function reserveIdentities(context: RestoreContext, count: number): boolean {
  if (count > context.remainingIdentities) return false;
  context.remainingIdentities -= count;
  return true;
}

function declaredChildName(
  name: unknown,
  toolNames: ReadonlySet<string>,
  aliasedAgentMessageToolNames: ReadonlySet<string>,
  allowAgentMessageAlias: boolean,
): string | undefined {
  if (typeof name !== "string") return undefined;
  if (allowAgentMessageAlias) {
    const restoredName = PLAINTEXT_V2_AGENT_MESSAGE_TOOL_NAMES.get(name);
    if (restoredName) {
      return aliasedAgentMessageToolNames.has(restoredName) && toolNames.has(restoredName)
        ? restoredName
        : undefined;
    }
  }
  if (toolNames.has(name)) return name;
  for (const prefix of [
    PLAINTEXT_V2_COLLABORATION_NAME_PREFIX,
    PLAINTEXT_V2_COLLABORATION_DOTTED_NAME_PREFIX,
  ]) {
    if (!name.startsWith(prefix)) continue;
    const childName = name.slice(prefix.length);
    const restoredAlias = allowAgentMessageAlias
      ? PLAINTEXT_V2_AGENT_MESSAGE_TOOL_NAMES.get(childName)
      : undefined;
    if (restoredAlias && !aliasedAgentMessageToolNames.has(restoredAlias)) return undefined;
    const restoredChildName = restoredAlias ?? childName;
    return toolNames.has(restoredChildName) ? restoredChildName : undefined;
  }
  return undefined;
}

function restoreToolIdentity(
  value: unknown,
  context: RestoreContext,
  allowNamespaceDeclaration = false,
  namespaceMember = false,
): RestoreOutcome {
  if (!isPlainObject(value)) return unchanged(value);
  if (!reserveIdentities(context, 1)) return { ...unchanged(value), overflow: true };

  if (
    allowNamespaceDeclaration
    && value.type === "namespace"
    && value.name === PLAINTEXT_V2_COLLABORATION_NAMESPACE
  ) {
    if (value.tools !== undefined && !Array.isArray(value.tools)) return { ...unchanged(value), overflow: true };
    const children = restoreIdentityList(value.tools, context, false, true);
    if (children.overflow) return { ...unchanged(value), overflow: true };
    return {
      value: {
        ...value,
        name: COLLABORATION_NAMESPACE,
        ...(children.changed ? { tools: children.value } : {}),
      },
      changed: true,
      overflow: false,
    };
  }

  const identityType = value.type;
  if (
    identityType !== "function"
    && identityType !== "custom"
    && identityType !== "function_call"
    && identityType !== "custom_tool_call"
    && identityType !== "response.function_call_arguments.done"
  ) {
    return unchanged(value);
  }

  if (value.namespace !== undefined && value.namespace !== null && typeof value.namespace !== "string") {
    return { ...unchanged(value), overflow: true };
  }
  const allowAgentMessageAlias = (
    identityType === "function"
    || identityType === "function_call"
    || identityType === "response.function_call_arguments.done"
  ) && (
    value.namespace === undefined
    || value.namespace === null
    || value.namespace === PLAINTEXT_V2_COLLABORATION_NAMESPACE
  );
  if (value.namespace !== undefined && value.namespace !== null && value.namespace !== PLAINTEXT_V2_COLLABORATION_NAMESPACE) {
    return unchanged(value);
  }
  const childName = declaredChildName(
    value.name,
    context.toolNames,
    context.aliasedAgentMessageToolNames,
    allowAgentMessageAlias,
  );
  if (!childName) {
    const privateIdentity = value.namespace === PLAINTEXT_V2_COLLABORATION_NAMESPACE
      || (typeof value.name === "string" && hasPrivateToolName(value.name));
    return { ...unchanged(value), overflow: privateIdentity };
  }

  const privateIdentity = value.namespace === PLAINTEXT_V2_COLLABORATION_NAMESPACE
    || (typeof value.name === "string" && hasPrivateToolName(value.name));
  if (!privateIdentity) return unchanged(value);
  // Codex dispatches by the namespace/name pair; qualified names are literal
  // names there. Only namespace member declarations inherit their container.
  return {
    value: {
      ...value,
      name: childName,
      ...(!namespaceMember || value.namespace !== undefined ? { namespace: COLLABORATION_NAMESPACE } : {}),
    },
    changed: true,
    overflow: false,
  };
}

function restoreIdentityList(
  values: unknown,
  context: RestoreContext,
  allowNamespaceDeclaration: boolean,
  namespaceMember = false,
): RestoreOutcome {
  if (!Array.isArray(values)) return unchanged(values);
  if (values.length > context.remainingIdentities) {
    return { ...unchanged(values), overflow: true };
  }
  let restored: unknown[] | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const result = restoreToolIdentity(values[index], context, allowNamespaceDeclaration, namespaceMember);
    if (result.overflow) return { ...unchanged(values), overflow: true };
    if (!result.changed) continue;
    restored ??= values.slice();
    restored[index] = result.value;
  }
  return restored
    ? { value: restored, changed: true, overflow: false }
    : unchanged(values);
}

function restoreToolChoice(value: unknown, context: RestoreContext): RestoreOutcome {
  if (isPlainObject(value) && value.tools !== undefined && !Array.isArray(value.tools)) {
    return { ...unchanged(value), overflow: true };
  }
  const direct = restoreToolIdentity(value, context, true);
  if (direct.overflow || !isPlainObject(value) || !Array.isArray(value.tools)) return direct;
  const tools = restoreIdentityList(value.tools, context, true);
  if (tools.overflow) return { ...unchanged(value), overflow: true };
  if (!tools.changed) return direct;
  const base = direct.value as Record<string, unknown>;
  return { value: { ...base, tools: tools.value }, changed: true, overflow: false };
}

function restoreResponseSnapshot(value: unknown, context: RestoreContext): RestoreOutcome {
  if (!isPlainObject(value)) return unchanged(value);
  if ((value.output !== undefined && !Array.isArray(value.output))
    || (value.tools !== undefined && !Array.isArray(value.tools))) {
    return { ...unchanged(value), overflow: true };
  }
  const output = restoreIdentityList(value.output, context, false);
  if (output.overflow) return { ...unchanged(value), overflow: true };
  const tools = restoreIdentityList(value.tools, context, true);
  if (tools.overflow) return { ...unchanged(value), overflow: true };
  const toolChoice = restoreToolChoice(value.tool_choice, context);
  if (toolChoice.overflow) return { ...unchanged(value), overflow: true };
  if (!output.changed && !tools.changed && !toolChoice.changed) return unchanged(value);
  return {
    value: {
      ...value,
      ...(output.changed ? { output: output.value } : {}),
      ...(tools.changed ? { tools: tools.value } : {}),
      ...(toolChoice.changed ? { tool_choice: toolChoice.value } : {}),
    },
    changed: true,
    overflow: false,
  };
}

/**
 * Restore request-scoped collaboration aliases only at documented Responses identity positions.
 * Tool arguments, tool results, and extension metadata are deliberately opaque.
 */
export function restorePlaintextV2AgentMessageCalls(
  value: unknown,
  toolNames: ReadonlySet<string>,
  aliasedAgentMessageToolNames: ReadonlySet<string> = toolNames,
): { value: unknown; changed: boolean; overflowed: boolean } {
  if (toolNames.size === 0 || !isPlainObject(value)) {
    return { value, changed: false, overflowed: false };
  }
  const context: RestoreContext = {
    toolNames,
    aliasedAgentMessageToolNames,
    remainingIdentities: MAX_RESTORED_TOOL_IDENTITIES,
  };

  const rootIdentity = restoreToolIdentity(value, context);
  if (rootIdentity.overflow) return { value, changed: false, overflowed: true };
  const root = rootIdentity.value as Record<string, unknown>;
  const item = restoreToolIdentity(root.item, context);
  if (item.overflow) return { value, changed: false, overflowed: true };
  const response = restoreResponseSnapshot(root.response, context);
  if (response.overflow) return { value, changed: false, overflowed: true };
  const snapshot = restoreResponseSnapshot(root, context);
  if (snapshot.overflow) return { value, changed: false, overflowed: true };

  let restored = snapshot.value as Record<string, unknown>;
  let changed = rootIdentity.changed || snapshot.changed;
  if (item.changed) {
    restored = { ...restored, item: item.value };
    changed = true;
  }
  if (response.changed) {
    restored = { ...restored, response: response.value };
    changed = true;
  }
  return changed
    ? { value: restored, changed: true, overflowed: false }
    : { value, changed: false, overflowed: false };
}

export function restorePlaintextV2AgentMessageCallsInJsonResult(
  payload: string,
  toolNames: ReadonlySet<string>,
  aliasedAgentMessageToolNames: ReadonlySet<string> = toolNames,
): { value: string; changed: boolean; overflowed: boolean } {
  if (toolNames.size === 0 || payload === "[DONE]") {
    return { value: payload, changed: false, overflowed: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { value: payload, changed: false, overflowed: true };
  }
  if (!isPlainObject(value)) return { value: payload, changed: false, overflowed: true };
  const restored = restorePlaintextV2AgentMessageCalls(
    value,
    toolNames,
    aliasedAgentMessageToolNames,
  );
  if (restored.overflowed) return { value: payload, changed: false, overflowed: true };
  return restored.changed
    ? { value: JSON.stringify(restored.value), changed: true, overflowed: false }
    : { value: payload, changed: false, overflowed: false };
}

export function restorePlaintextV2AgentMessageCallsInJson(
  payload: string,
  toolNames: ReadonlySet<string>,
  aliasedAgentMessageToolNames: ReadonlySet<string> = toolNames,
): string {
  const restored = restorePlaintextV2AgentMessageCallsInJsonResult(
    payload,
    toolNames,
    aliasedAgentMessageToolNames,
  );
  if (restored.overflowed) throw new PlaintextV2AgentMessageRestoreOverflowError();
  return restored.value;
}

export function createPlaintextV2AgentMessageCallRestoreRewrite(
  toolNames: ReadonlySet<string>,
  aliasedAgentMessageToolNames: ReadonlySet<string> = toolNames,
): (payload: string) => string {
  type Binding = { namespace: string; name: string; keys: Set<string> };
  const bindings = new Map<string, Binding>();
  let refused = false;
  return payload => {
    if (refused) throw new PlaintextV2AgentMessageRestoreOverflowError();
    try {
      const restored = restorePlaintextV2AgentMessageCallsInJson(payload, toolNames, aliasedAgentMessageToolNames);
      if (payload === "[DONE]" || toolNames.size === 0) return restored;
      const value = JSON.parse(restored) as Record<string, unknown>;
      const bind = (item: unknown, outputIndex?: unknown): void => {
        if (!isPlainObject(item) || typeof item.name !== "string") return;
        if (item.type !== "function_call" && item.type !== "response.function_call_arguments.done") return;
        let namespace = typeof item.namespace === "string" ? item.namespace : "";
        let name = item.name;
        for (const separator of ["__", "."]) {
          const prefix = `${COLLABORATION_NAMESPACE}${separator}`;
          if (name.startsWith(prefix) && (!namespace || namespace === COLLABORATION_NAMESPACE)) {
            namespace = COLLABORATION_NAMESPACE;
            name = name.slice(prefix.length);
          }
        }
        const keys = [
          typeof item.id === "string" ? `id:${item.id}` : undefined,
          typeof item.item_id === "string" ? `id:${item.item_id}` : undefined,
          typeof item.call_id === "string" ? `call:${item.call_id}` : undefined,
          typeof outputIndex === "number" ? `index:${outputIndex}` : undefined,
        ].filter((key): key is string => key !== undefined);
        const groups = [...new Set(keys.flatMap(key => {
          const prior = bindings.get(key);
          return prior ? [prior] : [];
        }))];
        for (const group of groups) {
          if (group.name !== name || (group.namespace && namespace && group.namespace !== namespace)) {
            throw new PlaintextV2AgentMessageRestoreOverflowError();
          }
          namespace ||= group.namespace;
        }
        // All coordinates for a call share the same refined identity, including
        // coordinates omitted by this particular sparse event. Merge smaller groups
        // into the largest to bound repeated cross-coordinate refinement work.
        groups.sort((left, right) => right.keys.size - left.keys.size);
        const binding: Binding = groups[0] ?? { namespace, name, keys: new Set() };
        binding.namespace = namespace;
        for (const group of groups.slice(1)) {
          for (const key of group.keys) {
            binding.keys.add(key);
            bindings.set(key, binding);
          }
        }
        for (const key of keys) {
          if (!bindings.has(key) && bindings.size >= MAX_RESTORED_TOOL_IDENTITIES) throw new PlaintextV2AgentMessageRestoreOverflowError();
          binding.keys.add(key);
          bindings.set(key, binding);
        }
      };
      bind(value, value.output_index);
      bind(value.item, value.output_index);
      const response = isPlainObject(value.response) ? value.response : value;
      if (Array.isArray(response.output)) response.output.forEach((item, index) => bind(item, index));
      return restored;
    } catch (error) {
      refused = true;
      throw error;
    }
  };
}
