import { isDeepStrictEqual } from "node:util";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxTool } from "../types";
import { parseRequest } from "../responses/parser";
import { isObj } from "../responses/parser-content";
import { encodeReasoningEnvelope } from "../responses/reasoning-envelope";
import { buildTools } from "../responses/parser-tools";
import { responsesExtraContentFromProviderMetadata } from "../responses/provider-opaque-metadata";

type Row = Record<string, unknown>;

function overlay(raw: unknown, before: unknown, after: unknown): unknown {
  if (isDeepStrictEqual(before, after)) return raw;
  if (isObj(raw) && isObj(before) && isObj(after)) {
    const result = { ...raw };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) delete result[key];
      else result[key] = overlay(raw[key], before[key], after[key]);
    }
    return result;
  }
  if (Array.isArray(raw) && Array.isArray(before) && Array.isArray(after)) {
    return after.map((value, index) => overlay(raw[index], before[index], value));
  }
  return after;
}

function content(parts: string | OcxContentPart[]): unknown {
  return typeof parts === "string" ? parts : parts.map(part => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "image") return { type: "input_image", image_url: part.imageUrl, ...(part.detail ? { detail: part.detail } : {}) };
    return { type: "input_video", video_url: part.videoUrl };
  });
}

/** Project canonical messages onto Responses items; raw counterparts are retained below. */
function input(messages: OcxMessage[]): Row[] {
  return messages.flatMap((message): Row[] => {
    if (message.role === "toolResult") {
      return [{ type: "function_call_output", call_id: message.toolCallId, output: content(message.content) }];
    }
    if (message.role !== "assistant") return [{ role: message.role, content: content(message.content) }];
    const rows: Row[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        const last = rows.at(-1);
        const block = { type: "output_text", text: part.text };
        if (last?.role === "assistant") (last.content as unknown[]).push(block);
        else rows.push({ role: "assistant", content: [block], ...(message.phase ? { phase: message.phase } : {}) });
      } else if (part.type === "toolCall") {
        rows.push(part.customWireName
          ? { type: "custom_tool_call", call_id: part.id, name: part.customWireName, input: part.arguments.input ?? "" }
          : { type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments),
            ...(part.namespace ? { namespace: part.namespace } : {}),
            ...responsesExtraContentFromProviderMetadata(part.providerMetadata) });
      } else {
        rows.push({ type: "reasoning", summary: [{ type: "summary_text", text: part.thinking }],
          ...(part.itemId ? { id: part.itemId } : {}),
          ...(part.signature || part.redacted ? { encrypted_content: encodeReasoningEnvelope({ sig: part.signature, red: part.redacted, txt: part.thinking }) } : {}) });
      }
    }
    return rows;
  });
}

/** Preserve raw items whose canonical projection survived, including opaque native fields. */
function transformedInput(raw: Row, before: OcxParsedRequest, after: OcxParsedRequest): unknown[] {
  const source = typeof raw.input === "string" ? [{ role: "user", content: raw.input }] : Array.isArray(raw.input) ? raw.input : [];
  const previous = input(before.context.messages);
  const transformed = input(after.context.messages);
  if (isDeepStrictEqual(transformed.slice(0, previous.length), previous)) {
    return [...source, ...transformed.slice(previous.length)];
  }
  const pools = new Map<string, Array<{ rows: unknown[]; prefix: unknown[] }>>();
  let pending: unknown[] = [];
  for (let index = 0; index < source.length; index++) {
    const rows = [source[index]];
    if (isObj(source[index]) && source[index].type === "reasoning") {
      while (isObj(source[index + 1]) && source[index + 1].type === "reasoning") rows.push(source[++index]);
    }
    const projected = input(parseRequest({ model: before.modelId, input: [...rows, { role: "assistant", content: [] }] }).context.messages);
    // A raw item may encode several canonical items (e.g. a native assistant turn).
    // Keep it as a unit, rather than duplicating its provider-private fields.
    const key = JSON.stringify(projected);
    if (!projected.length) { pending.push(...rows); continue; }
    const entries = pools.get(key) ?? [];
    entries.push({ rows, prefix: pending });
    pools.set(key, entries);
    pending = [];
  }
  const result: unknown[] = [];
  const remainingMatches = new Map<string, number>();
  for (const row of transformed) {
    const key = JSON.stringify([row]);
    remainingMatches.set(key, (remainingMatches.get(key) ?? 0) + 1);
  }
  const lengths = [...new Set([...pools.keys()].map(key => (JSON.parse(key) as unknown[]).length))].sort((a, b) => b - a);
  for (let index = 0; index < transformed.length;) {
    let matched = false;
    for (const length of lengths) {
      const retained = pools.get(JSON.stringify(transformed.slice(index, index + length)))?.shift();
      if (!retained) continue;
      result.push(...retained.prefix, ...retained.rows);
      for (const row of transformed.slice(index, index + length)) {
        const key = JSON.stringify([row]);
        remainingMatches.set(key, (remainingMatches.get(key) ?? 0) - 1);
      }
      index += length;
      matched = true;
      break;
    }
    if (!matched) {
      const old = previous[index];
      const next = transformed[index]!;
      const oldKey = JSON.stringify([old]);
      const reusable = old && old.role === next.role && old.type === next.type
        && (pools.get(oldKey)?.length ?? 0) > (remainingMatches.get(oldKey) ?? 0)
        ? pools.get(oldKey)?.shift() : undefined;
      if (reusable) result.push(...reusable.prefix, ...(reusable.rows.length === 1 ? [overlay(reusable.rows[0], old, next)] : [next]));
      else result.push(next);
      const nextKey = JSON.stringify([next]);
      remainingMatches.set(nextKey, (remainingMatches.get(nextKey) ?? 0) - 1);
      index++;
    }
  }
  // Unrepresented native items (encrypted reasoning, hosted calls, extensions) must not
  // disappear merely because an adjacent ordinary message was replaced or removed.
  for (const entries of pools.values()) for (const entry of entries) result.push(...entry.prefix);
  result.push(...pending);
  return result;
}

