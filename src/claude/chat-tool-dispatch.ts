import type { ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, OcxAssistantContentPart, OcxContentPart, OcxMessage, OcxParsedRequest, OcxTool } from "../types";
import { isRec, type Rec } from "./inbound-records";
import { readClientToolDiscovery } from "./inbound-tool-loading";

/**
 * Chat-wire counterpart of the Responses `additional_tools` projection (#7452/#7453).
 *
 * A Chat Completions upstream renders the tool catalog ahead of every message, so a definition
 * that ToolSearch loads mid-conversation rewrites the prompt prefix and the provider re-reads
 * the whole history. The Chat wire has no chronological tool carrier, so on opted-in Chat routes
 * the catalog instead carries one stable dispatcher from the first request on. A loaded deferred
 * tool's definition is appended as text to the ToolSearch result that loaded it (the transcript
 * tail at the time), the model calls it through the dispatcher, and the response is rewritten
 * back to the client tool before the client sees it. History is re-encoded the same way on every
 * request, so earlier bytes never change.
 */
export const CHAT_TOOL_DISPATCH_NAME = "use_loaded_tool";

const DISPATCH_TOOL: OcxTool = {
  name: CHAT_TOOL_DISPATCH_NAME,
  description: "Call a tool that was loaded during this conversation with ToolSearch. Loaded tools and their "
    + "parameters are listed in the ToolSearch result that loaded them. Pass the loaded tool's exact name and "
    + "an arguments object that matches its parameters.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact name of a tool loaded with ToolSearch." },
      arguments: { type: "object", description: "Arguments for that tool, matching its parameters.", additionalProperties: true },
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  },
  strict: false,
};

export interface ChatToolDispatchProjection {
  parsed: OcxParsedRequest;
  /** Client tools the dispatcher currently stands in for. */
  loaded: ReadonlySet<string>;
}

/** Loaded definitions as transcript text; deterministic so the same history re-encodes identically. */
function loadedToolsText(tools: readonly OcxTool[]): string {
  const blocks = tools.map(tool => `<tool name=${JSON.stringify(tool.name)}>\n`
    + `Description: ${tool.description}\n`
    + `Parameters (JSON Schema): ${JSON.stringify(tool.parameters)}\n</tool>`);
  return `\n[These tools are now loaded. Call them through \`${CHAT_TOOL_DISPATCH_NAME}\` with `
    + `{"name": "<tool name>", "arguments": {...}}.]\n${blocks.join("\n")}\n`;
}

function appendText(content: string | OcxContentPart[], text: string): string | OcxContentPart[] {
  if (typeof content === "string") return content + text;
  return [...content, { type: "text", text }];
}

/**
 * Project an opted-in Chat request onto a stable catalog, or return null to send it unchanged.
 * Same discovery evidence as appendLoadedToolDefinitions: a successful structured ToolSearch
 * result naming a deferred tool that this request still declares.
 */
export function projectChatToolDispatch(parsed: OcxParsedRequest, raw: Rec): ChatToolDispatchProjection | null {
  const tools = parsed.context.tools;
  if (!Array.isArray(tools)) return null;

  const declared = new Map<string, OcxTool>();
  for (const tool of tools) {
    if (declared.has(tool.name)) return null;
    declared.set(tool.name, tool);
  }
  // A client tool that already uses the dispatcher name would make the mapping ambiguous.
  if (declared.has(CHAT_TOOL_DISPATCH_NAME)) return null;
  const discovery = readClientToolDiscovery(raw, name => declared.has(name));
  if (!discovery) return null;
  const { deferred, used, loadAt } = discovery;
  // The dispatcher exists only where discovery exists, and from that session's first request.
  if (!declared.has("ToolSearch") || deferred.has("ToolSearch")) return null;

  // Deferred tools stay out of the catalog unless they were already called without a discovery
  // result (eager history, or a load the client compacted away): those keep their own slot.
  const nativeUsed = new Set([...used].filter(name => !loadAt.has(name)));
  const hidden = new Set([...deferred].filter(name => declared.has(name) && !nativeUsed.has(name)));
  // Explicit forced-tool intent on a hidden tool cannot be expressed through the dispatcher.
  const choice = parsed.options.toolChoice;
  if (isRec(choice) && typeof (choice as Rec).name === "string" && hidden.has((choice as Rec).name as string)) return null;

  const additions = new Map<string, OcxTool[]>();
  for (const [name, id] of loadAt) {
    const list = additions.get(id) ?? [];
    list.push(declared.get(name)!);
    additions.set(id, list);
  }
  // Every discovery result must be present exactly once to carry its definitions.
  const resultCounts = new Map<string, number>();
  for (const message of parsed.context.messages) {
    if (message.role === "toolResult") resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) ?? 0) + 1);
  }
  for (const id of additions.keys()) if (resultCounts.get(id) !== 1) return null;

  const loaded = new Set(loadAt.keys());
  const dispatchedCalls = new Set<string>();
  const messages: OcxMessage[] = parsed.context.messages.map(message => {
    if (message.role === "assistant") {
      let changed = false;
      const content = message.content.map((part): OcxAssistantContentPart => {
        if (part.type !== "toolCall" || !loaded.has(part.name)) return part;
        changed = true;
        dispatchedCalls.add(part.id);
        return { ...part, name: CHAT_TOOL_DISPATCH_NAME, arguments: { name: part.name, arguments: part.arguments } };
      });
      return changed ? { ...message, content } : message;
    }
    if (message.role === "toolResult") {
      const added = additions.get(message.toolCallId);
      const renamed = dispatchedCalls.has(message.toolCallId);
      if (!added && !renamed) return message;
      return {
        ...message,
        ...(renamed ? { toolName: CHAT_TOOL_DISPATCH_NAME } : {}),
        ...(added ? { content: appendText(message.content, loadedToolsText(added)) } : {}),
      };
    }
    return message;
  });

  return {
    parsed: {
      ...parsed,
      context: {
        ...parsed.context,
        messages,
        tools: [...tools.filter(tool => !hidden.has(tool.name)), DISPATCH_TOOL],
      },
    },
    loaded,
  };
}

