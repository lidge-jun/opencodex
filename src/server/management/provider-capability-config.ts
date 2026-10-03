import { booleanRecordConfigError } from "../../config/provider-validation";
import type { OcxConfig, OcxProviderConfig } from "../../types";

/** Provider-management validation shared by provider editor write paths. */
export function providerServiceTierConfigError(name: unknown, provider: unknown): string | null {
  if (typeof name !== "string" || !provider || typeof provider !== "object" || Array.isArray(provider)) {
    return null;
  }
  const error = booleanRecordConfigError(
    (provider as { modelSupportsServiceTier?: unknown }).modelSupportsServiceTier,
    "modelSupportsServiceTier",
  );
  return error ? `provider ${name} ${error}` : null;
}

/** Reject invalid catalog overrides before management writes, including provider-specific Copilot modes. */
export function providerCatalogCapabilityConfigError(name: unknown, provider: unknown): string | null {
  const serviceTierError = providerServiceTierConfigError(name, provider);
  if (serviceTierError) return serviceTierError;
  if (typeof name !== "string" || !provider || typeof provider !== "object" || Array.isArray(provider)) {
    return null;
  }
  const copilotSelection = (provider as { copilotModelSelection?: unknown }).copilotModelSelection;
  if (copilotSelection !== undefined) {
    if (name !== "github-copilot") return "copilotModelSelection is valid only for provider github-copilot";
    if (copilotSelection !== "detect" && copilotSelection !== "auto" && copilotSelection !== "manual") {
      return "copilotModelSelection must be detect, auto, or manual";
    }
  }
  const error = booleanRecordConfigError(
    (provider as { modelSuppressSyntheticMax?: unknown }).modelSuppressSyntheticMax,
    "modelSuppressSyntheticMax",
  );
  return error ? `provider ${name} ${error}` : null;
}

function publicBooleanRecord(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([model, supported]) =>
    model.trim().length > 0 && typeof supported === "boolean",
  );
  return Object.fromEntries(entries) as Record<string, boolean>;
}

/**
 * Add the provider editor's capability map to the already secret-free config
 * DTO. `safeConfigDTO` remains the owner of auth/cors redaction; this helper
 * only projects a boolean model capability used by the management UI.
 */
export function withProviderServiceTierDTO(dto: unknown, config: OcxConfig): unknown {
  if (!dto || typeof dto !== "object" || Array.isArray(dto)) return dto;
  const root = dto as { providers?: unknown };
  if (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) return dto;

  const providers = root.providers as Record<string, unknown>;
  const projectedProviders: Record<string, unknown> = { ...providers };
  for (const [name, provider] of Object.entries(config.providers)) {
    const dtoProvider = providers[name];
    if (!dtoProvider || typeof dtoProvider !== "object" || Array.isArray(dtoProvider)) continue;
    const capabilities = publicBooleanRecord(provider.modelSupportsServiceTier);
    if (capabilities === undefined) continue;
    projectedProviders[name] = { ...(dtoProvider as Record<string, unknown>), modelSupportsServiceTier: capabilities };
  }
  return { ...root, providers: projectedProviders };
}

/** Project all catalog-only model capability maps across the dashboard config boundary. */
export function withProviderCatalogCapabilityDTO(dto: unknown, config: OcxConfig): unknown {
  const projected = withProviderServiceTierDTO(dto, config);
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) return projected;
  const root = projected as { providers?: unknown };
  if (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) return projected;

  const providers = root.providers as Record<string, unknown>;
  const projectedProviders: Record<string, unknown> = { ...providers };
  for (const [name, provider] of Object.entries(config.providers)) {
    const dtoProvider = providers[name];
    if (!dtoProvider || typeof dtoProvider !== "object" || Array.isArray(dtoProvider)) continue;
    const capabilities = publicBooleanRecord(provider.modelSuppressSyntheticMax);
    if (capabilities === undefined) continue;
    projectedProviders[name] = { ...(dtoProvider as Record<string, unknown>), modelSuppressSyntheticMax: capabilities };
  }
  return { ...root, providers: projectedProviders };
}


/** PATCH clear semantics are separate from the persisted enum validated on POST/config load. */
export function applyCopilotModelSelectionPatch(name: string, next: OcxProviderConfig, mode: unknown): string | null {
  if (name !== "github-copilot") return "copilotModelSelection is valid only for provider github-copilot";
  if (mode === null) delete next.copilotModelSelection;
  else if (mode === "detect" || mode === "auto" || mode === "manual") next.copilotModelSelection = mode;
  else return "copilotModelSelection must be detect, auto, manual, or null";
  return null;
}
