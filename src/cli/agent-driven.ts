/**
 * Detects whether this process was started by a coding agent rather than typed
 * by a person.
 *
 * Agent harnesses run `ocx` on the user's behalf and answer prompts from their
 * own logic, which means a consent question would be decided by the agent
 * instead of the account owner. Prompts that act on the user's identity check
 * this and defer instead: they stay silent so the question reaches the human on
 * a later hand-typed run.
 *
 * Detection is env-var based and deliberately conservative — a false positive
 * only postpones a prompt, while a false negative would let an agent answer for
 * the user.
 */

/**
 * Env vars set by agent harnesses and CI runners inside the shell they spawn.
 *
 * The list errs wide on purpose. A harness that is missed here is a harness
 * whose model answers a consent question with the user's GitHub identity, which
 * is the failure this module exists to prevent; a harness matched by mistake
 * only postpones a prompt to the user's next hand-typed run.
 */
const AGENT_ENV_VARS = [
  // Claude Code
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  // Codex CLI / App / SDK. `CODEX_HOME` is deliberately NOT here: users export it
  // from their own shell profile, so matching it would suppress the prompt for a
  // person who is sitting right there.
  "CODEX_THREAD_ID",
  "CODEX_SHELL",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  // Cursor
  "CURSOR_TRACE_ID",
  "CURSOR_SESSION_TOKEN",
  "CURSOR_AGENT",
  // Other coding agents
  "AIDER_CHAT",
  "OPENCODE_BIN_PATH",
  "GEMINI_CLI",
  // Generic runners and hosted environments that are never a person at a keyboard
  "REPL_ID",
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "CODESPACES",
] as const;

/**
 * True when an agent or automated runner is driving this process. Reads the
 * environment on every call so tests and long-lived processes see current state.
 */
export function isAgentDriven(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_ENV_VARS.some(name => (env[name] ?? "").trim() !== "");
}

/**
 * The env-var names that mark this process as agent-driven. Empty for a real
 * hand-typed run. Callers that refuse an action use it to name the reason.
 */
export function agentDrivenMarkers(env: NodeJS.ProcessEnv = process.env): string[] {
  return AGENT_ENV_VARS.filter(name => (env[name] ?? "").trim() !== "");
}
