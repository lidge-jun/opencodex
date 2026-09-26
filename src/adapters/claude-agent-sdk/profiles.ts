import { clearCodingAgentBinaryCache, type CodingAgentProviderProfile } from "../coding-agent/profile";

/**
 * Profile for the official Claude Code CLI — Anthropic's own harness (§三十一).
 *
 * The CLI owns the account: OpenCodex stores no Claude token, reads none, and injects none, so a
 * subscription turn is spent through the harness Anthropic ships instead of a replayed Claude Code
 * identity against the Messages API. There is exactly one destination, so the profile carries the
 * single-binary shape of the shared coding-agent seam and no `tokenEnv`.
 *
 * Evidence (verified 2026-09-24 against the installed CLI 2.1.270): the full argument set built by
 * `./adapter.ts` is accepted — including `--tools ""`, `--setting-sources ""`, `--effort` and
 * `--system-prompt` — and a stream-json turn reaches the account check, ending on a terminal
 * `result` frame with `is_error: true` and "Not logged in · Please run /login" rather than on an
 * unknown option. The success-path frame shapes are the shared parser's, unchanged from the family
 * this profile joins (`../coding-agent/protocol.ts`).
 */
export interface ClaudeCliProfile extends CodingAgentProviderProfile {
  family: "claude";
}

export const CLAUDE_CLI_PROFILE: ClaudeCliProfile = {
  providerId: "claude-agent-sdk",
  family: "claude",
  // Not a vendor region switch: Claude Code has one destination, and the shared seam's region slot
  // carries the neutral value. The profile stays the single authority either way.
  region: "global",
  label: "Claude Code",
  canonicalBaseUrl: "https://api.anthropic.com",
  binaryCandidates: ["claude"],
  installHint: "npm install -g @anthropic-ai/claude-code",
  documentationUrl: "https://docs.claude.com/en/docs/claude-code/cli-reference",
};

export const CLAUDE_CLI_PROFILES: readonly ClaudeCliProfile[] = [CLAUDE_CLI_PROFILE];

/** Binary-discovery cache is shared across coding-agent families; re-exported for test isolation. */
export const clearClaudeCliBinaryCache = clearCodingAgentBinaryCache;
