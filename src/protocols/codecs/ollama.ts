/** Pure Ollama native request and Chat response projections. */
type Obj = Record<string, unknown>;
export type OllamaKind = "chat" | "generate";
export const MAX_OLLAMA_TOOL_CALLS = 1_024;
type PendingCall = { id: string; name: string; group: Set<PendingCall>; matched: boolean };
export class OllamaCodecError extends Error {
  readonly status = 400;
  readonly code = "invalid_ollama_request";
  constructor(message: string) { super(message); this.name = "OllamaCodecError"; }
}
function fail(message: string): never { throw new OllamaCodecError(message); }
function object(value: unknown, label: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid ${label}`);
  return value as Obj;
}
function keys(value: Obj, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail(`Unsupported ${label} field`);
}
function string(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim())) fail(`Invalid ${label}`);
  return value;
}
function image(value: unknown): Obj {
  const data = string(value, "image", true);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail("Invalid image encoding");
  let bytes: Uint8Array;
  // The pattern above already validated the whole string; decode only the signature window.
  try { bytes = Uint8Array.from(atob(data.slice(0, 16)), c => c.charCodeAt(0)); } catch { return fail("Invalid image encoding"); }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if ((data.endsWith("==") && (alphabet.indexOf(data[data.length - 3]!) & 15) !== 0) ||
      (data.endsWith("=") && !data.endsWith("==") && (alphabet.indexOf(data[data.length - 2]!) & 3) !== 0)) fail("Invalid image encoding");
  const starts = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  const mime = starts(137,80,78,71,13,10,26,10) ? "image/png" : starts(255,216,255) ? "image/jpeg" : starts(71,73,70,56,55,97) || starts(71,73,70,56,57,97) ? "image/gif" : starts(82,73,70,70) && bytes.length >= 12 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 ? "image/webp" : undefined;
  if (!mime) fail("Unsupported image media");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } };
}
function content(text: unknown, images: unknown): unknown {
  const value = string(text, "content");
  if (images === undefined) return value;
  if (!Array.isArray(images)) fail("Invalid images");
  if (!images.length) return value;
  return [{ type: "text", text: value }, ...images.map(image)];
}
function requestTools(value: unknown): Obj[] {
  if (!Array.isArray(value)) fail("Invalid tools");
  return value.map(item => {
    const tool = object(item, "tool"); keys(tool, ["type", "function"], "tool");
    if (tool.type !== "function") fail("Unsupported tool type");
    const fn = object(tool.function, "tool function"); keys(fn, ["name", "description", "parameters"], "tool function");
    string(fn.name, "tool name", true);
    if (fn.description !== undefined) string(fn.description, "tool description");
    object(fn.parameters, "tool parameters");
    return { type: "function", function: { ...fn } };
  });
}
export function ollamaToChat(kind: OllamaKind, input: unknown): Obj {
  const body = object(input, "request");
  keys(body, kind === "chat" ? ["model", "messages", "stream", "options", "format", "tools"] : ["model", "prompt", "system", "images", "stream", "options", "format"], "request");
  const model = string(body.model, "model", true);
  if (body.stream !== undefined && typeof body.stream !== "boolean") fail("Invalid stream");
  const result: Obj = { model, stream: body.stream ?? true, messages: [] };
  const messages: Obj[] = [];
  if (kind === "generate") {
    if (body.system !== undefined) messages.push({ role: "system", content: string(body.system, "system") });
    messages.push({ role: "user", content: content(body.prompt, body.images) });
  } else {
    if (!Array.isArray(body.messages)) fail("Invalid messages");
    const pendingById = new Map<string, PendingCall>();
    const pendingByName = new Map<string, Set<PendingCall>[]>();
    let callCount = 0;
    body.messages.forEach((raw, mi) => {
      const msg = object(raw, "message");
      const role = string(msg.role, "role");
      if (!["system", "user", "assistant", "tool"].includes(role)) fail("Unsupported role");
      keys(msg, role === "user" ? ["role", "content", "images"] : role === "assistant" ? ["role", "content", "tool_calls"] : role === "tool" ? ["role", "content", "tool_name", "tool_call_id"] : ["role", "content"], "message");
      const projected: Obj = { role, content: content(msg.content, role === "user" ? msg.images : undefined) };
      if (role === "assistant" && msg.tool_calls !== undefined) {
        if (!Array.isArray(msg.tool_calls)) fail("Invalid tool calls");
        if (callCount + msg.tool_calls.length > MAX_OLLAMA_TOOL_CALLS) fail("Too many tool calls");
        callCount += msg.tool_calls.length;
        const groups = new Map<string, Set<PendingCall>>();
        projected.tool_calls = msg.tool_calls.map((rawCall, ci) => {
          // A replayed response call keeps the id this proxy returned for it; older clients send none.
          const call = object(rawCall, "tool call"); keys(call, ["id", "function"], "tool call");
          const fn = object(call.function, "tool call function"); keys(fn, ["name", "arguments"], "tool call function");
          const name = string(fn.name, "tool name", true); const args = object(fn.arguments, "tool arguments");
          const id = call.id === undefined ? `call_ollama_${mi}_${ci}` : string(call.id, "tool call id", true);
          if (pendingById.has(id)) fail("Duplicate tool call id");
          const group = groups.get(name) ?? new Set<PendingCall>(); groups.set(name, group);
          const pending: PendingCall = { id, name, group, matched: false }; group.add(pending); pendingById.set(id, pending);
          return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
        });
        for (const [name, group] of groups) {
          const named = pendingByName.get(name) ?? []; named.push(group); pendingByName.set(name, named);
        }
      }
      if (role === "tool") {
        const id = msg.tool_call_id === undefined ? undefined : string(msg.tool_call_id, "tool call id", true);
        const name = msg.tool_name === undefined ? undefined : string(msg.tool_name, "tool name", true);
        let candidate: PendingCall | undefined;
        if (id) candidate = pendingById.get(id);
        else if (name) {
          const groups = pendingByName.get(name); while (groups?.length && !groups.at(-1)!.size) groups.pop();
          const group = groups?.at(-1); if (group && group.size !== 1) fail("Ambiguous tool result");
          candidate = group?.values().next().value;
        }
        if (!candidate || candidate.matched || (name && candidate.name !== name)) fail("Unmatched tool result");
        candidate.matched = true; candidate.group.delete(candidate); projected.tool_call_id = candidate.id;
      }
      messages.push(projected);
    });
    if (body.tools !== undefined) result.tools = requestTools(body.tools);
  }
  result.messages = messages;
  if (body.options !== undefined) {
    const opts = object(body.options, "options"); keys(opts, ["temperature", "top_p", "num_predict", "stop"], "option");
    for (const key of ["temperature", "top_p", "num_predict"] as const) if (opts[key] !== undefined) {
      const v = opts[key]; if (typeof v !== "number" || !Number.isFinite(v) || (key === "num_predict" && (!Number.isSafeInteger(v) || v < 1))) fail("Invalid option");
      result[key === "num_predict" ? "max_tokens" : key] = v;
    }
    if (opts.stop !== undefined) {
      if (!Array.isArray(opts.stop) || !opts.stop.every(v => typeof v === "string")) fail("Invalid stop option");
      result.stop = opts.stop;
    }
  }
  if (body.format !== undefined) { if (body.format !== "json") fail("Unsupported format"); result.response_format = { type: "json_object" }; }
  return result;
}

function usage(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const u = value as Obj; const out: Obj = {};
  if (typeof u.prompt_tokens === "number" && Number.isSafeInteger(u.prompt_tokens) && u.prompt_tokens >= 0) out.prompt_eval_count = u.prompt_tokens;
  if (typeof u.completion_tokens === "number" && Number.isSafeInteger(u.completion_tokens) && u.completion_tokens >= 0) out.eval_count = u.completion_tokens;
  return out;
}
function finish(value: unknown): string | undefined { return value === "stop" || value === "tool_calls" || value === "length" ? value : undefined; }
function nativeError(): Obj { return { error: "Chat completion did not finish successfully" }; }
function nativeCalls(calls: unknown): Obj[] {
  if (!Array.isArray(calls)) throw new Error("Invalid Chat tool calls");
  return calls.map((raw, i) => {
    const call = object(raw, "response tool call"); const fn = object(call.function, "response tool function");
    const name = string(fn.name, "response tool name", true);
    let args: unknown; try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments; } catch { throw new Error("Invalid Chat tool arguments"); }
    object(args, "response tool arguments");
    return { id: typeof call.id === "string" && call.id ? call.id : `call_ollama_response_${i}`, function: { name, arguments: args } };
  });
}
function payload(kind: OllamaKind, text: string, calls?: Obj[]): Obj {
  return kind === "chat" ? { message: { role: "assistant", content: text, ...(calls?.length ? { tool_calls: calls } : {}) } } : { response: text };
}
export function ollamaBufferedResponse(kind: OllamaKind, model: string, input: unknown, createdAt: string): Obj {
  try {
    const body = object(input, "Chat response"); if (!Array.isArray(body.choices) || body.choices.length !== 1) return nativeError();
    const choice = object(body.choices[0], "Chat choice"); const reason = finish(choice.finish_reason); if (!reason) return nativeError();
    const msg = object(choice.message, "Chat message");
    if (msg.content != null && typeof msg.content !== "string") return nativeError();
    const calls = msg.tool_calls === undefined ? undefined : nativeCalls(msg.tool_calls);
    if (kind === "generate" && calls?.length) return nativeError();
    return { model, created_at: createdAt, ...payload(kind, (msg.content as string | null | undefined) ?? "", calls), done: true, done_reason: reason, ...usage(body.usage) };
  } catch { return nativeError(); }
}
type StreamTool = { id?: string; name: string; arguments: string };
export interface OllamaStreamState { kind: OllamaKind; model: string; createdAt: string; finishReason?: unknown; usage: Obj; tools: Map<number, StreamTool>; toolsEmitted: boolean; }
export function createOllamaStreamState(kind: OllamaKind, model: string, createdAt: string): OllamaStreamState {
  return { kind, model, createdAt, usage: {}, tools: new Map(), toolsEmitted: false };
}
/** Consume one parsed Chat chunk. The caller owns settlement and may discard these records on failure. */
export function consumeOllamaChatChunk(state: OllamaStreamState, input: unknown): Obj[] {
  const body = object(input, "Chat chunk");
  if (body.error !== undefined) throw new Error("Chat stream error");
  if (body.usage != null) state.usage = usage(body.usage);
  if (!Array.isArray(body.choices) || body.choices.length > 1) throw new Error("Invalid Chat chunk choices");
  if (!body.choices.length) return [];
  const choice = object(body.choices[0], "Chat choice"); const delta = object(choice.delta, "Chat delta");
  if (state.finishReason !== undefined) throw new Error("Chat chunk after finish");
  const records: Obj[] = [];
  if (delta.content != null) {
    const text = string(delta.content, "Chat content");
    if (text) records.push({ model: state.model, created_at: state.createdAt, ...payload(state.kind, text), done: false });
  }
  if (delta.tool_calls !== undefined) {
    if (state.kind !== "chat" || !Array.isArray(delta.tool_calls) || state.toolsEmitted) throw new Error("Invalid Chat tool delta");
    for (const raw of delta.tool_calls) {
      const call = object(raw, "tool delta"); if (!Number.isSafeInteger(call.index) || (call.index as number) < 0) throw new Error("Invalid tool index");
      const index = call.index as number; const current = state.tools.get(index) ?? { name: "", arguments: "" };
      if (call.id !== undefined) { const id = string(call.id, "tool id", true); if (current.id && current.id !== id) throw new Error("Conflicting tool id"); current.id = id; }
      if (call.function !== undefined) { const fn = object(call.function, "tool function"); if (fn.name !== undefined) current.name += string(fn.name, "tool name"); if (fn.arguments !== undefined) current.arguments += string(fn.arguments, "tool arguments"); }
      state.tools.set(index, current);
    }
  }
  if (choice.finish_reason != null) {
    if (state.finishReason !== undefined) throw new Error("Duplicate Chat finish");
    state.finishReason = choice.finish_reason;
    if (choice.finish_reason === "tool_calls" && state.tools.size) {
      const calls = [...state.tools.entries()].sort((a, b) => a[0] - b[0]).map(([index, tool]) => ({ id: tool.id ?? `call_ollama_response_${index}`, function: { name: tool.name, arguments: tool.arguments } }));
      records.push({ model: state.model, created_at: state.createdAt, ...payload(state.kind, "", nativeCalls(calls)), done: false }); state.toolsEmitted = true;
    }
  }
  return records;
}
/** Call only after the outer handler confirms successful upstream settlement. */
export function ollamaStreamTerminal(state: OllamaStreamState): Obj {
  const reason = finish(state.finishReason);
  if (!reason || (state.tools.size > 0 && !state.toolsEmitted)) return nativeError();
  return { model: state.model, created_at: state.createdAt, ...payload(state.kind, ""), done: true, done_reason: reason, ...state.usage };
}
