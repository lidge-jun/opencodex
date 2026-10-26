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

/**
 * Pin the combined function and server-tool catalog an ordinary request would advertise, so a
 * caller can switch the choice to "none" without changing the cached tools prefix. Mirrors the
 * adapter: hosted tools yield to a same-named function in the full catalog, and a forced-choice
 * downgrade keeps only the named tool.
 */
export function freezeAnthropicAdvertisedCatalog(parsed: OcxParsedRequest): void {
  const functions = parsed.context.tools ?? [];
  const choice = parsed.options.toolChoice;
  const namedDowngrade = rejectsForcedToolChoice(parsed.modelId)
    && typeof choice === "object" && choice !== null && "name" in choice;
  if (parsed._anthropicServerTools) {
    parsed._anthropicServerTools = parsed._anthropicServerTools.filter(tool =>
      !functions.some(f => f.name === tool.name) && (!namedDowngrade || tool.name === choice.name));
  }
  if (parsed.context.tools) parsed.context.tools = anthropicDeclaredTools(parsed);
}
