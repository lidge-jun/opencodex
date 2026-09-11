import type { OcxParsedRequest, OcxTool } from "../../types";
import type { SsePayloadRewrite } from "../sse-payload-rewrite";

const MIRROR_NAMESPACE = "ocx_agents";
const NATIVE_NAMESPACE = "collaboration";
const MIRRORED_NAMES = new Set(["spawn_agent", "send_message", "followup_task"]);
const GUIDANCE = "Use this routed-child mirror for collaboration operations.";
const MAX_SSE_BINDINGS = 128;
const injectedGroups = new WeakSet<object>();

type RecordValue = Record<string, unknown>;

export interface V2RoutedDelegationBridgeContext {
  readonly names: ReadonlySet<string>;
  /** Request snapshot taken before mirror injection, for continuation-cache persistence. */
  readonly requestStateBody: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rawToolLists(body: unknown, replayPrefixLength: number): unknown[][] {
  if (!isRecord(body)) return [];
  const lists: unknown[][] = [];
  if (Array.isArray(body.tools)) lists.push(body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input.slice(Math.max(0, Math.min(replayPrefixLength, body.input.length)))) {
      if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) lists.push(item.tools);
    }
  }
  return lists;
}

function requestStateBody(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const cloneTools = (tools: unknown[]) => tools.map(tool => (
    isRecord(tool) && tool.type === "namespace" && Array.isArray(tool.tools)
      ? { ...tool, tools: [...tool.tools] }
      : tool
  ));
  if (!Array.isArray(body.tools) && !Array.isArray(body.input)) return body;
  // Only tool catalogs are mutated below. Clone that narrow path so the continuation
  // cache retains the caller's catalog without copying unrelated context.
  return {
    ...body,
    ...(Array.isArray(body.tools) ? { tools: cloneTools(body.tools) } : {}),
    ...(Array.isArray(body.input) ? { input: body.input.map(item => (
      isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)
        ? { ...item, tools: cloneTools(item.tools) }
        : item
    )) } : {}),
  };
}

function mirrorTool(tool: RecordValue): RecordValue {
  const parameters = isRecord(tool.parameters) ? tool.parameters : undefined;
  const properties = isRecord(parameters?.properties) ? parameters.properties : undefined;
  const message = isRecord(properties?.message) ? properties.message : undefined;
  const { encrypted: _, ...plaintextMessage } = message ?? {};
  return {
    ...tool,
    description: `${GUIDANCE} ${tool.name}.`,
    ...(message && Object.hasOwn(message, "encrypted") ? {
      parameters: { ...parameters, properties: { ...properties, message: plaintextMessage } },
    } : {}),
  };
}

function mirrorChildren(group: RecordValue): RecordValue[] {
  if (!Array.isArray(group.tools)) return [];
  return group.tools.filter((tool): tool is RecordValue => (
    isRecord(tool) && tool.type === "function" && typeof tool.name === "string" && MIRRORED_NAMES.has(tool.name)
  )).map(mirrorTool);
}

function mirrorGroup(group: RecordValue): RecordValue {
  return { type: "namespace", name: MIRROR_NAMESPACE, description: GUIDANCE, tools: mirrorChildren(group) };
}

/**
 * Add request-local plaintext collaboration mirrors to raw and parsed Responses catalogs.
 * The caller has already proved this request is eligible; this helper owns no routing policy.
 */
export function injectV2RoutedDelegationBridge(
  parsed: OcxParsedRequest,
): V2RoutedDelegationBridgeContext | undefined {
  const stateBody = requestStateBody(parsed._rawBody);
  const lists = rawToolLists(parsed._rawBody, parsed._replayPrefixLen ?? 0);
  const nativeGroups: Array<{ list: unknown[]; index: number; group: RecordValue }> = [];
  const existing: Array<{ list: unknown[]; index: number; group: RecordValue }> = [];
  for (const list of lists) {
    list.forEach((tool, index) => {
      if (!isRecord(tool) || tool.type !== "namespace") return;
      if (tool.name === NATIVE_NAMESPACE) nativeGroups.push({ list, index, group: tool });
      if (tool.name === MIRROR_NAMESPACE) existing.push({ list, index, group: tool });
    });
  }
  if (nativeGroups.length === 0) return undefined;

  const names = new Set<string>();
  for (const { group } of nativeGroups) {
    for (const child of mirrorChildren(group)) names.add(child.name as string);
  }
  for (const { group } of existing) {
    for (const child of mirrorChildren(group)) names.add(child.name as string);
  }
  if (names.size === 0) return undefined;

  const expected = nativeGroups.map(({ list, index, group }) => ({ list, index: index + 1, group: mirrorGroup(group) }));
  const idempotent = existing.length === nativeGroups.length && existing.every(({ list, index, group }) => (
    injectedGroups.has(group)
    && nativeGroups.some(native => native.list === list && native.index + 1 === index)
  ));
  if (existing.length > 0 && !idempotent) {
    throw new Error("v2 routed delegation bridge namespace collision");
  }
  if (!idempotent) {
    for (const { list, index, group } of [...expected].reverse()) {
      injectedGroups.add(group);
      list.splice(index, 0, group);
    }
  }

  const mirrorTools: OcxTool[] = [];
  for (const name of names) {
    const source = parsed.context.tools?.find(tool => tool.namespace === NATIVE_NAMESPACE && tool.name === name);
    if (source) {
      mirrorTools.push({ ...mirrorTool(source as unknown as RecordValue), namespace: MIRROR_NAMESPACE } as OcxTool);
      continue;
    }
    const raw = nativeGroups.flatMap(entry => mirrorChildren(entry.group)).find(tool => tool.name === name);
    mirrorTools.push({
      name,
      namespace: MIRROR_NAMESPACE,
      description: `${GUIDANCE} ${name}.`,
      parameters: isRecord(raw?.parameters) ? raw.parameters : {},
    });
  }
  for (const { group } of nativeGroups) {
    if (Array.isArray(group.tools)) group.tools = group.tools.filter(tool => (
      !isRecord(tool) || typeof tool.name !== "string" || !MIRRORED_NAMES.has(tool.name)
    ));
  }
  if (mirrorTools.length > 0) {
    parsed.context.tools = (parsed.context.tools ?? []).filter(tool => (
      tool.namespace !== NATIVE_NAMESPACE || !MIRRORED_NAMES.has(tool.name)
    ));
    const present = new Set((parsed.context.tools ?? [])
      .filter(tool => tool.namespace === MIRROR_NAMESPACE)
      .map(tool => tool.name));
    if (mirrorTools.some(tool => !present.has(tool.name))) {
      parsed.context.tools = [...(parsed.context.tools ?? []), ...mirrorTools.filter(tool => !present.has(tool.name))];
    }
  }
  return names.size > 0 ? { names, requestStateBody: stateBody } : undefined;
}