/**
 * Rewrites dispatcher calls back to the client tool they name, one adapter event at a time.
 * Only a tool in `loaded` (discovered in this request's history) is a valid target, so the
 * dispatcher can never reach a deferred tool ToolSearch has not loaded. A call whose arguments are
 * not a well-formed `{name, arguments}` pair for such a tool passes through unchanged, and the
 * client reports the unknown dispatcher call instead of the proxy guessing.
 */
function chatToolDispatchRewriter(loaded: ReadonlySet<string>) {
  let pending: { start: Extract<AdapterEvent, { type: "tool_call_start" }>; args: string } | null = null;
  const release = (): AdapterEvent[] => {
    if (!pending) return [];
    const out: AdapterEvent[] = [pending.start];
    if (pending.args.length > 0) out.push({ type: "tool_call_delta", arguments: pending.args });
    pending = null;
    return out;
  };
  const push = (event: AdapterEvent): AdapterEvent[] => {
    if (pending) {
      if (event.type === "tool_call_delta") { pending.args += event.arguments; return []; }
      if (event.type === "tool_call_end") {
        let target: { name: string; args: string } | null = null;
        if (!event.incomplete) {
          try {
            const value = JSON.parse(pending.args) as unknown;
            if (isRec(value) && typeof value.name === "string" && loaded.has(value.name)
              && (value.arguments === undefined || isRec(value.arguments))) {
              target = { name: value.name, args: JSON.stringify(value.arguments ?? {}) };
            }
          } catch { /* pass through unchanged */ }
        }
        if (!target) return [...release(), event];
        const start = { ...pending.start, name: target.name };
        pending = null;
        return [start, { type: "tool_call_delta", arguments: target.args }, event];
      }
      // Any other event closes buffering without a terminal; surface what was buffered.
      const out = release();
      return [...out, ...push(event)];
    }
    if (event.type === "tool_call_start" && event.name === CHAT_TOOL_DISPATCH_NAME) {
      pending = { start: event, args: "" };
      return [];
    }
    return [event];
  };
  return { push, flush: release };
}

/** Streaming form: rewrite dispatcher calls in an adapter stream (see chatToolDispatchRewriter). */
export async function* rewriteChatToolDispatchEvents(
  events: AsyncIterable<AdapterEvent>,
  loaded: ReadonlySet<string>,
): AsyncGenerator<AdapterEvent> {
  const rewriter = chatToolDispatchRewriter(loaded);
  for await (const event of events) yield* rewriter.push(event);
  yield* rewriter.flush();
}

/** Non-streaming form of rewriteChatToolDispatchEvents for adapter `parseResponse` results. */
export function rewriteChatToolDispatchEventList(events: readonly AdapterEvent[], loaded: ReadonlySet<string>): AdapterEvent[] {
  const rewriter = chatToolDispatchRewriter(loaded);
  return [...events.flatMap(event => rewriter.push(event)), ...rewriter.flush()];
}

/**
 * Wrap one physical openai-chat adapter: project each built request and un-project both parse
 * paths. Each build decides afresh, so a request that bails out (forced hidden tool, duplicate
 * call id) is sent unchanged and its response is not rewritten.
 */
export function applyChatToolDispatch(adapter: ProviderAdapter, discovery: Rec): void {
  const build = adapter.buildRequest.bind(adapter);
  const parseStream = adapter.parseStream.bind(adapter);
  const parseResponse = adapter.parseResponse?.bind(adapter);
  let loaded: ReadonlySet<string> | null = null;
  adapter.buildRequest = (parsed, incoming) => {
    const projection = projectChatToolDispatch(parsed, discovery);
    loaded = projection?.loaded ?? null;
    return build(projection ? projection.parsed : parsed, incoming);
  };
  adapter.parseStream = (...args) => {
    const events = parseStream(...args);
    return loaded ? rewriteChatToolDispatchEvents(events, loaded) : events;
  };
  if (parseResponse) {
    adapter.parseResponse = async (...args) => {
      const events = await parseResponse(...args);
      return loaded ? rewriteChatToolDispatchEventList(events, loaded) : events;
    };
  }
}
