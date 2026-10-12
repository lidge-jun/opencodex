/**
 * Pure manual-env builder for the Claude Code page (devlog
 * 260720_claude_authmode_persist/020): extracted from ClaudeCode.tsx so the
 * copy-paste shell block is directly unit-testable (tests/gui/claude-manual-env.test.ts).
 */
import { AUTO_COMPACT_WINDOW_DEFAULT } from "./claude-code-types";

export type SidecarBackend = "openai" | "anthropic";
/** Vision override may carry "routed" (proxy-router describer, #2188). */
export type VisionOverrideBackend = SidecarBackend | "routed";
export type AnthropicInstanceId = "anthropic" | "anthropic2";
export interface AnthropicPoolOptions {
  backend?: string;
  parent?: AnthropicInstanceId;
  selected?: AnthropicInstanceId;
  resolved?: AnthropicInstanceId;
  mixed: boolean;
  available: AnthropicInstanceId[];
  code?: "anthropic_helper_unavailable";
}
export interface SidecarOverride { backend?: VisionOverrideBackend; model?: string; anthropicInstance?: AnthropicInstanceId | null }

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
  /** Absent on callers built before the field; reads as the "1m" default. */
  contextAccounting?: "1m" | "200k";
  /**
   * Accounting that produced `effectiveModelEnv`. Absent means it matches
   * `contextAccounting`, which is what a caller with only one snapshot has.
   */
  servedContextAccounting?: "1m" | "200k";
  /** Configured slots, so a 200k draft can drop automatic marks without dropping an explicit `[1m]`. */
  model?: string;
  smallFastModel?: string;
  tierModels?: { opus?: string; sonnet?: string; haiku?: string; fable?: string };
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

const ONE_M_MARKER = /\[1m\]$/i;

/** Unset tier slots the server fills only while automatic 1M marking is on. */
const NATIVE_TIER_FILL: Partial<Record<(typeof MODEL_ENV_NAMES)[number], string>> = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-1",
};

function stripOneMillionMarker(value: string): string {
  return value.replace(ONE_M_MARKER, "");
}

function configuredSlot(state: ClaudeManualEnvState, name: (typeof MODEL_ENV_NAMES)[number]): string {
  const haiku = state.tierModels?.haiku?.trim() || state.smallFastModel?.trim() || "";
  const raw = name === "ANTHROPIC_MODEL" ? state.model
    : name === "ANTHROPIC_DEFAULT_OPUS_MODEL" ? state.tierModels?.opus
    : name === "ANTHROPIC_DEFAULT_SONNET_MODEL" ? state.tierModels?.sonnet
    : name === "ANTHROPIC_DEFAULT_HAIKU_MODEL" ? haiku
    : name === "ANTHROPIC_DEFAULT_FABLE_MODEL" ? state.tierModels?.fable
    : "";
  return (raw ?? "").trim();
}

/**
 * Model exports for the pasted block. A 200k draft over a 1M server snapshot must not keep
 * automatic `[1m]` marks or native tier fills: the runtime omits both, and an explicit `[1m]`
 * already on the configured selector stays. A 1M draft over a 200k snapshot cannot re-mark
 * without the window map, so it keeps that snapshot rather than pairing a compact window
 * with unmarked ids.
 */
export function manualModelEnv(state: ClaudeManualEnvState): Record<string, string> {
  const accounting = state.contextAccounting ?? "1m";
  const served = state.servedContextAccounting ?? accounting;
  if (accounting !== "200k" || served === "200k") return state.effectiveModelEnv;
  const slotsKnown = state.model !== undefined || state.smallFastModel !== undefined || state.tierModels !== undefined;
  const out: Record<string, string> = {};
  for (const name of MODEL_ENV_NAMES) {
    const server = state.effectiveModelEnv[name];
    if (!server) continue;
    if (!slotsKnown) {
      if (NATIVE_TIER_FILL[name] === stripOneMillionMarker(server)) continue;
      out[name] = stripOneMillionMarker(server);
      continue;
    }
    const slot = configuredSlot(state, name);
    if (!slot) continue;
    out[name] = ONE_M_MARKER.test(slot) ? server : stripOneMillionMarker(server);
  }
  return out;
}

export function buildManualEnv(state: ClaudeManualEnvState): string {
  const baseUrl = `http://127.0.0.1:${state.port}`;
  // "auto" defers to the backend's resolution; an older proxy that does not send one
  // degrades to the historical subscription default rather than guessing proxy.
  const marker = state.authMode === "auto" ? (state.markerMode ?? "subscription") : state.authMode;
  const accounting = state.contextAccounting ?? "1m";
  const served = state.servedContextAccounting ?? accounting;
  // Compact window and model ids come from one accounting snapshot. A 1M draft whose
  // env was built under 200k waits for the next read rather than adding the window alone.
  const autoCompactActive = accounting !== "200k" && served !== "200k" && state.autoContext && state.maxContextTokens === null;
  const modelEnv = manualModelEnv(state);
  const modelEnvExports = MODEL_ENV_NAMES
    .filter(name => modelEnv[name])
    .map(name => `export ${name}=${modelEnv[name]}`);

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
