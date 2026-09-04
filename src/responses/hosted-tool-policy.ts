/** Hosted tools rejected by specific native model slugs or exact provider destinations. */
const UNSUPPORTED_HOSTED_TOOLS: ReadonlyArray<{
  match: (model: string, baseUrl?: string) => boolean;
  tools: ReadonlySet<string>;
}> = [
  { match: model => model.includes("codex-spark"), tools: new Set(["image_generation", "tool_search"]) },
  {
    match: (model, baseUrl) => model === "grok-4.6"
      && baseUrl?.replace(/\/+$/, "") === "https://opencode.ai/zen/go/v1",
    tools: new Set(["web_search", "web_search_preview"]),
  },
];

/** True when forwarding this hosted tool to the model would be rejected upstream. */
export function isHostedToolUnsupportedForModel(modelId: string, tool: string, baseUrl?: string): boolean {
  return UNSUPPORTED_HOSTED_TOOLS.some(entry => entry.match(modelId, baseUrl) && entry.tools.has(tool));
}
