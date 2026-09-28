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
 */
const ADAPTIVE_THINKING_FAMILY_MINIMUMS: Record<string, readonly [major: number, minor: number]> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
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
 * Sonnet range ends there and `usesBetweenToolsFloor` takes over.
 */
export function supportsExplicitThinkingDisable(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  return parsed?.family === "sonnet" && atLeast(parsed, [5, 0]) && !atLeast(parsed, [5, 5]);
}

/**
 * Forced `tool_choice` (`any` / `tool`) 400s on Opus 5.5 and on Sonnet 5.5 and later
 * ("tool_choice: type \"tool\" and \"any\" are not supported for this model.").
 */
export function rejectsForcedToolChoice(modelId: string): boolean {
  const parsed = claudeFamilyVersion(modelId);
  if (parsed?.family === "opus") return parsed.major === 5 && parsed.minor === 5;
  return parsed?.family === "sonnet" && atLeast(parsed, [5, 5]);
}

/** Sonnet 5.5 and later: a non-default temperature, top_p or top_k returns a 400. */
export function rejectsSamplingParameters(modelId: string): boolean {
  return usesBetweenToolsFloor(modelId);
}

/**
 * The lowest-thinking `thinking` field a sidecar sends for `modelId`. Sidecars historically sent
 * `disabled` for every model; only the families that reject it get `between_tools` instead.
 */
export function sidecarThinkingOff(modelId: string): { type: "disabled" } | { type: "between_tools" } {
  return usesBetweenToolsFloor(modelId) ? { type: "between_tools" } : { type: "disabled" };
}
