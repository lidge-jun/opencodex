import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig, type OcxUsage, type TierDecision } from "../../types";
import { collectResponsesToolGroups } from "../../responses/tool-groups";
import { isPlainObject } from "./internal";

const IMAGE_GEN_NAMESPACE = "image_gen";
const HOSTED_IMAGE_GENERATION_TOOL = "image_generation";
const IMAGE_GEN_DOTTED_PREFIX = `${IMAGE_GEN_NAMESPACE}.`;
const IMAGE_GEN_WIRE_PREFIX = `${IMAGE_GEN_NAMESPACE}__`;

/** Remove a supported client prefix before constructing the canonical image-gen wire alias. */
function imageGenLocalName(name: string): string {
  if (name.startsWith(IMAGE_GEN_DOTTED_PREFIX)) return name.slice(IMAGE_GEN_DOTTED_PREFIX.length);
  if (name.startsWith(IMAGE_GEN_WIRE_PREFIX)) return name.slice(IMAGE_GEN_WIRE_PREFIX.length);
  return name;
}

/** Build the flat public-Responses name used only on the upstream wire. */
function imageGenWireName(name: string): string {
  return namespacedToolName(IMAGE_GEN_NAMESPACE, imageGenLocalName(name));
}

/** Match client image-gen declarations across namespace, legacy dotted, and canonical wire forms. */
function isImageGenClientName(name: string): boolean {
  return name === IMAGE_GEN_NAMESPACE
    || name.startsWith(IMAGE_GEN_DOTTED_PREFIX)
    || name.startsWith(IMAGE_GEN_WIRE_PREFIX);
}

/** Identify declarations that should activate image-gen request normalization. */
function declaresImageGenClientTool(tool: unknown): boolean {
  if (!isPlainObject(tool) || typeof tool.name !== "string") return false;
  if (tool.type === "namespace") return tool.name === IMAGE_GEN_NAMESPACE;
  return isImageGenClientName(tool.name);
}

/** Rewrite client image-gen selectors to the hosted tool without widening caller restrictions. */
function preferHostedImageGenToolChoice(toolChoice: unknown): unknown {
  if (!isPlainObject(toolChoice)) return toolChoice;
  if ((toolChoice.type === "function" || toolChoice.type === "custom") && typeof toolChoice.name === "string") {
    return isImageGenClientName(toolChoice.name) ? { type: HOSTED_IMAGE_GENERATION_TOOL } : toolChoice;
  }
  if (toolChoice.type !== "allowed_tools" || !Array.isArray(toolChoice.tools)) return toolChoice;
  const hasHostedImageTool = toolChoice.tools.some(tool => isPlainObject(tool) && tool.type === HOSTED_IMAGE_GENERATION_TOOL);
  let changed = false;
  let addedHostedImageTool = false;
  const tools: unknown[] = [];
  for (const tool of toolChoice.tools) {
    const isClientImageTool = isPlainObject(tool)
      && (tool.type === "function" || tool.type === "custom")
      && typeof tool.name === "string"
      && isImageGenClientName(tool.name);
    if (!isClientImageTool) {
      tools.push(tool);
      continue;
    }
    changed = true;
    if (!hasHostedImageTool && !addedHostedImageTool) {
      tools.push({ type: HOSTED_IMAGE_GENERATION_TOOL });
      addedHostedImageTool = true;
    }
  }
  return changed ? { ...toolChoice, tools } : toolChoice;
}

/**
 * Some Responses-compatible gateways reserve the hosted image namespace even when the request
 * does not explicitly declare `image_generation`. For an explicitly configured model, remove only
 * colliding client declarations so the gateway's hosted tool can take precedence.
 */
