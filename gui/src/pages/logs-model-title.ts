import type { TFn } from "../i18n/shared";

export interface ModelTitleTierOutcome {
  confirmation?: "confirmed" | "assumed" | "downgraded" | "unknown";
  fastDowngradeReason?: string;
}

export interface ModelTitleEntry {
  model: string;
  resolvedModel?: string;
  requestedServiceTier?: string;
  configuredServiceTier?: string;
  responseServiceTier?: string;
  modelSupportsServiceTier?: boolean;
  tierOutcome?: ModelTitleTierOutcome;
}

/**
 * #2455: the echoed tier alone does not say whether Fast was granted. The ChatGPT
 * backend answers `default` on turns it in fact scheduled as priority, so its echo is
 * marked non-authoritative and the outcome stays `assumed` (#2558) — which is the
 * honest answer, but only if the operator can see it. Qualify the echoed value with
 * how much it is worth, and name the reason when the tier was actually declined.
 *
 * The confirmation word is this proxy's own judgement about the turn, not a value the
 * upstream returned, so it is translated like any other visible string. The downgrade
 * reason stays verbatim: it is a diagnostic identifier (`response-declined`) that maps
 * to `fastDowngradeReason` in the source, and translating it would break that link.
 */
function tierConfirmationSuffix(outcome: ModelTitleEntry["tierOutcome"], t: TFn): string {
  const confirmation = outcome?.confirmation;
  if (!confirmation) return "";
  const reason = confirmation === "downgraded" && outcome?.fastDowngradeReason
    ? `: ${outcome.fastDowngradeReason}`
    : "";
  return ` (${t(`logs.modelTooltip.tierOutcome.${confirmation}`)}${reason})`;
}

export function modelTitle(log: ModelTitleEntry, t: TFn): string {
  const details = [
    `${t("logs.modelTooltip.model")}=${log.model}`,
    log.resolvedModel ? `${t("logs.modelTooltip.resolvedModel")}=${log.resolvedModel}` : undefined,
    log.requestedServiceTier ? `${t("logs.modelTooltip.requestedTier")}=${log.requestedServiceTier}` : undefined,
    log.configuredServiceTier ? `${t("logs.modelTooltip.configuredTier")}=${log.configuredServiceTier}` : undefined,
    log.responseServiceTier
      ? `${t("logs.modelTooltip.responseTier")}=${log.responseServiceTier}${tierConfirmationSuffix(log.tierOutcome, t)}`
      : undefined,
    log.modelSupportsServiceTier !== undefined
      ? `${t("logs.modelTooltip.supportsTier")}=${log.modelSupportsServiceTier}`
      : undefined,
  ].filter(Boolean);
  return details.join(" \u00B7 ");
}
