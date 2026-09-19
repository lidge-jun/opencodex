import { createHash } from "node:crypto";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

function normalizeSchedule(raw?: string | null): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return String(raw).trim();
  }
  return parsed.toISOString();
}

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
    providerSettings: canonicalize(input.providerSettings ?? {}),
    scheduledAt: normalizeSchedule(input.scheduledAt),
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

