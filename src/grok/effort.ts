/**
 * Grok Build's accepted thinking-intensity rungs for a managed `[model.*]` table.
 *
 * Official settings reference documents the two scalars (`supports_reasoning_effort`,
 * `reasoning_effort`). The picker menu is the working `[[model.<id>.reasoning_efforts]]`
 * shape (id / value / label / description / default). Model-specific menus may include
 * `none` and `minimal`; Codex-only `ultra` sits outside Grok's accepted set. Omitting it
 * keeps every generated picker option executable and preserves the effort menu.
 */
export const GROK_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type GrokReasoningEffort = typeof GROK_REASONING_EFFORTS[number];

const GROK_REASONING_SET = new Set<string>(GROK_REASONING_EFFORTS);

/** Picker copy proven in a live `~/.grok/config.toml` `[[model.*.reasoning_efforts]]` menu. */
const GROK_EFFORT_OPTIONS: Record<GrokReasoningEffort, { label: string; description: string }> = {
  none: { label: "None", description: "No reasoning" },
  minimal: { label: "Minimal", description: "Minimal reasoning" },
  low: { label: "Low", description: "Quick, fast implementations" },
  medium: { label: "Medium", description: "Balanced effort" },
  high: { label: "High", description: "Highest quality with extensive reasoning" },
  xhigh: { label: "XHigh", description: "Extra high reasoning effort" },
  max: { label: "Max", description: "Maximum reasoning effort" },
};

export function isGrokReasoningEffort(effort: string): effort is GrokReasoningEffort {
  return GROK_REASONING_SET.has(effort);
}

/** Keep catalog order; drop Grok-invalid rungs such as `ultra` and duplicates. */
export function sanitizeGrokReasoningEfforts(efforts: readonly string[] | undefined): GrokReasoningEffort[] {
  if (!efforts || efforts.length === 0) return [];
  const seen = new Set<GrokReasoningEffort>();
  const out: GrokReasoningEffort[] = [];
  for (const effort of efforts) {
    if (!isGrokReasoningEffort(effort) || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out;
}

/**
 * Same fallback as the raw `GET /v1/models` Grok advertisement: configured default
 * when it is on the (already sanitized) ladder, then medium, then high, then first.
 */
export function grokDefaultReasoningEffort(
  efforts: readonly string[],
  configuredDefault?: string,
): string | undefined {
  if (efforts.length === 0) return undefined;
  if (configuredDefault && efforts.includes(configuredDefault)) {
    return configuredDefault;
  }
  if (efforts.includes("medium")) return "medium";
  if (efforts.includes("high")) return "high";
  return efforts[0];
}

export function grokReasoningEffortOption(effort: GrokReasoningEffort, isDefault: boolean): {
  id: GrokReasoningEffort;
  value: GrokReasoningEffort;
  label: string;
  description: string;
  default: boolean;
} {
  const meta = GROK_EFFORT_OPTIONS[effort];
  return {
    id: effort,
    value: effort,
    label: meta.label,
    description: meta.description,
    default: isDefault,
  };
}