export function preferConfiguredHostedTools(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
  selectedModelId?: string,
): unknown {
  // A virtual model's advertised id takes precedence over its resolved wire-model id.
  // Read own properties only: a routed model id of `constructor`/`toString` would
  // otherwise resolve to an inherited Object.prototype function and throw on the
  // membership test below, failing the request before it is dispatched.
  const preferenceMap = provider.modelPreferHostedTools;
  const ownPreference = (key: string | undefined): string[] | undefined => {
    if (!key || !preferenceMap || !Object.prototype.hasOwnProperty.call(preferenceMap, key)) return undefined;
    const entry = preferenceMap[key];
    return Array.isArray(entry) ? entry : undefined;
  };
  const preferredTools = ownPreference(selectedModelId) ?? ownPreference(modelId);
  if (!preferredTools?.includes(HOSTED_IMAGE_GENERATION_TOOL) || !isPlainObject(body)) return body;

  const stripGroup = (tools: unknown[]): unknown[] => {
    const filtered = tools.filter(tool => !declaresImageGenClientTool(tool));
    return filtered.length === tools.length ? tools : filtered;
  };

  let changed = false;
  let tools = body.tools;
  let strippedTopLevelImageGenTool = false;
  if (Array.isArray(body.tools)) {
    tools = stripGroup(body.tools);
    strippedTopLevelImageGenTool = tools !== body.tools;
    changed ||= strippedTopLevelImageGenTool;
  }

  let input = body.input;
  const strippedAdditionalToolsIndices = new Set<number>();
  if (Array.isArray(body.input)) {
    let nestedChanged = false;
    const mappedInput = body.input.map((item, index) => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const nestedTools = stripGroup(item.tools);
      if (nestedTools === item.tools) return item;
      strippedAdditionalToolsIndices.add(index);
      nestedChanged = true;
      return { ...item, tools: nestedTools };
    });
    if (nestedChanged) {
      input = mappedInput;
      changed = true;
    }
  }

  const hasToolChoice = Object.hasOwn(body, "tool_choice");
  const toolChoice = hasToolChoice ? preferHostedImageGenToolChoice(body.tool_choice) : body.tool_choice;
  const toolChoiceChanged = hasToolChoice && toolChoice !== body.tool_choice;
  const hasHostedImageGenTool = (toolGroup: unknown): boolean => Array.isArray(toolGroup)
    && toolGroup.some(tool => isPlainObject(tool) && tool.type === HOSTED_IMAGE_GENERATION_TOOL);
  const hasHostedImageGenDeclaration = hasHostedImageGenTool(tools)
    || (Array.isArray(input) && input.some(item => isPlainObject(item)
      && item.type === "additional_tools"
      && hasHostedImageGenTool(item.tools)));
  if ((strippedTopLevelImageGenTool || strippedAdditionalToolsIndices.size > 0) && !hasHostedImageGenDeclaration) {
    if (strippedTopLevelImageGenTool && Array.isArray(tools)) {
      tools = [...tools, { type: HOSTED_IMAGE_GENERATION_TOOL }];
    } else if (strippedAdditionalToolsIndices.size > 0 && Array.isArray(input)) {
      // Restore into the FIRST stripped container only. Tool declarations are
      // request-scoped, not container-scoped — the containers are separate carriers for
      // one tool set, so a single hosted declaration covers the request. An earlier
      // revision restored into every stripped container and put `image_generation` on
      // the wire twice; review caught it.
      const firstStripped = Math.min(...strippedAdditionalToolsIndices);
      input = input.map((item, index) => index === firstStripped
        && isPlainObject(item)
        && Array.isArray(item.tools)
        ? { ...item, tools: [...item.tools, { type: HOSTED_IMAGE_GENERATION_TOOL }] }
        : item);
    }
  }
  changed ||= toolChoiceChanged;
  if (!changed) return body;
  const next: Record<string, unknown> = {
    ...body,
    ...(Array.isArray(body.tools) ? { tools } : {}),
    ...(Array.isArray(body.input) ? { input } : {}),
  };
  if (toolChoiceChanged) next.tool_choice = toolChoice;
  return next;
}

/**
 * Lower one complete Codex image-gen namespace to public Responses function tools.
 *
 * The public API reserves the `image_gen` namespace and restricts function names to a flat safe
 * alphabet. `image_gen__<tool>` is therefore an upstream-only alias; client-facing responses are
 * restored to explicit `{ namespace: "image_gen", name: "<tool>" }` calls by the server. Only a
 * non-empty namespace containing named function tools is safe to lower. Malformed, empty, and
 * future namespace shapes stay untouched instead of silently losing client capabilities.
 */
