import { getProviderRegistryEntry, registryEntryForProviderDestination } from "./registry";
import type { OcxConfig } from "../types";

export const VOLCENGINE_CODING_PLAN_PROVIDER_ID = "volcengine-coding-plan";
export const VOLCENGINE_CODING_PLAN_RESPONSES_DEFAULT_VERSION = 1;

/**
 * Persist Volcengine Coding Plan's move from Chat Completions to native Responses.
 *
 * The registry now owns the documented Ark Coding Plan destination. Existing installs may still
 * have the old built-in Chat row saved under the canonical provider id; migrate that row once,
 * then leave any later explicit wire choice alone through the version marker.
 */
export function migrateVolcengineCodingPlanResponsesDefault(config: OcxConfig): boolean {
  const provider = config.providers[VOLCENGINE_CODING_PLAN_PROVIDER_ID];
  if (!provider
    || (provider.volcengineCodingPlanResponsesDefaultVersion ?? 0) >= VOLCENGINE_CODING_PLAN_RESPONSES_DEFAULT_VERSION) {
    return false;
  }

  const entry = getProviderRegistryEntry(VOLCENGINE_CODING_PLAN_PROVIDER_ID);
  if (!entry || registryEntryForProviderDestination(provider)?.id !== VOLCENGINE_CODING_PLAN_PROVIDER_ID) return false;

  config.providers = {
    ...config.providers,
    [VOLCENGINE_CODING_PLAN_PROVIDER_ID]: {
      ...provider,
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
      ...(entry.responsesPath !== undefined ? { responsesPath: entry.responsesPath } : {}),
      volcengineCodingPlanResponsesDefaultVersion: VOLCENGINE_CODING_PLAN_RESPONSES_DEFAULT_VERSION,
    },
  };
  return true;
}
