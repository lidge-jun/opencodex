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

/** Env vars set by agent harnesses and CI runners inside the shell they spawn. */
const AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_THREAD_ID",
  "CODEX_SHELL",
  "CODEX_CI",
  "CURSOR_TRACE_ID",
  "CURSOR_SESSION_TOKEN",
  "AIDER_CHAT",
  "REPL_ID",
  "CI",
  "GITHUB_ACTIONS",
] as const;

/**
 * True when an agent or automated runner is driving this process. Reads the
 * environment on every call so tests and long-lived processes see current state.
 */
export function isAgentDriven(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_ENV_VARS.some(name => (env[name] ?? "").trim() !== "");
}
