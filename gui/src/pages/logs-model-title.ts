import type { TFn } from "../i18n/shared";

export interface ModelTitleEntry {
  model: string;
  resolvedModel?: string;
  requestedServiceTier?: string;
  configuredServiceTier?: string;
  responseServiceTier?: string;
  modelSupportsServiceTier?: boolean;
}

export function modelTitle(log: ModelTitleEntry, t: TFn): string {
  const details = [
    `${t("logs.modelTooltip.model")}=${log.model}`,
    log.resolvedModel ? `${t("logs.modelTooltip.resolvedModel")}=${log.resolvedModel}` : undefined,
    log.requestedServiceTier ? `${t("logs.modelTooltip.requestedTier")}=${log.requestedServiceTier}` : undefined,
    log.configuredServiceTier ? `${t("logs.modelTooltip.configuredTier")}=${log.configuredServiceTier}` : undefined,
    log.responseServiceTier ? `${t("logs.modelTooltip.responseTier")}=${log.responseServiceTier}` : undefined,
    log.modelSupportsServiceTier !== undefined
      ? `${t("logs.modelTooltip.supportsTier")}=${log.modelSupportsServiceTier}`
      : undefined,
  ].filter(Boolean);
  return details.join(" \u00B7 ");
}
