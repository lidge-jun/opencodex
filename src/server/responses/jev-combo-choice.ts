import { getCombo, targetKey, type JevCandidate } from "../../combos";
import { isCodexReasoningEffort } from "../../reasoning-effort";
import { routeConcreteModel } from "../../router";
import { supportedLadderFor } from "../effort-policy";
import type { OcxComboDefaultEffort, OcxConfig } from "../../types";

/** A JEV target's effort choices plus, when quota signals are on, its resolved native identity. */
export interface JevChoiceIdentity {
  reasoningEfforts: OcxComboDefaultEffort[];
  quotaIdentity?: JevCandidate["quotaIdentity"];
}

/** A target's JEV effort choices, or undefined when an explicit allowlist has none still supported. */
export function jevChoiceEfforts(
  config: OcxConfig,
  target: NonNullable<ReturnType<typeof getCombo>>["targets"][number],
  quotaSignals: boolean,
): JevChoiceIdentity | undefined {
  let ladder: string[] | undefined;
  // null tells the quota reader the route did not resolve, so it reads unknown rather than the configured alias.
  let quotaIdentity: JevCandidate["quotaIdentity"] = quotaSignals ? null : undefined;
  try {
    const route = routeConcreteModel(config, targetKey(target));
    ladder = supportedLadderFor({ provider: route.provider, modelId: route.modelId });
    if (quotaSignals) quotaIdentity = { provider: route.providerName, model: route.modelId };
  } catch {
    // Preserve the existing routing-failure surface. Unknown capability becomes the explicit
    // no-effort choice rather than broadening JEV's effort allowlist.
    ladder = undefined;
  }
  const supportedEfforts = (ladder ?? []).filter(isCodexReasoningEffort) as OcxComboDefaultEffort[];
  const configuredEfforts = target.reasoningEfforts;
  const reasoningEfforts = configuredEfforts === undefined
    ? supportedEfforts
    : configuredEfforts.filter(effort => supportedEfforts.includes(effort));
  // An explicit allowlist is restrictive. If catalog capabilities drift until no configured
  // effort remains supported, omit the target instead of silently broadening JEV's choices.
  return configuredEfforts !== undefined && reasoningEfforts.length === 0 ? undefined : { reasoningEfforts, quotaIdentity };
}
