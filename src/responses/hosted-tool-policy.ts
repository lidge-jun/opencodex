/** Hosted tools rejected by specific native model slugs. */
const UNSUPPORTED_HOSTED_TOOLS: ReadonlyArray<{ match: (model: string) => boolean; tools: ReadonlySet<string> }> = [
  { match: model => model.includes("codex-spark"), tools: new Set(["image_generation", "tool_search"]) },
];

/** True when forwarding this hosted tool to the model would be rejected upstream. */
export function isHostedToolUnsupportedForModel(modelId: string, tool: string): boolean {
  return UNSUPPORTED_HOSTED_TOOLS.some(entry => entry.match(modelId) && entry.tools.has(tool));
}
