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
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRec(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type.startsWith("web_search")) {
      out.push({ type: "web_search" }); // hosted sidecar path
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
      body.tool_choice = isClaudeWebSearchToolName(choice.name)
        ? { type: "web_search" }
        : { type: "function", name: choice.name };
      break;
    default: break;
  }
}
