import { isPlainObject } from "./internal";

export class MuseToolChoiceCompatibilityError extends Error {
  constructor() {
    super("This tool_choice cannot be preserved for Meta Responses; use auto or none.");
    this.name = "MuseToolChoiceCompatibilityError";
  }
}

function selectorKind(choice: unknown): "auto" | "none" {
  if (choice === undefined || choice === "auto") return "auto";
  if (choice === "none") return "none";
  throw new MuseToolChoiceCompatibilityError();
}

export function normalizeMuseToolChoice(body: unknown, originalChoice: unknown): unknown {
  const originalKind = selectorKind(originalChoice);
  const effectiveKind = selectorKind(isPlainObject(body) ? body.tool_choice : undefined);
  if (originalKind !== "none" && effectiveKind !== "none") return body;
  if (!isPlainObject(body)) return body;

  const input = Array.isArray(body.input)
    ? body.input.filter(item => !isPlainObject(item) || item.type !== "additional_tools")
    : body.input;
  const {
    tool_choice: _toolChoice,
    parallel_tool_calls: _parallelToolCalls,
    ...rest
  } = body;
  return { ...rest, tools: [], ...(input !== body.input ? { input } : {}) };
}