function toolIdentity(tool: OcxTool): string {
  return JSON.stringify([tool.namespace ?? "", tool.name]);
}

function toolRow(tool: OcxTool): Row {
  if (tool.freeform) return { type: "custom", name: tool.name, description: tool.description };
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}) };
}

/** Retain hosted tools, namespace envelopes, grammar definitions and untouched tool fields. */
function transformedTools(raw: unknown, tools: OcxTool[]): unknown[] {
  const remaining = new Map(tools.map(tool => [toolIdentity(tool), tool]));
  const visit = (rows: unknown[], namespace?: string): unknown[] => rows.flatMap(row => {
    if (!isObj(row)) return [row];
    if (row.type === "namespace" && Array.isArray(row.tools)) {
      const children = visit(row.tools, row.name === "functions" ? undefined : String(row.name));
      return children.length ? [{ ...row, tools: children }] : [];
    }
    const original = buildTools([row])?.[0];
    if (!original) return [row];
    if (namespace) original.namespace = namespace;
    const identity = toolIdentity(original);
    const changed = remaining.get(identity);
    if (!changed) return [];
    remaining.delete(identity);
    if (isDeepStrictEqual(original, changed)) return [row];
    return [overlay(row, toolRow(original), toolRow(changed))];
  });
  const result = visit(Array.isArray(raw) ? raw : []);
  for (const tool of remaining.values()) {
    const row = toolRow(tool);
    if (tool.namespace) {
      const group = result.find(entry => isObj(entry) && entry.type === "namespace" && entry.name === tool.namespace) as Row | undefined;
      if (group && Array.isArray(group.tools)) group.tools.push(row);
      else result.push({ type: "namespace", name: tool.namespace, tools: [row] });
    } else result.push(row);
  }
  return result;
}

/** Synchronize only fields changed by hooks; a no-op never round-trips the native wire. */
export function syncTransformedResponsesBody(before: OcxParsedRequest, after: OcxParsedRequest): void {
  if (!isObj(before._rawBody)) return;
  const raw = isObj(after._rawBody) ? after._rawBody : before._rawBody;
  const next = { ...raw };
  const assign = (key: string, value: unknown) => {
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  if (!isDeepStrictEqual(before.context.messages, after.context.messages)) next.input = transformedInput(raw, before, after);
  if (!isDeepStrictEqual(before.context.tools, after.context.tools)) next.tools = transformedTools(raw.tools, after.context.tools ?? []);
  if (!isDeepStrictEqual(before.context.systemPrompt, after.context.systemPrompt)) {
    assign("instructions", after.context.systemPrompt?.join("\n\n"));
    if (Array.isArray(next.input)) next.input = next.input.filter(row => !isObj(row) || row.role !== "system");
  }
  for (const [canonical, wire] of [["modelId", "model"], ["stream", "stream"], ["previousResponseId", "previous_response_id"]] as const) {
    if (!isDeepStrictEqual(before[canonical], after[canonical])) assign(wire, after[canonical]);
  }
  for (const [canonical, wire] of [
    ["maxOutputTokens", "max_output_tokens"], ["temperature", "temperature"], ["topP", "top_p"],
    ["stopSequences", "stop"], ["parallelToolCalls", "parallel_tool_calls"], ["serviceTier", "service_tier"],
    ["presencePenalty", "presence_penalty"], ["frequencyPenalty", "frequency_penalty"], ["promptCacheKey", "prompt_cache_key"],
  ] as const) {
    if (!isDeepStrictEqual(before.options[canonical], after.options[canonical])) assign(wire, after.options[canonical]);
  }
  if (!isDeepStrictEqual(before.options.reasoning, after.options.reasoning)) {
    next.reasoning = { ...(isObj(raw.reasoning) ? raw.reasoning : {}), effort: after.options.reasoning };
  }
  if (before.options.hideThinkingSummary !== after.options.hideThinkingSummary) {
    next.reasoning = { ...(isObj(next.reasoning) ? next.reasoning : {}), summary: after.options.hideThinkingSummary ? "none" : "auto" };
  }
  if (!isDeepStrictEqual(before.options.textFormat, after.options.textFormat)) {
    next.text = { ...(isObj(raw.text) ? raw.text : {}), format: after.options.textFormat };
    after._structuredOutput = after.options.textFormat !== undefined;
  }
  if (!isDeepStrictEqual(before.options.toolChoice, after.options.toolChoice)) {
    const choice = after.options.toolChoice;
    assign("tool_choice", typeof choice === "object"
      ? "name" in choice ? { type: "function", name: choice.name }
        : { type: "allowed_tools", mode: choice.mode, tools: choice.allowedTools.map(name => ({ type: "function", name })) }
      : choice);
  }
  after._rawBody = next;
}
