/**
 * Pure manual-env builder for the Claude Code page (devlog
 * 260720_claude_authmode_persist/020): extracted from ClaudeCode.tsx so the
 * copy-paste shell block is directly unit-testable (tests/claude-manual-env.test.ts).
 */

export type SidecarBackend = "openai" | "anthropic";
export interface SidecarOverride { backend?: SidecarBackend; model?: string }

export interface ClaudeManualEnvState {
  authMode: "subscription" | "proxy";
  maxContextTokens: number | null;
  autoContext: boolean;
  autoCompactWindow: number | null;
  effectiveModelEnv: Record<string, string>;
  port: number;
}

export const MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

export function buildManualEnv(state: ClaudeManualEnvState): string {
  const baseUrl = `http://127.0.0.1:${state.port}`;
  const autoCompactActive = state.autoContext && state.maxContextTokens === null;
  const modelEnvExports = MODEL_ENV_NAMES
    .filter(name => state.effectiveModelEnv[name])
    .map(name => `export ${name}=${state.effectiveModelEnv[name]}`);

  return [
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    ...(state.authMode === "proxy"
      ? ["export ANTHROPIC_AUTH_TOKEN=opencodex-proxy"]
      : ["# no ANTHROPIC_AUTH_TOKEN: your claude.ai login (and connectors) stay active"]),
    "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
    // Host-managed routing guard (devlog 260720 020): CONDITIONAL so a shell where
    // the user already exported =0 keeps its opt-out even after pasting this block.
    '[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1',
    ...(autoCompactActive ? [`export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${state.autoCompactWindow ?? 350000}`] : []),
    ...modelEnvExports,
    "claude",
  ].join("\n");
}
