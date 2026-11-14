/**
 * Where a request's context window goes, per category and per turn, as numbers only.
 *
 * Read from the body as the client sent it (Responses, Anthropic Messages or Chat Completions),
 * once per request, in one pass with no serialization of anything large. The result carries no
 * text: an instruction file, a tool result or a user message contributes its size and is dropped.
 * It must never throw into the request path, so every failure is `undefined`.
 *
 * The category rules come from Magpie's prompt classifier, MIT licensed, Copyright (c) 2026
 * yetone; the full notice is in context-breakdown-classify.ts, which holds the ported markers.
 */
import {
  BreakdownAccumulator,
  IMAGE_TOKENS,
  isRec,
  str,
  tokensOfBlob,
  tokensOfJson,
  tokensOfText,
  userSays,
  type ContextBreakdownV1,
  type Rec,
} from "./context-breakdown-classify";

export type { ContextBreakdownV1 } from "./context-breakdown-classify";

export type ContextBreakdownWire = "responses" | "messages" | "chat";

export function measureContextBreakdown(body: unknown, wire: ContextBreakdownWire): ContextBreakdownV1 | undefined {
  try {
    if (!isRec(body)) return undefined;
    const acc = new BreakdownAccumulator();
    if (wire === "responses") readResponses(acc, body);
    else if (wire === "messages") readMessages(acc, body);
    else if (wire === "chat") readChat(acc, body);
    else return undefined;
    return acc.finish();
  } catch {
    return undefined;
  }
}

/** Anything that carries the breakdown for a request: the request log context. */
export interface ContextBreakdownCarrier {
  contextBreakdown?: ContextBreakdownV1;
}

/** First observer wins: a translated replay through another entry keeps the client's own reading. */
export function observeContextBreakdown(carrier: ContextBreakdownCarrier, body: unknown, wire: ContextBreakdownWire): void {
  if (carrier.contextBreakdown !== undefined) return;
  const measured = measureContextBreakdown(body, wire);
  if (measured) carrier.contextBreakdown = measured;
}

// --- Anthropic Messages ---

/** Content that is a string or a list of blocks, as blocks. */
function blocksOf(c: unknown): Rec[] {
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (!Array.isArray(c)) return [];
  return c.filter(isRec);
}

function readMessages(acc: BreakdownAccumulator, body: Rec): void {
  for (const s of blocksOf(body.system)) {
    const text = str(s.text);
    if (text.startsWith("x-anthropic-billing-header")) acc.system += tokensOfText(text);
    else if (text !== "") acc.systemText(text);
  }
  if (Array.isArray(body.tools)) for (const t of body.tools) acc.tool(tokensOfJson(t));
  if (!Array.isArray(body.messages)) return;
  for (const m of body.messages) {
    if (!isRec(m)) continue;
    const role = str(m.role);
    const blocks = blocksOf(m.content);
    if (role === "system" || role === "developer") {
      for (const x of blocks) {
        const text = str(x.text);
        if (text !== "") acc.systemText(text);
      }
      continue;
    }
    if (role === "user") {
      // a message that answers tool calls goes on with the turn; one where the user says something begins one
      const answersCalls = blocks.some(x => x.type === "tool_result");
      if (!answersCalls && blocks.some(x => x.type === "text" && userSays(str(x.text)))) acc.newTurn();
    }
    for (const x of blocks) messagesBlock(acc, role, x);
  }
}

