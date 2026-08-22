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

/**
 * Validate the provider editor's encrypted V2 capability outside the auth/CORS boundary.
 * The capability is an explicit operator trust decision, and only Responses adapters can
 * preserve the opaque task wire required by the feature.
 */
export function providerEncryptedV2ConfigError(name: unknown, provider: unknown): string | null {
  if (typeof name !== "string" || !provider || typeof provider !== "object" || Array.isArray(provider)) {
    return null;
  }
  const raw = provider as Record<string, unknown>;
  if (raw.allowEncryptedV2AgentTasks !== undefined && typeof raw.allowEncryptedV2AgentTasks !== "boolean") {
    return `provider ${name} allowEncryptedV2AgentTasks must be a boolean`;
  }
  if (raw.allowEncryptedV2AgentTasks === true && raw.adapter !== "openai-responses") {
    return `provider ${name} allowEncryptedV2AgentTasks requires adapter=openai-responses`;
  }
  return null;
}

function publicServiceTierRecord(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([model, supported]) =>
    model.trim().length > 0 && typeof supported === "boolean",
  );
  return Object.fromEntries(entries) as Record<string, boolean>;
}

/**
 * Add the provider editor's capability fields to the already secret-free config
 * DTO. `safeConfigDTO` remains the owner of auth/cors redaction; this helper
 * only projects the booleans used by the management UI.
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
    const encryptedV2 = typeof provider.allowEncryptedV2AgentTasks === "boolean"
      ? provider.allowEncryptedV2AgentTasks
      : undefined;
    if (capabilities === undefined && encryptedV2 === undefined) continue;
    projectedProviders[name] = {
      ...(dtoProvider as Record<string, unknown>),
      ...(capabilities === undefined ? {} : { modelSupportsServiceTier: capabilities }),
      ...(encryptedV2 === undefined ? {} : { allowEncryptedV2AgentTasks: encryptedV2 }),
    };
  }
  return { ...root, providers: projectedProviders };
}
