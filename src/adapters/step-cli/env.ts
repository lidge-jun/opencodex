import { baseScopedEnv } from "../coding-agent/turn";
import { stepCliSessionDir } from "./profiles";

/**
 * Scoped child-process environment for one StepCode session (§六/§十四).
 *
 * `baseScopedEnv` already drops every inherited variable outside a short key allowlist, so the CLI
 * cannot be steered by a stray `STEP_*` value in the operator's shell. Two StepCode-specific rules
 * are layered on top:
 *
 * 1. `USER` is restored because StepCode resolves its own sign-in by account name. Measured with
 *    `env -i`: `USER` alone reports a signed-in machine, `LOGNAME` alone or neither does not. Without
 *    it a signed-in host answers "not logged in" and this provider has no account to spend.
 * 2. The session directory is redirected into state this proxy owns, so a proxied conversation never
 *    lands in the operator's `~/.stepcode/agent/sessions` tree.
 *
 * No credential is layered here on purpose. StepCode reads its own `auth.json`, which is the
 * property this provider exists for: the token never enters OpenCodex's config, key store, or any
 * child environment. There is deliberately no `STEPCODE_AUTH_PATH` here for the same reason — an
 * explicit auth path would be a second credential reference for this adapter to keep correct.
 */
export function buildStepCliEnv(
  openCodexHome: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { ...baseScopedEnv() };
  const user = hostEnv.USER;
  if (user) env.USER = user;
  env.STEP_CODING_AGENT_SESSION_DIR = stepCliSessionDir(openCodexHome);
  return env;
}

/**
 * Keep the operator's StepCode profile (`step_plan`, `step_plan_oversea`, …) intact.
 *
 * The profile lives in `auth.json` beside the credential and decides both the model endpoint and the
 * region. It is never overridden here: a preset that picked a region for this adapter would be a
 * second source of truth for exactly the thing the CLI already owns.
 */
export const STEP_CLI_FORBIDDEN_ENV_PREFIXES: readonly string[] = Object.freeze([
  "STEP_",
  "STEPCODE_",
  "OPENCODEX_",
]);

/** Report any env key a caller is about to pass that the scoped builder must never forward. */
export function forbiddenStepCliEnvKeys(keys: readonly string[]): string[] {
  return keys.filter(key => STEP_CLI_FORBIDDEN_ENV_PREFIXES.some(prefix => key.startsWith(prefix)));
}