function messagesBlock(acc: BreakdownAccumulator, role: string, x: Rec): void {
  switch (x.type) {
    case "text":
      if (role === "user") acc.userText(str(x.text));
      else acc.chat(tokensOfText(str(x.text)));
      return;
    case "thinking":
      acc.chat(tokensOfText(str(x.thinking)));
      return;
    case "redacted_thinking":
      acc.chat(Math.floor(tokensOfBlob(str(x.data)) / 4));
      return;
    case "tool_use":
    case "server_tool_use":
      acc.noteCall(str(x.id), str(x.name), x.input);
      acc.chat(tokensOfText(str(x.name)) + tokensOfJson(x.input));
      return;
    case "tool_result":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
      acc.result(str(x.tool_use_id), messagesResultTokens(acc, x.content));
      return;
    case "image":
    case "document":
      if (x.type === "document" && isRec(x.source) && x.source.type !== "base64") acc.file(tokensOfJson(x.source));
      else acc.file(IMAGE_TOKENS);
      return;
    case "compaction":
      acc.compacted(tokensOfJson(x));
      return;
    default:
      acc.chat(typeof x.text === "string" ? tokensOfText(x.text) : tokensOfJson(x));
  }
}

/** A tool result's tokens; images and documents inside it are files and are counted there. */
function messagesResultTokens(acc: BreakdownAccumulator, content: unknown): number {
  if (typeof content === "string") return tokensOfText(content);
  if (Array.isArray(content)) {
    let n = 0;
    for (const c of content) {
      if (!isRec(c)) continue;
      if (c.type === "image" || c.type === "document") acc.file(IMAGE_TOKENS);
      else n += typeof c.text === "string" ? tokensOfText(c.text) : tokensOfJson(c);
    }
    return n;
  }
  return content === undefined || content === null ? 0 : tokensOfJson(content);
}

// --- OpenAI Responses ---

const IMAGE_PART_TYPES = new Set(["input_image", "input_file", "image_url", "image", "file"]);

interface ContentPart {
  text: string;
  image: boolean;
}

/** Message content that is a string or a list of parts, as parts. */
function contentParts(c: unknown): ContentPart[] {
  if (typeof c === "string") return [{ text: c, image: false }];
  if (!Array.isArray(c)) return [];
  const out: ContentPart[] = [];
  for (const p of c) {
    if (isRec(p)) out.push({ text: str(p.text), image: typeof p.type === "string" && IMAGE_PART_TYPES.has(p.type) });
  }
  return out;
}

function readResponses(acc: BreakdownAccumulator, body: Rec): void {
  acc.held = str(body.previous_response_id) !== "";
  const instructions = str(body.instructions);
  if (instructions !== "") acc.systemText(instructions);
  if (Array.isArray(body.tools)) for (const t of body.tools) responsesTool(acc, t);
  const input = body.input;
  if (typeof input === "string") {
    acc.newTurn();
    acc.userText(input);
    return;
  }
  if (Array.isArray(input)) for (const it of input) responsesItem(acc, it);
}

/** A tool definition; a namespace of tools counts each member, Codex's own `functions` one by one. */
function responsesTool(acc: BreakdownAccumulator, t: unknown): void {
  if (!isRec(t)) return;
  const members = Array.isArray(t.tools) ? t.tools : undefined;
  if (t.type === "namespace" || (members !== undefined && members.length > 0)) {
    const name = str(t.name) || (isRec(t.function) ? str(t.function.name) : "") || str(t.type);
    if (name === "functions") {
      for (const x of members ?? []) responsesTool(acc, x);
      return;
    }
    acc.tool(tokensOfJson(t), Math.max(1, members?.length ?? 0));
    return;
  }
  acc.tool(tokensOfJson(t));
}

/** A call's arguments as the wire carries them: a JSON string, or an already parsed object. */
function argumentTokens(args: unknown): number {
  if (typeof args === "string") return tokensOfBlob(args);
  return args === undefined || args === null ? 0 : tokensOfJson(args);
}

