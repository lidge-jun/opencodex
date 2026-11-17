/**
 * Claude Code's identity line is a channel marker for the vendor gateways.
 *
 * Claude Code opens its system prompt with "You are Claude Code, Anthropic's official CLI for
 * Claude." WorkBuddy's gateway reads that sentence as a first-party client claim and rejects the
 * request with code 11128 ("Illegal API invocation from an unapproved channel"). CodeBuddy shares
 * the same gateway family, so the same sentence is refused there.
 *
 * The line also misdescribes the model being served: the request is routed to a DeepSeek or a
 * GLM model, not to Claude. Rewriting it to a neutral sentence keeps the request inside the
 * approved channel and keeps the prompt honest. Only this exact sentence is touched; the rest of
 * the system prompt is forwarded byte for byte.
 */

/** The identity sentence Claude Code sends verbatim, including the optional trailing period. */
const CLAUDE_CODE_IDENTITY_RE = /You are Claude Code, Anthropic[’']s official CLI for Claude\.?/gi;

/** Neutral replacement: no client brand, no model claim. */
const NEUTRAL_IDENTITY = "You are an interactive command-line coding agent.";

function scrub(text: string): string {
  // A callback avoids `$&` and friends in the replacement string.
  return text.replace(CLAUDE_CODE_IDENTITY_RE, () => NEUTRAL_IDENTITY);
}

/**
 * Rewrites the Claude Code identity sentence in system messages. Other roles are left untouched,
 * because the gateway only inspects the system prompt.
 */
export function neutralizeClaudeCodeIdentity(messages: Array<Record<string, unknown>>): void {
  for (const message of messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") {
      message.content = scrub(message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (typeof part.text === "string") part.text = scrub(part.text);
      }
    }
  }
}