function flattenImageGenNamespace(tool: unknown): Record<string, unknown>[] | undefined {
  if (
    !isPlainObject(tool)
    || tool.type !== "namespace"
    || tool.name !== IMAGE_GEN_NAMESPACE
    || !Array.isArray(tool.tools)
    || tool.tools.length === 0
  ) return undefined;

  for (const innerTool of tool.tools) {
    if (
      !isPlainObject(innerTool)
      || innerTool.type !== "function"
      || typeof innerTool.name !== "string"
      || innerTool.name.length === 0
    ) return undefined;
  }

  return tool.tools.map(innerTool => {
    const functionTool = innerTool as Record<string, unknown> & { name: string };
    return {
      ...functionTool,
      name: imageGenWireName(functionTool.name),
    };
  });
}

/** Convert a legacy dotted function declaration while preserving all other function metadata. */
function normalizeFlatImageGenFunction(tool: unknown): unknown {
  if (
    !isPlainObject(tool)
    || tool.type !== "function"
    || typeof tool.name !== "string"
    || !tool.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)
  ) return tool;
  return { ...tool, name: imageGenWireName(tool.name) };
}

/** Return the image-gen function name used for stable cross-container deduplication. */
function imageGenFunctionName(tool: unknown): string | undefined {
  if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
    return undefined;
  }
  return isImageGenClientName(tool.name) ? tool.name : undefined;
}

/** True only when a declaration can yield a callable upstream-safe image-gen function alias. */
function declaresUsableImageGenAlias(tool: unknown): boolean {
  if (flattenImageGenNamespace(tool)) return true;
  if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
    return false;
  }
  if (tool.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)) {
    return tool.name.length > IMAGE_GEN_DOTTED_PREFIX.length;
  }
  return tool.name.startsWith(IMAGE_GEN_WIRE_PREFIX)
    && tool.name.length > IMAGE_GEN_WIRE_PREFIX.length;
}

/** Collect client tool-choice names and the exact upstream aliases declared for them. */
function imageGenToolChoiceAliases(toolGroups: unknown[][]): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const group of toolGroups) {
    for (const tool of group) {
      const flattened = flattenImageGenNamespace(tool);
      if (flattened) {
        for (const candidate of flattened) {
          const wireName = candidate.name as string;
          aliases.set(`${IMAGE_GEN_DOTTED_PREFIX}${imageGenLocalName(wireName)}`, wireName);
          aliases.set(wireName, wireName);
        }
        continue;
      }
      if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
        continue;
      }
      if (
        tool.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)
        && tool.name.length > IMAGE_GEN_DOTTED_PREFIX.length
      ) {
        aliases.set(tool.name, imageGenWireName(tool.name));
      } else if (
        tool.name.startsWith(IMAGE_GEN_WIRE_PREFIX)
        && tool.name.length > IMAGE_GEN_WIRE_PREFIX.length
      ) {
        aliases.set(tool.name, tool.name);
      }
    }
  }

  return aliases;
}

/** Rewrite function selectors only when their corresponding declaration receives a wire alias. */
function normalizeImageGenToolChoice(
  toolChoice: unknown,
  aliases: ReadonlyMap<string, string>,
): unknown {
  if (!isPlainObject(toolChoice)) return toolChoice;

  if (toolChoice.type === "function" && typeof toolChoice.name === "string") {
    const alias = aliases.get(toolChoice.name);
    return alias && alias !== toolChoice.name ? { ...toolChoice, name: alias } : toolChoice;
  }

  if (toolChoice.type !== "allowed_tools" || !Array.isArray(toolChoice.tools)) return toolChoice;
  let changed = false;
  const tools = toolChoice.tools.map(tool => {
    if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
      return tool;
    }
    const alias = aliases.get(tool.name);
    if (!alias || alias === tool.name) return tool;
    changed = true;
    return { ...tool, name: alias };
  });
  return changed ? { ...toolChoice, tools } : toolChoice;
}

/** Identify replayed image-gen calls that require upstream wire encoding. */
function declaresImageGenFunctionCall(item: unknown): boolean {
  if (!isPlainObject(item) || item.type !== "function_call" || typeof item.name !== "string") {
    return false;
  }
  return item.namespace === IMAGE_GEN_NAMESPACE || isImageGenClientName(item.name);
}

