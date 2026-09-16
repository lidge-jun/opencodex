import { sha256 } from "../skills/hasher";

export interface ContentHashInput {
  caption?: string | null;
  title?: string | null;
  description?: string | null;
  hashtags?: string[];
  mediaSha256s?: string[];
  platform: string;
  accountRef: string;
  providerSettings?: Record<string, unknown>;
  scheduledAt?: string | null;
  policyVersion?: string;
}

/**
 * Computes a deterministic SHA-256 content hash.
 * If any content, media, destination, schedule, or provider settings change,
 * the resulting hash changes, invalidating any prior approval.
 */
export function computeContentHash(input: ContentHashInput): string {
  const normalized = {
    caption: (input.caption ?? "").trim(),
    title: (input.title ?? "").trim(),
    description: (input.description ?? "").trim(),
    hashtags: [...(input.hashtags ?? [])].sort(),
    mediaSha256s: [...(input.mediaSha256s ?? [])],
    platform: input.platform.toLowerCase().trim(),
    accountRef: input.accountRef.trim(),
    providerSettings: input.providerSettings ?? {},
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt).toISOString() : null,
    policyVersion: input.policyVersion ?? "v1",
  };
  return sha256(JSON.stringify(normalized));
}

/**
 * Computes a deterministic idempotency key for delivery operations.
 */
export function computeIdempotencyKey(
  workspaceId: string,
  publicationId: string,
  renditionId: string,
  contentHash: string,
  operationType: string,
  targetSchedule?: string | null,
): string {
  const payload = [
    workspaceId,
    publicationId,
    renditionId,
    contentHash,
    operationType,
    targetSchedule ?? "immediate",
  ].join(":");
  return sha256(payload);
}

