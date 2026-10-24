import { createHmac } from "node:crypto";

/** A local, versioned join key for two slots backed by the same upstream user. */
export function codexUpstreamAccountKey(
  adminToken: string | null,
  accountId: string | null | undefined,
  userId: string | null | undefined,
): string | undefined {
  if (!adminToken || !accountId || !userId || accountId.length > 512 || userId.length > 512) return undefined;
  return `uai1_${createHmac("sha256", adminToken)
    .update("opencodex-upstream-account-v1\0")
    .update(JSON.stringify([accountId, userId]))
    .digest("hex")}`;
}