/** Encode native or legacy replay calls to the same flat name used by tool declarations. */
function normalizeImageGenFunctionCall(item: unknown): unknown {
  if (!declaresImageGenFunctionCall(item) || !isPlainObject(item) || typeof item.name !== "string") {
    return item;
  }
  if (item.namespace === IMAGE_GEN_NAMESPACE) {
    const { namespace: _namespace, ...rest } = item;
    return { ...rest, name: imageGenWireName(item.name) };
  }
  if (item.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)) {
    return { ...item, name: imageGenWireName(item.name) };
  }
  return item;
}

/**
 * Normalize Codex's private image-gen tool declaration for API-key Responses providers.
 *
 * A complete `image_gen` namespace is flattened to safe `image_gen__<tool>` aliases even when it is
 * the only image tool in the request. Replayed client calls are encoded to the same alias, including
 * legacy dotted calls from older compatibility attempts. When a usable alias replaces a client
 * image-gen declaration, the duplicate hosted `image_generation` entry is removed. Duplicate aliases
 * are resolved in stable container order: top-level tools first, then Responses Lite
 * `additional_tools` entries.
 *
 * This function is called only on the API-key path. ChatGPT forward mode understands the private
 * namespace and must keep it. Copy-on-write preserves the original request reference when no
 * namespace is flattened, hosted tool removed, or duplicate function discarded.
 */
export function normalizeImageGenClientTools(body: unknown): unknown {
  if (!isPlainObject(body)) return body;

  const toolGroups = collectResponsesToolGroups(body);
  const hasImageGenClientTool = toolGroups.some(group => group.some(declaresImageGenClientTool))
    || (Array.isArray(body.input) && body.input.some(declaresImageGenFunctionCall));
  if (!hasImageGenClientTool) return body;
  const hasUsableImageGenAlias = toolGroups.some(group => group.some(declaresUsableImageGenAlias));
  const toolChoiceAliases = imageGenToolChoiceAliases(toolGroups);

  const seenFunctionNames = new Set<string>();
  const normalizeGroup = (tools: unknown[]): unknown[] => {
    const normalized: unknown[] = [];
    let groupChanged = false;

    for (const tool of tools) {
      if (
        hasUsableImageGenAlias
        && isPlainObject(tool)
        && tool.type === HOSTED_IMAGE_GENERATION_TOOL
      ) {
        groupChanged = true;
        continue;
      }

      const flattened = flattenImageGenNamespace(tool);
      const candidates = flattened ?? [tool];
      if (flattened) groupChanged = true;

      for (const candidate of candidates) {
        const normalizedCandidate = normalizeFlatImageGenFunction(candidate);
        if (normalizedCandidate !== candidate) groupChanged = true;
        const functionName = imageGenFunctionName(normalizedCandidate);
        if (functionName && seenFunctionNames.has(functionName)) {
          groupChanged = true;
          continue;
        }
        if (functionName) seenFunctionNames.add(functionName);
        normalized.push(normalizedCandidate);
      }
    }

    return groupChanged ? normalized : tools;
  };

  let changed = false;
  let tools = body.tools;
  if (Array.isArray(body.tools)) {
    tools = normalizeGroup(body.tools);
    changed ||= tools !== body.tools;
  }

  let input = body.input;
  if (Array.isArray(body.input)) {
    let nestedChanged = false;
    const mappedInput = body.input.map(item => {
      if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        const nestedTools = normalizeGroup(item.tools);
        if (nestedTools === item.tools) return item;
        nestedChanged = true;
        return { ...item, tools: nestedTools };
      }
      const normalizedCall = normalizeImageGenFunctionCall(item);
      if (normalizedCall !== item) nestedChanged = true;
      return normalizedCall;
    });
    if (nestedChanged) {
      input = mappedInput;
      changed = true;
    }
  }

  const toolChoice = normalizeImageGenToolChoice(body.tool_choice, toolChoiceAliases);
  changed ||= toolChoice !== body.tool_choice;

  if (!changed) return body;
  return {
    ...body,
    ...(Array.isArray(body.tools) ? { tools } : {}),
    ...(Array.isArray(body.input) ? { input } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "tool_choice") ? { tool_choice: toolChoice } : {}),
  };
}
