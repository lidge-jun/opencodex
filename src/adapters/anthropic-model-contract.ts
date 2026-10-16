/**
 * Per-model Anthropic Messages contract: which wire shapes a Claude family accepts.
 *
 * Kept apart from the adapter so the web-search and vision sidecars, which build their own
 * Messages bodies, apply the same rules without importing the whole adapter.
 */

/**
 * Claude families that moved to adaptive thinking: they 400 on `thinking.type: "enabled"`
 * ("Use \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior."),
 * while older families (Haiku 4.5, Sonnet 4.x, Opus <= 4.6) 400 on `adaptive` — so both wire
 * shapes must stay. Verified against api.anthropic.com: sonnet-5, fable-5, opus-4-7 and opus-4-8
 * require adaptive; haiku-4-5 and sonnet-4-5 reject it; opus-4-6/sonnet-4-6 accept both.
 * Haiku 5.5 requires adaptive (platform.claude.com Haiku 5.5 migration guide, 2026-10-08).
 */
const ADAPTIVE_THINKING_FAMILY_MINIMUMS: Record<string, readonly [major: number, minor: number]> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
  haiku: [5, 5],
};

/**
 * Family/version parse for a Claude model id, tolerant of a routing prefix.
 *
 * `parsed.modelId` is not always bare, and the slash can fall on either side.
 * A `modelMap` entry may point at a routed destination such as
 * `anthropic/claude-sonnet-5` (prefix), while a custom provider may expose a
 * native id such as `claude-sonnet-5/variant` (suffix); both survive routing's
 * known-id decoding. So this matches the segment that actually begins with
 * `claude-` rather than assuming it is the first or the last one. A capability
 * predicate that quietly returns false is worse than one that throws — the
 * request just goes out wrong.
 *
 * Minor is 1-2 digits with a non-digit lookahead so date-pinned ids
 * ("claude-opus-4-20250514") parse as minor 0 instead of minor 20250514;
 * suffixed ids ("claude-opus-4-8[1m]") still match.
 */
export function claudeFamilyVersion(modelId: string): { family: string; major: number; minor: number } | undefined {
  // Find the segment that actually starts with `claude-`, rather than assuming it is either
  // the first (breaks `anthropic/claude-sonnet-5`) or the last (breaks `claude-sonnet-5/variant`,
  // where the slash carries a vendor suffix rather than a routing prefix).
  const match = /(?:^|\/)claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?!\d)/i.exec(modelId);
  if (!match) return undefined;
  return {
    family: match[1]!.toLowerCase(),
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function atLeast(parsed: { major: number; minor: number }, minimum: readonly [number, number]): boolean {
  return parsed.major > minimum[0] || (parsed.major === minimum[0] && parsed.minor >= minimum[1]);
}

function meetsFamilyMinimum(
  modelId: string,
  minimums: Record<string, readonly [major: number, minor: number]>,
): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (!parsed) return false;
  const minimum = minimums[parsed.family];
  return minimum !== undefined && atLeast(parsed, minimum);
}

export function usesAdaptiveThinking(modelId: string): boolean {
  return meetsFamilyMinimum(modelId, ADAPTIVE_THINKING_FAMILY_MINIMUMS);
}

/**
 * Sonnet 5.5 and later: `thinking.type` accepts only `adaptive` and `between_tools`. An explicit
 * `disabled` 400s ("\"thinking.type.disabled\" is not supported for this model. Use
 * \"thinking.type.between_tools\" for the lowest thinking setting ..."), so `between_tools` is the
 * lowest setting the request can ask for. It is accepted at low..high effort and rejected at
 * xhigh/max (platform.claude.com Sonnet 5.5 migration guide, read 2026-09-29).
 */
export function usesBetweenToolsFloor(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  return parsed?.family === "sonnet" && atLeast(parsed, [5, 5]);
}

