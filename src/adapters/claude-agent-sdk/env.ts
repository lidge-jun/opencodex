/**
 * Scoped child environment and the quiet flags for one Claude Agent SDK turn.
 *
 * Split out of `adapter.ts` because the turn runner (the Agent SDK path) owns the child process
 * now: the adapter only decides what the turn is, this module decides what it runs with.
 */
import { baseScopedEnv } from "../coding-agent/turn";
import type { ClaudeCliProfile } from "./profiles";

/**
 * Quiet the harness's own outbound traffic.
 *
 * The turn is infrastructure, not somebody's editor: nobody reads its usage metrics, its crash
 * reports describe a process the operator never launched by hand, and an auto-updater swapping the
 * binary underneath a running proxy is skew rather than a feature. The shared scoped env inherits
 * none of these keys, so these values are the ones the turn runs with.
 */
export const CLAUDE_CLI_QUIET_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
};

/**
 * Build the scoped child-process environment for one Claude Agent SDK turn.
 *
 * No credential is layered here on purpose. The harness reads the operator's own sign-in (the
 * macOS Keychain entry, or `~/.claude/.credentials.json` elsewhere), which is exactly the property
 * this provider exists for: the token never enters OpenCodex, its config, or a child environment.
 *
 * The shared base env also drops every inherited `ANTHROPIC_*` variable, which is what keeps a
 * `claude` the operator already points at this proxy from looping back into it.
 *
 * `USER` is the one inherited name added back, and it is not a credential: the harness resolves its
 * own sign-in by account name, so a scoped env without it makes a signed-in machine answer "not
 * logged in". Measured with `claude auth status` under `env -i`: `USER` alone reports
 * `loggedIn: true`, `LOGNAME` alone or neither reports `loggedIn: false`.
 *
 * The Agent SDK replaces the child environment entirely with this map (it does not merge
 * `process.env`), which is the same scoping the spawned CLI got before this row moved onto the SDK.
 */
export function buildChildEnv(_profile: ClaudeCliProfile, _apiKey: string): Record<string, string> {
  const env: Record<string, string> = {
    ...baseScopedEnv(),
    ...CLAUDE_CLI_QUIET_ENV,
  };
  const user = process.env.USER;
  if (user) env.USER = user;
  return env;
}