function responsesItem(acc: BreakdownAccumulator, raw: unknown): void {
  if (!isRec(raw)) return;
  const type = str(raw.type) || (typeof raw.role === "string" ? "message" : "");
  switch (type) {
    case "additional_tools":
      if (Array.isArray(raw.tools)) for (const t of raw.tools) responsesTool(acc, t);
      return;
    case "message":
      responsesMessage(acc, str(raw.role), contentParts(raw.content));
      return;
    case "reasoning": {
      let n = 0;
      if (Array.isArray(raw.summary)) for (const s of raw.summary) if (isRec(s)) n += tokensOfText(str(s.text));
      // sealed reasoning: about three quarters of the base64 is what was sealed
      n += Math.floor((str(raw.encrypted_content).length * 3) / 4 / 4);
      acc.chat(n);
      return;
    }
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "tool_search_call": {
      const input = type === "custom_tool_call" ? raw.input : type === "local_shell_call" ? raw.action : raw.arguments;
      const name = str(raw.name);
      acc.noteCall(str(raw.call_id), name, input);
      acc.chat(tokensOfText(name) + argumentTokens(input));
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
    case "tool_search_output":
      if (type === "tool_search_output" && Array.isArray(raw.tools)) for (const t of raw.tools) responsesTool(acc, t);
      acc.result(str(raw.call_id), outputTokens(acc, raw.output));
      return;
    case "compaction":
    case "compaction_summary":
      acc.compacted(tokensOfJson(raw));
      return;
    default:
      acc.chat(tokensOfJson(raw));
  }
}

function responsesMessage(acc: BreakdownAccumulator, role: string, parts: ContentPart[]): void {
  if (role === "system" || role === "developer") {
    for (const p of parts) {
      if (p.image) acc.file(IMAGE_TOKENS);
      else if (p.text !== "") acc.systemText(p.text);
    }
    return;
  }
  if (role === "user") {
    if (parts.some(p => p.image || userSays(p.text))) acc.newTurn();
    for (const p of parts) {
      if (p.image) acc.file(IMAGE_TOKENS);
      else acc.userText(p.text);
    }
    return;
  }
  for (const p of parts) acc.chat(tokensOfText(p.text));
}

/** A tool output's tokens: a string, a list of parts (images count as files), or an object. */
function outputTokens(acc: BreakdownAccumulator, output: unknown): number {
  if (typeof output === "string") return tokensOfText(output);
  if (Array.isArray(output)) {
    let n = 0;
    for (const p of contentParts(output)) {
      if (p.image) acc.file(IMAGE_TOKENS);
      else n += tokensOfText(p.text);
    }
    return n;
  }
  return isRec(output) ? tokensOfJson(output) : 0;
}

// --- OpenAI Chat Completions ---

function readChat(acc: BreakdownAccumulator, body: Rec): void {
  if (Array.isArray(body.tools)) for (const t of body.tools) responsesTool(acc, t);
  // legacy Chat function calling: bare definitions, and one `function_call` per assistant message
  if (Array.isArray(body.functions)) for (const f of body.functions) responsesTool(acc, f);
  if (!Array.isArray(body.messages)) return;
  for (const m of body.messages) {
    if (!isRec(m)) continue;
    const role = str(m.role);
    const parts = contentParts(m.content);
    if (role === "tool" || role === "function") {
      let n = 0;
      for (const p of parts) {
        if (p.image) acc.file(IMAGE_TOKENS);
        else n += tokensOfText(p.text);
      }
      acc.result(str(m.tool_call_id), n);
      continue;
    }
    if (role === "system" || role === "developer" || role === "user") {
      responsesMessage(acc, role, parts);
      continue;
    }
    // the model's reasoning, what it said and its calls
    acc.chat(tokensOfText(str(m.reasoning_content)));
    let said = 0;
    for (const p of parts) said += tokensOfText(p.text);
    acc.chat(said);
    if (isRec(m.function_call)) {
      const name = str(m.function_call.name);
      acc.noteCall("", name, m.function_call.arguments);
      acc.chat(tokensOfText(name) + argumentTokens(m.function_call.arguments));
    }
    if (!Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      if (!isRec(c) || !isRec(c.function)) continue;
      const name = str(c.function.name);
      acc.noteCall(str(c.id), name, c.function.arguments);
      acc.chat(tokensOfText(name) + argumentTokens(c.function.arguments));
    }
  }
}
