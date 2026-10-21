import type { OcxProviderConfig } from "../types";
import { sanitizeApiKeyValue } from "../providers/api-keys";
import { accountPauseDetailsSchema } from "../config/schema/account-auto-pause";

/** Runtime guards: provider config is intentionally passthrough, so persisted fields may be malformed. */
export function preservableApiKeyPool(value: unknown): NonNullable<OcxProviderConfig["apiKeyPool"]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const pool: NonNullable<OcxProviderConfig["apiKeyPool"]> = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const key = sanitizeApiKeyValue(candidate.key);
    if (!id || !key || ids.has(id) || keys.has(key)) continue;
    const label = typeof candidate.label === "string" ? candidate.label : undefined;
    const addedAt = typeof candidate.addedAt === "number" && Number.isFinite(candidate.addedAt)
      ? candidate.addedAt
      : undefined;
    const details = accountPauseDetailsSchema.safeParse(candidate.pauseDetails);
    ids.add(id);
    keys.add(key);
    pool.push({
      id,
      key,
      ...(label !== undefined ? { label } : {}),
      ...(addedAt !== undefined ? { addedAt } : {}),
      ...(typeof candidate.disabled === "boolean" ? { disabled: candidate.disabled } : {}),
      ...(typeof candidate.pauseRevision === "string" ? { pauseRevision: candidate.pauseRevision } : {}),
      ...(details.success ? { pauseDetails: details.data } : {}),
    });
  }
  // Retain paused slots too: their metadata and credentials are needed for explicit resume.
  return pool.length > 0 ? pool : undefined;
}

