/** Restore the caller label while retaining JEV's forced effort and later child transitions. */
export function comboRequestedEffortLabel(
  originalRequestedEffort: string | undefined,
  childRequestedEffort: string | undefined,
  forcedEffort?: string | null,
): string | undefined {
  if (originalRequestedEffort === undefined) return childRequestedEffort;
  const transitionIndex = childRequestedEffort?.indexOf("->") ?? -1;
  const laterTransitions = transitionIndex >= 0 ? childRequestedEffort!.slice(transitionIndex) : "";
  const forcedTransition = forcedEffort != null && forcedEffort !== originalRequestedEffort
    ? `->${forcedEffort}`
    : "";
  const segments = `${originalRequestedEffort}${forcedTransition}${laterTransitions}`.split("->");
  // A pin that kept the effort it was given is not a transition; drop the repeated segment.
  return segments.filter((segment, index) => index === 0 || segment !== segments[index - 1]).join("->");
}