/**
 * Claude families that (a) think by DEFAULT when the request omits `thinking`,
 * and (b) accept an explicit `thinking: {type: "disabled"}` to turn it off.
 *
 * Deliberately NOT `usesAdaptiveThinking()`, which answers a different question
 * (which wire shape a family accepts). The two sets differ in both directions:
 * Fable always thinks and REJECTS an explicit disable, while Opus 4.7/4.8 use
 * the adaptive wire but leave thinking off when the field is omitted, so they
 * need no disable at all. Seeded with the family where the defect reproduces
 * (#545); widen only with vendor evidence, since a wrong entry here turns a
 * silent truncation into a 400. Sonnet 5.5 dropped `disabled` again, so the
 * Sonnet range ends there and `usesBetweenToolsFloor` takes over. Haiku 5.5+ accepts disable
 * at high effort or below; send no effort with it (Haiku 5.5 migration guide, 2026-10-08).
 */
export function supportsExplicitThinkingDisable(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  return (parsed?.family === "sonnet" && atLeast(parsed, [5, 0]) && !atLeast(parsed, [5, 5]))
    || (parsed?.family === "haiku" && atLeast(parsed, [5, 5]));
}

/**
 * Forced `tool_choice` (`any` / `tool`) 400s on Opus 5.5, Fable 5.1 and Sonnet 5.5 and later
 * ("tool_choice: type \"tool\" and \"any\" are not supported for this model."). Opus 5, Fable 5
 * and Sonnet 5 still accept it (live, 2026-09-29).
 */
export function rejectsForcedToolChoice(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (parsed?.family === "opus") return parsed.major === 5 && parsed.minor === 5;
  if (parsed?.family === "fable") return atLeast(parsed, [5, 1]);
  return parsed?.family === "sonnet" && atLeast(parsed, [5, 5]);
}

/**
 * Families that 400 on any non-default `temperature`, `top_p` or `top_k` ("temperature is deprecated
 * for this model."), with or without thinking. Live 2026-09-29: Opus 4.7, 4.8, 5 and 5.5,
 * Sonnet 5 and 5.5, Fable 5 and 5.1 reject them; Opus 4.6, Sonnet 4.6 and Haiku 4.5 accept them.
 * Haiku 5.5 rejects them too (Haiku 5.5 migration guide, read 2026-10-08).
 * `temperature: 1` (the default) is accepted everywhere, but the adapter drops the field rather than
 * guess which value a caller meant as default.
 */
const SAMPLING_REJECTION_FAMILY_MINIMUMS: Record<string, readonly [major: number, minor: number]> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
  haiku: [5, 5],
};

export function rejectsSamplingParameters(modelId: string): boolean {
  return meetsFamilyMinimum(modelId, SAMPLING_REJECTION_FAMILY_MINIMUMS);
}

/**
 * Families that accept `temperature` or `top_p` alone but 400 when both are sent ("temperature and top_p
 * cannot both be specified for this model."). Live 2026-09-29: Haiku 4.5, Sonnet 4.5 and
 * 4.6, Opus 4.5 and 4.6. Older ids were not measured and keep both fields.
 */
export function rejectsCombinedSampling(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (!parsed || rejectsSamplingParameters(modelId)) return false;
  return ["opus", "sonnet", "haiku"].includes(parsed.family) && atLeast(parsed, [4, 5]);
}

/**
 * Families that reject both `thinking: disabled` and `thinking: between_tools` (live 2026-09-29):
 * Opus 5.5 and every Fable. They think by default, so the lowest a request can ask for is a low effort.
 */
function hasNoThinkingOffSwitch(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (parsed?.family === "fable") return true;
  return parsed?.family === "opus" && parsed.major === 5 && parsed.minor === 5;
}

export type SidecarThinkingFields =
  | { thinking: { type: "disabled" } | { type: "between_tools" } }
  | { output_config: { effort: "low" } };

/**
 * The lowest-thinking fields a sidecar spreads into its Messages body for `modelId`. Sidecars
 * historically sent `thinking: disabled` for every model. Sonnet 5.5+ gets `between_tools` instead;
 * Opus 5.5 and Fable get no `thinking` and a low effort, which a live probe showed still answers inside
 * a 1,024-token budget (end_turn with visible text).
 */
export function sidecarThinkingOff(modelId: string): SidecarThinkingFields {
  if (usesBetweenToolsFloor(modelId)) return { thinking: { type: "between_tools" } };
  if (hasNoThinkingOffSwitch(modelId)) return { output_config: { effort: "low" } };
  return { thinking: { type: "disabled" } };
}
