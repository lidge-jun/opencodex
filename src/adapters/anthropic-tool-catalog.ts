import { isAllowedToolChoice, toolChoiceToolPredicate, type OcxParsedRequest } from "../types";
import { rejectsForcedToolChoice } from "./anthropic-model-contract";

/** The catalog actually advertised on the wire, independently of whether calling it is enabled. */
export function anthropicDeclaredTools(parsed: OcxParsedRequest) {
  const tools = parsed.context.tools ?? [];
  const choice = parsed.options.toolChoice;
  return isAllowedToolChoice(choice)
    || (rejectsForcedToolChoice(parsed.modelId) && typeof choice === "object" && choice !== null && "name" in choice)
    ? tools.filter(toolChoiceToolPredicate(choice, tools)) : tools;
}
