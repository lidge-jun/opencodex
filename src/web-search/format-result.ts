import type { SidecarOutcome } from "./executor";

/**
 * Render the sidecar outcome as a compact, model-agnostic tool_result string injected back into the
 * main (chat/anthropic) model's turn. Errors degrade gracefully — the model is told to fall back to
 * its own knowledge rather than the turn failing.
 */
export function formatWebSearchResult(query: string, outcome: SidecarOutcome): string {
  if (outcome.error) {
    return `Web search for "${query}" could not run (${outcome.error}). Answer from your own knowledge and note that it may be out of date.`;
  }
  const answer = outcome.text.trim();
  const lines: string[] = [`Web search results for "${query}":`, "", answer || "(the search returned no answer)"];
  if (outcome.sources.length > 0) {
    lines.push("", "Sources:");
    outcome.sources.forEach((s, i) => lines.push(`[${i + 1}] ${s.title ? `${s.title} — ` : ""}${s.url}`));
  }
  return lines.join("\n");
}
