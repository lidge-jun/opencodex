import { isClaudeWebSearchToolName } from "./outbound";
import { AnthropicRequestError, isRec, type Rec } from "./inbound-records";

/**
 * Claude Code opens its system prompt with a per-request billing line
 * (`x-anthropic-billing-header: cc_version=…; cc_entrypoint=…; cch=…;`) whose `cch` value
 * changes on every request. Anthropic excludes it from caching; a translated Responses
 * destination does not, so the first bytes of `instructions` — and the system-derived
 * fallback `prompt_cache_key` — rotated every turn and prefix caching never hit (#6627).
 * Native Anthropic passthrough never reaches this translation and keeps the line.
 *
 * Anchored at the prompt start without the multiline flag, like the Antigravity strip in
 * `src/adapters/google.ts`, so a mention later in the prompt is never touched.
 */
function stripClaudeBillingHeader(text: string): string {
  return text.replace(/^x-anthropic-billing-header:[^\n]*\n*/, "");
}

export function systemToInstructions(system: unknown): string | undefined {
  if (typeof system === "string") {
    const text = stripClaudeBillingHeader(system);
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(system)) {
    const parts: string[] = [];
    let first = true;
    for (const block of system) {
      if (!isRec(block) || block.type !== "text" || typeof block.text !== "string") continue;
      if (first) {
        first = false;
        // Only the first text block can carry the billing line; drop it if nothing else remains.
        const text = stripClaudeBillingHeader(block.text);
        if (text.length > 0) parts.push(text);
        continue;
      }
      parts.push(block.text);
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

export function toolsToResponses(tools: unknown): Rec[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  // The shared hosted-search lane cannot enforce these constraints on every destination or
  // sidecar backend. Omit search rather than broaden it; a duplicate declaration cannot opt out.
  // Typed originals still travel separately to an Anthropic destination.
  const restrictedSearch = tools.some(raw => isRec(raw) && typeof raw.type === "string"
    && raw.type.startsWith("web_search")
    && ["allowed_domains", "blocked_domains", "user_location"].some(key => Object.hasOwn(raw, key)));
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRec(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type.startsWith("web_search")) {
      if (!restrictedSearch) out.push({ type: "web_search" }); // hosted sidecar path
      continue;
    }
    if (typeof raw.name === "string" && raw.name.length > 0 && isRec(raw.input_schema)) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        parameters: raw.input_schema as Record<string, unknown>,
        // Anthropic opts into strict tool use explicitly, while Responses reads an
        // omitted strict as permission to normalize the schema into strict mode. That
        // turns an optional input_schema parameter into a required one and breaks the
        // call, so carry the source intent instead of the destination default. A
        // non-boolean value is not a valid Anthropic opt-in and must not become one.
        strict: typeof raw.strict === "boolean" ? raw.strict : false,
        // Anthropic restricts who may invoke a tool through allowed_callers. Nothing read it,
        // so the restriction never reached the internal tool and every destination rebuilt the
        // declaration without it while the request still succeeded (#5210).
        ...(Array.isArray(raw.allowed_callers)
          ? { allowed_callers: raw.allowed_callers.filter((c): c is string => typeof c === "string") }
          : {}),
      });
      continue;
    }
    // Other server tools (bash_*, text_editor_*, ...) have no routed equivalent: drop.
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The caller's typed Anthropic web tools (`web_search_*`, `web_fetch_*`), as declared. The
 * Responses body has no slot for them — web_search becomes the hosted sidecar tool above and
 * web_fetch is dropped — so an Anthropic destination receives them out of body, unchanged.
 */
export function declaredAnthropicServerTools(raw: unknown): Rec[] | undefined {
  if (!isRec(raw) || !Array.isArray(raw.tools)) return undefined;
  const tools = raw.tools.filter((t): t is Rec => isRec(t) && typeof t.type === "string" && /^web_(search|fetch)_\d+$/.test(t.type));
  return tools.length > 0 ? tools : undefined;
}

/** Validate original call/result order without inventing inputs or pairing a later call backwards. */
function replayableServerRun(run: readonly Rec[]): boolean {
  const pending = new Map<string, Rec>();
  const completed = new Set<string>();
  for (const block of run) {
    if (block.type === "server_tool_use") {
      const { id, name, input } = block;
      if (typeof id !== "string" || !id.startsWith("srvtoolu_") || pending.has(id) || completed.has(id)
        || (name !== "web_search" && name !== "web_fetch") || !isRec(input)) return false;
      const prototype = Object.getPrototypeOf(input);
      const required = input[name === "web_search" ? "query" : "url"];
      if ((prototype !== Object.prototype && prototype !== null)
        || typeof required !== "string" || required.trim().length === 0) return false;
      pending.set(id, block);
    } else {
      const id = block.tool_use_id;
      if (typeof id !== "string") return false;
      const call = pending.get(id);
      if (!call || block.type !== `${call.name}_tool_result`
        || (Array.isArray(block.content) && !block.content.every(h => isRec(h) && typeof h.encrypted_content === "string"))) return false;
      pending.delete(id);
      completed.add(id);
    }
  }
  return completed.size > 0 && pending.size === 0;
}

/**
 * Completed Anthropic server-tool exchanges (`server_tool_use` + `web_search_tool_result` /
 * `web_fetch_tool_result`) in the caller's assistant history. The Responses body drops them, so
 * an Anthropic destination re-inserts them out of body, keyed by the block that follows each run
 * in its message: `call:<tool_use id>`, `text:<text>`, `thinking:<signature>` or
 * `redacted:<data>`, all of which survive translation. An anchor that occurs more than once in the
 * assistant history (string content included) cannot name one owner, so its run stays dropped,
 * as it was before replay existed. A run with none, an unpaired call, a
 * non-Anthropic id, or a search hit without `encrypted_content` is not replayable and stays dropped.
 */
export function replayedAnthropicServerBlocks(raw: unknown): Map<string, Rec[]> | undefined {
  if (!isRec(raw) || !Array.isArray(raw.messages)) return undefined;
  const out = new Map<string, Rec[]>();
  const seen = new Map<string, number>();
  const count = (anchor: string) => seen.set(anchor, (seen.get(anchor) ?? 0) + 1);
  for (const message of raw.messages) {
    if (!isRec(message) || message.role !== "assistant") continue;
    if (typeof message.content === "string") count(`text:${message.content}`);
    if (!Array.isArray(message.content)) continue;
    let run: Rec[] = [];
    for (const block of message.content.filter(isRec)) {
      if (block.type === "server_tool_use" || block.type === "web_search_tool_result" || block.type === "web_fetch_tool_result") {
        // The caller's breakpoints are dropped on this lane, as for the declared tools above.
        run.push({ ...block, cache_control: undefined });
        continue;
      }
      const anchor = block.type === "tool_use" ? `call:${String(block.id)}`
        : block.type === "text" ? `text:${String(block.text)}`
        : block.type === "thinking" ? `thinking:${String(block.signature)}`
        : block.type === "redacted_thinking" ? `redacted:${String(block.data)}` : undefined;
      if (anchor) count(anchor);
      if (anchor && replayableServerRun(run)) out.set(anchor, run);
      run = [];
    }
  }
  for (const anchor of out.keys()) if ((seen.get(anchor) ?? 0) > 1) out.delete(anchor);
  return out.size > 0 ? out : undefined;
}

export function toolChoiceToResponses(choice: unknown, body: Rec): void {
  if (!isRec(choice)) return;
  if (choice.disable_parallel_tool_use === true) body.parallel_tool_calls = false;
  switch (choice.type) {
    case "auto": body.tool_choice = "auto"; break;
    case "none": body.tool_choice = "none"; break;
    case "any": body.tool_choice = "required"; break;
    case "tool":
      if (typeof choice.name !== "string" || choice.name.length === 0) {
        throw new AnthropicRequestError("tool_choice.tool requires a name");
      }
      // Anthropic represents hosted WebSearch as a named tool choice, while
      // Responses requires the choice type to match the hosted declaration.
      // Preserve forced-tool intent rather than weakening it to `auto`.
      if (isClaudeWebSearchToolName(choice.name)
        && (!Array.isArray(body.tools) || !body.tools.some(tool => isRec(tool) && tool.type === "web_search"))) {
        throw new AnthropicRequestError("Restricted web search cannot be forced on a translated route without an available search declaration");
      }
      body.tool_choice = isClaudeWebSearchToolName(choice.name)
        ? { type: "web_search" }
        : { type: "function", name: choice.name };
      break;
    default: break;
  }
}
