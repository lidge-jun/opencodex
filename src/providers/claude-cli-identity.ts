/**
 * The Claude Code client identity opencodex presents on Anthropic account
 * endpoints and generated OAuth Messages requests, including search and vision.
 *
 * Upstream gates some response blocks on this header. With `claude-cli/2.1.63` the
 * usage endpoint answers the reset-grant block with `ineligible_reason:
 * "cli_version"`; `claude-code/<ver>` is answered with `"surface"`. Only the
 * `claude-cli/<ver> (external, cli)` form of a current release is treated as the
 * Claude Code CLI surface. Bump the version together with a live GET check.
 * Keep the SDK and runtime profile aligned with the official CLI distribution;
 * updating an independently installed `claude` binary does not change this profile.
 * Profile source: @anthropic-ai/claude-code-win32-x64@2.1.321 (2026-11-10).
 */
export const CLAUDE_CLI_VERSION = "2.1.321";
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
export const CLAUDE_CLI_SDK_PACKAGE_VERSION = "0.128.0";
export const CLAUDE_CLI_RUNTIME_VERSION = "v26.12.1";
