import type { SidecarOverride } from "./claude-manual-env";

export interface MapRow {
  id: string;
  from: string;
  to: string;
}

/** Stable client key for list rows; works outside secure contexts (LAN HTTP). */
export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // crypto.randomUUID throws outside a secure context in some browsers.
    }
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ClaudeCodeState {
  enabled: boolean;
  /** Three-state intent. "auto" resolves from detected Claude auth on every launch. */
  authMode: "auto" | "subscription" | "proxy";
  /** Resolved: does the opencodex dummy marker get injected. Not a native-auth claim. */
  markerMode?: "proxy" | "subscription";
  authModeOrigin?: "manual" | "auto-present" | "auto-absent" | "auto-unknown";
  authFoundBy?: string;
  authDetectionUnknown?: boolean;
  /** The proxy requires an admission key, so a token is sent regardless of mode. */
  admissionKeyActive?: boolean;
  /** "daemon": detection cannot see a key exported only in the user's terminal. */
  detectionScope?: string;
  autoConnectSupported: boolean;
  systemEnv: boolean;
  fastMode: boolean | null;
  /** Legacy config override (no GUI control anymore) — still disables auto-context when hand-set. */
  maxContextTokens: number | null;
  autoContext: boolean;
  autoCompactWindow: number | null;
  injectAgents: boolean;
  smallFastModel: string;
  tierModels?: { haiku?: string };
  effectiveModelEnv: Record<string, string>;
  available: string[];
  aliases: { id: string; display_name: string }[];
  webSearchSidecar?: SidecarOverride;
  visionSidecar?: SidecarOverride;
  port: number;
}

/** Compact auto-summarize window labels (350k / 1M). Uses Intl for the million suffix. */
/**
 * Mirror of AUTO_COMPACT_WINDOW_DEFAULT in src/claude/context-windows.ts.
 *
 * The GUI cannot import from src/, so this is a hand-kept copy. It exists as a named
 * constant rather than a literal because the previous default lived inline in a ladder, a
 * comment, a manual-env fallback, and nine translated labels — and a default change left
 * every one of them saying 350k while the runtime injected something else.
 */
export const AUTO_COMPACT_WINDOW_DEFAULT = 829_800;

export function formatCompactWindow(value: number, locale = "en"): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const oneDecimal = millions.toFixed(1).replace(/\.0$/, "");
    // Exact million ladder values use locale-aware compact notation; off-ladder
    // values that would collide with "1M" keep a distinct k label.
    if (Number.isInteger(millions) || Number(oneDecimal) * 1_000_000 === value) {
      return new Intl.NumberFormat(locale, {
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: Number.isInteger(millions) ? 0 : 1,
      }).format(value);
    }
    return `${Math.round(value / 1_000)}k`;
  }
  return `${Math.round(value / 1_000)}k`;
}