function rewriteValue(
  value: unknown,
  active: V2RoutedDelegationBridgeContext,
  authorizedIds?: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(entry => {
      const rewritten = rewriteValue(entry, active, authorizedIds);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const entries = Object.entries(value).map(([key, entry]) => {
    const rewritten = rewriteValue(entry, active, authorizedIds);
    changed ||= rewritten.changed;
    return [key, rewritten.value];
  });
  const next: RecordValue = Object.fromEntries(entries);
  const armed =
    value.type === "function_call"
    && value.namespace === MIRROR_NAMESPACE
    && typeof value.name === "string"
    && active.names.has(value.name);
  if (armed && authorizedIds !== undefined) {
    if (typeof value.id !== "string" || !authorizedIds.has(value.id)) {
      const capped = authorizedIds.size >= MAX_SSE_BINDINGS;
      throw Object.assign(new Error(capped
        ? `v2 routed delegation bridge exceeded ${MAX_SSE_BINDINGS} SSE call bindings`
        : "v2 routed delegation bridge received an unbound SSE call"), {
        ...(capped ? { code: "translation_buffer_limit" } : {}),
      });
    }
  }
  if (armed) {
    next.namespace = NATIVE_NAMESPACE;
    next.encrypted_function_args = [];
    changed = true;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
}

/** Normalize only mirror calls armed by this request in a complete JSON response. */
export function rewriteV2RoutedDelegationCallsInJson(
  json: string,
  active: V2RoutedDelegationBridgeContext | undefined,
): string {
  if (!active || active.names.size === 0) return json;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return json; }
  const rewritten = rewriteValue(parsed, active);
  return rewritten.changed ? JSON.stringify(rewritten.value) : json;
}

/** Stateful payload rewrite for SSE; item ids bind later argument events to their mirror call. */
export function createV2RoutedDelegationSseRewrite(
  active: V2RoutedDelegationBridgeContext | undefined,
): SsePayloadRewrite | undefined {
  if (!active || active.names.size === 0) return undefined;
  const admittedIds = new Set<string>();
  const openArgumentIds = new Set<string>();
  const bind = (itemId: unknown): void => {
    if (typeof itemId !== "string" || itemId.trim().length === 0) return;
    if (admittedIds.has(itemId)) return;
    if (admittedIds.size >= MAX_SSE_BINDINGS) {
      throw Object.assign(
        new Error(`v2 routed delegation bridge exceeded ${MAX_SSE_BINDINGS} SSE call bindings`),
        { code: "translation_buffer_limit" },
      );
    }
    admittedIds.add(itemId);
    openArgumentIds.add(itemId);
  };
  return payload => {
    let event: unknown;
    try { event = JSON.parse(payload); } catch { return payload; }
    if (!isRecord(event)) return payload;
    const type = event.type;
    const item = isRecord(event.item) ? event.item : undefined;
    const armed = !!item && item.type === "function_call" && item.namespace === MIRROR_NAMESPACE
      && typeof item.name === "string" && active.names.has(item.name);
    const added = type === "response.output_item.added";
    const itemDone = type === "response.output_item.done";
    if (added && armed) bind(item?.id);
    const admittedSnapshot = itemDone && armed && typeof item?.id === "string" && admittedIds.has(item.id);
    const argumentEvent = type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done";
    const matchedArgument = argumentEvent && typeof event.item_id === "string" && openArgumentIds.has(event.item_id);
    const failedTerminal = type === "response.failed" || type === "response.incomplete";
    const rewritten = rewriteValue(event, active, admittedIds);
    if (type === "response.function_call_arguments.done" && matchedArgument) openArgumentIds.delete(event.item_id as string);
    if (itemDone && admittedSnapshot) openArgumentIds.delete(item!.id as string);
    if (type === "response.completed" || failedTerminal) {
      admittedIds.clear();
      openArgumentIds.clear();
    }
    if (matchedArgument) {
      const next = rewritten.changed && isRecord(rewritten.value) ? rewritten.value : { ...event };
      next.encrypted_function_args = [];
      return JSON.stringify(next);
    }
    return rewritten.changed ? JSON.stringify(rewritten.value) : payload;
  };
}
