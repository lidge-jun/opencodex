/**
 * Pure manual-env builder for the Claude Code page (devlog
 * 260720_claude_authmode_persist/020): extracted from ClaudeCode.tsx so the
 * copy-paste shell block is directly unit-testable (tests/claude-manual-env.test.ts).
 */
import { AUTO_COMPACT_WINDOW_DEFAULT } from "./claude-code-types";

export type SidecarBackend = "openai" | "anthropic";
/** Vision override may carry "routed" (proxy-router describer, #2188). */
export type VisionOverrideBackend = SidecarBackend | "routed";
export interface SidecarOverride { backend?: VisionOverrideBackend; model?: string }

export interface ClaudeManualEnvState {
  /**
   * The intent as stored. Under "auto" the snippet follows `markerMode`, the
   * daemon-side resolution — which cannot see a key exported only in the user's own
   * terminal, so this block is guidance, not a universal prediction.
   */
  authMode: "auto" | "subscription" | "proxy";
  /** Resolved marker decision from the backend (absent on an older proxy). */
  markerMode?: "proxy" | "subscription";
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
  // "auto" defers to the backend's resolution; an older proxy that does not send one
  // degrades to the historical subscription default rather than guessing proxy.
  const marker = state.authMode === "auto" ? (state.markerMode ?? "subscription") : state.authMode;
  const autoCompactActive = state.autoContext && state.maxContextTokens === null;
  const modelEnvExports = MODEL_ENV_NAMES
    .filter(name => state.effectiveModelEnv[name])
    .map(name => `export ${name}=${state.effectiveModelEnv[name]}`);

  return [
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    ...(marker === "proxy"
      ? ["export ANTHROPIC_AUTH_TOKEN=opencodex-proxy"]
      : ["# no ANTHROPIC_AUTH_TOKEN: your claude.ai login (and connectors) stay active"]),
    "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
    // The flag is an auth assertion in current Claude Code. It belongs only to
    // proxy mode, where the same block supplies a host-managed token. The
    // conditional form still preserves an explicit user opt-out (=0).
    ...(marker === "proxy"
      ? ['[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1']
      : []),
    // The copy a user pastes has to match what the runtime injects, or the manual path
    // compacts somewhere else entirely.
    ...(autoCompactActive ? [`export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${state.autoCompactWindow ?? AUTO_COMPACT_WINDOW_DEFAULT}`] : []),
    ...modelEnvExports,
    "claude",
  ].join("\n");
}
