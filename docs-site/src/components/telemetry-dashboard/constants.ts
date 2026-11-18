import type {
  HeatmapGrade,
  OutcomeClassId,
  TelemetryStatsRange,
  TokenBucketId,
} from "./types";

export const TELEMETRY_STATS_ENDPOINT = "https://telemetry.opencodex.me/v1/stats";

export const TELEMETRY_RANGES: readonly TelemetryStatsRange[] = Object.freeze([
  "7d",
  "30d",
  "90d",
  "365d",
]);

export const TELEMETRY_RANGE_DAYS: Readonly<Record<TelemetryStatsRange, number>> =
  Object.freeze({
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "365d": 365,
  });

export const DEFAULT_TELEMETRY_RANGE: TelemetryStatsRange = "30d";

export const NPM_PACKAGE_NAME = "@bitkyc08/opencodex";
export const GITHUB_REPO_SLUG = "lidge-jun/opencodex";
export const GITHUB_RELEASES_PER_PAGE = 100;
export const GITHUB_RELEASES_MAX_PAGES = 10;

export const NPM_DOWNLOADS_WEEKLY_URL =
  "https://api.npmjs.org/downloads/point/last-week/@bitkyc08/opencodex";
export const NPM_DOWNLOADS_MONTHLY_URL =
  "https://api.npmjs.org/downloads/point/last-month/@bitkyc08/opencodex";
export const NPM_DOWNLOADS_YEARLY_URL =
  "https://api.npmjs.org/downloads/point/last-year/@bitkyc08/opencodex";
export const GITHUB_RELEASES_URL =
  `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases?per_page=${GITHUB_RELEASES_PER_PAGE}`;

export const TOKSCALE_REPO_URL = "https://github.com/junhoyeo/tokscale";

/**
 * Relative docs path for the telemetry privacy guide added by stack layer 5
 * (`docs-site/src/content/docs/guides/telemetry.md`).
 */
export const TELEMETRY_GUIDE_PATH = "guides/telemetry/";

/**
 * Disjoint token mix palette adapted from junhoyeo/tokscale `TokenBreakdown.tsx` (MIT).
 */
export const TOKEN_MIX_COLORS: Readonly<Record<TokenBucketId, string>> = Object.freeze({
  input: "#56b4e9",
  cacheRead: "#cc79a7",
  cacheWrite: "#e69f00",
  output: "#009e73",
  reasoning: "#8b5cf6",
});

export const TOKEN_BUCKET_ORDER: readonly TokenBucketId[] = Object.freeze([
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
]);

export const OUTCOME_COLORS: Readonly<Record<OutcomeClassId, string>> = Object.freeze({
  completed: "#10b981",
  incomplete: "#f59e0b",
  aborted: "#6b7280",
  failed: "#ef4444",
});

/**
 * 5-grade contribution heatmap ramps adapted from junhoyeo/tokscale `src/lib/themes.ts` (MIT).
 */
export const HEATMAP_GRADE_COLORS: Readonly<{
  light: readonly [string, string, string, string, string];
  dark: readonly [string, string, string, string, string];
}> = Object.freeze({
  light: ["#eff2f5", "#79b8ff", "#388bfd", "#1f6feb", "#0d419d"],
  dark: ["#191f2b", "#1d4ed8", "#2563eb", "#4b91ff", "#8cc0ff"],
});

export function getHeatmapGradeColor(
  theme: "light" | "dark",
  grade: HeatmapGrade,
): string {
  const palette = theme === "light" ? HEATMAP_GRADE_COLORS.light : HEATMAP_GRADE_COLORS.dark;
  return palette[grade] ?? palette[0];
}

const PROVIDER_COLOR_MAP: Readonly<Record<string, string>> = Object.freeze({
  openai: "#10a37f",
  chatgpt: "#14b8a6",
  anthropic: "#d97757",
  "claude-subscription": "#e39980",
  google: "#4285f4",
  vertex: "#3b82f6",
  xai: "#1da1f2",
  deepseek: "#06b6d4",
  moonshot: "#8b5cf6",
  qwen: "#6366f1",
  zai: "#0ea5e9",
  minimax: "#ec4899",
  mistral: "#f97316",
  openrouter: "#a855f7",
  groq: "#ef4444",
  cerebras: "#eab308",
  together: "#22c55e",
  fireworks: "#f59e0b",
  cursor: "#f59e0b",
  kiro: "#14b8a6",
  copilot: "#38bdf8",
  devin: "#84cc16",
  ollama: "#94a3b8",
  lmstudio: "#64748b",
  "local-other": "#78716c",
  other: "#6b7280",
});

const MODEL_COLOR_MAP: Readonly<Record<string, string>> = Object.freeze({
  "gpt-6": "#059669",
  "gpt-5": "#10b981",
  "gpt-4": "#34d399",
  "o-series": "#6366f1",
  codex: "#f59e0b",
  "claude-opus": "#da7756",
  "claude-sonnet": "#e39980",
  "claude-haiku": "#ecb8a6",
  "gemini-3": "#2563eb",
  "gemini-2": "#60a5fa",
  grok: "#1da1f2",
  deepseek: "#06b6d4",
  qwen: "#1a73e8",
  kimi: "#a855f7",
  glm: "#0ea5e9",
  minimax: "#ec4899",
  mistral: "#f97316",
  llama: "#84cc16",
  other: "#6b7280",
});

const FALLBACK_SERIES_PALETTE = [
  "#3b82f6",
  "#10b981",
  "#d97757",
  "#8b5cf6",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
] as const;

function hashColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return FALLBACK_SERIES_PALETTE[Math.abs(hash) % FALLBACK_SERIES_PALETTE.length]!;
}

export function getProviderColor(providerKind: string): string {
  const normalized = providerKind.trim().toLowerCase();
  return PROVIDER_COLOR_MAP[normalized] ?? hashColor(normalized);
}

/**
 * Model family color resolver adapted from junhoyeo/tokscale `modelColors.ts` (MIT).
 */
export function getModelFamilyColor(modelFamily: string): string {
  const normalized = modelFamily.trim().toLowerCase();
  if (MODEL_COLOR_MAP[normalized]) {
    return MODEL_COLOR_MAP[normalized]!;
  }
  const tokens = normalized.split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (token === "opus") return MODEL_COLOR_MAP["claude-opus"]!;
    if (token === "sonnet") return MODEL_COLOR_MAP["claude-sonnet"]!;
    if (token === "haiku") return MODEL_COLOR_MAP["claude-haiku"]!;
    if (token.startsWith("claude")) return MODEL_COLOR_MAP["claude-sonnet"]!;
    if (token.startsWith("gpt")) return MODEL_COLOR_MAP["gpt-5"]!;
    if (token.startsWith("gemini")) return MODEL_COLOR_MAP["gemini-3"]!;
    if (MODEL_COLOR_MAP[token]) return MODEL_COLOR_MAP[token]!;
  }
  return hashColor(normalized);
}
