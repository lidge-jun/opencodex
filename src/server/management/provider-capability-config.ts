import { booleanRecordConfigError } from "../../config";
import type { OcxConfig } from "../../types";

/**
 * Provider-management validation that belongs to the provider editor, not the
 * request-authentication/CORS boundary. Keeping this here lets the editor
 * evolve its capability schema without widening the auth-cors security surface.
 */
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

function publicServiceTierRecord(value: unknown): Record<string, boolean> | undefined {
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
    const capabilities = publicServiceTierRecord(provider.modelSupportsServiceTier);
    if (capabilities === undefined) continue;
    projectedProviders[name] = { ...(dtoProvider as Record<string, unknown>), modelSupportsServiceTier: capabilities };
  }
  return { ...root, providers: projectedProviders };
}
