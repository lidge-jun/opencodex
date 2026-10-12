/**
 * The Claude Code client identity opencodex presents on Anthropic account
 * endpoints (`/api/oauth/usage`, `/api/oauth/profile`, the reset-grant claim).
 *
 * Upstream gates some response blocks on this header. With `claude-cli/2.1.63` the
 * usage endpoint answers the reset-grant block with `ineligible_reason:
 * "cli_version"`; `claude-code/<ver>` is answered with `"surface"`. Only the
 * `claude-cli/<ver> (external, cli)` form of a current release is treated as the
 * Claude Code CLI surface. Bump the version together with a live GET check.
 */
export const CLAUDE_CLI_VERSION = "2.1.280";
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
