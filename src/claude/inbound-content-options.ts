import { isClaudeWebSearchToolName } from "./outbound";
import { AnthropicRequestError, isRec, type Rec } from "./inbound-records";

export function systemToInstructions(system: unknown): string | undefined {
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      if (isRec(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
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
