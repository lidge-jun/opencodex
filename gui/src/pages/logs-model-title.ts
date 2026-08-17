export interface ModelTitleEntry {
  model: string;
  resolvedModel?: string;
  requestedServiceTier?: string;
  configuredServiceTier?: string;
  responseServiceTier?: string;
  modelSupportsServiceTier?: boolean;
}

export function modelTitle(log: ModelTitleEntry): string {
  const details = [
    `model=${log.model}`,
    log.resolvedModel ? `resolved=${log.resolvedModel}` : undefined,
    log.requestedServiceTier ? `requestedTier=${log.requestedServiceTier}` : undefined,
    log.configuredServiceTier ? `configuredTier=${log.configuredServiceTier}` : undefined,
    log.responseServiceTier ? `responseTier=${log.responseServiceTier}` : undefined,
    log.modelSupportsServiceTier !== undefined ? `supportsTier=${log.modelSupportsServiceTier}` : undefined,
  ].filter(Boolean);
  return details.join(" \u00B7 ");
}
