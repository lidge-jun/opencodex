/**
 * The Claude Code client identity opencodex presents on Anthropic account
 * endpoints (`/api/oauth/usage`, `/api/oauth/profile`, the reset-grant claim).
 *
 * Upstream gates some response blocks on this header. With `claude-cli/2.1.63` the
 * usage endpoint answers the reset-grant block with `ineligible_reason:
 * "cli_version"`; `claude-code/<ver>` is answered with `"surface"`. Only the
 * `claude-cli/<ver> (external, cli)` form of a current release is treated as the
 * Claude Code CLI surface. Bump the version together with a live GET check.
 *
 * Model access is gated on it too: Anthropic answers claude-fable-5-2 with
 * "Claude Code 2.1.280 does not support this model; version 2.1.290 or newer is required".
 * The three values below are one coherent client: Claude Code 2.1.321 sends @anthropic-ai/sdk 0.128.0 on
 * runtime v26.12.1 (mitmproxy capture in router-for-me/CLIProxyAPI#7392; the locally installed 2.1.319
 * binary carries the same SDK and runtime strings).
 */
export const CLAUDE_CLI_VERSION = "2.1.321";
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
export const CLAUDE_CLI_SDK_PACKAGE_VERSION = "0.128.0";
export const CLAUDE_CLI_RUNTIME_VERSION = "v26.12.1";
