/** Pure family identity shared by existing hard policy and loaded-only advisory evidence. */
export type AnthropicModelFamily = "Fable" | "Opus" | "Sonnet";
/** Return the Anthropic model family (Fable, Opus or Sonnet) named by a model id, or undefined for other models. */
export function anthropicModelFamily(model?: string): AnthropicModelFamily | undefined {
  return /(?:^|[/])claude-fable-5(?:-|$)/i.test(model ?? "") ? "Fable"
    : /(?:^|[/])claude-opus-/i.test(model ?? "") ? "Opus"
      : /(?:^|[/])claude-sonnet-/i.test(model ?? "") ? "Sonnet" : undefined;
}
