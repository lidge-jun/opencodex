import { z } from "zod";
import { USAGE_SOURCE_CLIENTS } from "../usage/source-filter";
import { MAX_PARTITION_APP_KEYS, USAGE_APPS, USAGE_LEGACY_WIRES, usageAppKey } from "../usage/app-breakdown";

export const MAX_HUB_USAGE_BYTES = 1024 * 1024;
const count = z.number().finite().nonnegative();
const label = z.string().min(1).max(2048).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const costs = { requests: count, totalTokens: count, estimatedCostUsd: count.optional() };
const appCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const apps = z.array(z.object({ client: z.enum(USAGE_APPS), name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/).optional(),
  legacyWire: z.enum(USAGE_LEGACY_WIRES).optional(), requests: appCount, measuredRequests: appCount,
  totalTokens: count, estimatedCostUsd: count.optional(), pricedRequests: appCount, unpricedRequests: appCount,
  shareRatio: count.max(1) })).max(MAX_PARTITION_APP_KEYS)
  .refine(rows => new Set(rows.map(usageAppKey)).size === rows.length);

// Every object is projected through this schema: account labels, raw entries, and
// future management-only fields must not hitch a ride on a client data-key read.
const hubUsageSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal("hub"), scope: z.literal("client"),
  range: z.enum(["today", "7d", "30d", "all"]),
  surface: z.enum(["all", "codex", "claude", "grok"]),
  since: count.nullable(), until: count.optional(), customWindow: z.literal(true).optional(),
  generatedAt: count,
  summary: z.object({ ...costs, inputTokens: count, outputTokens: count,
    cachedInputTokens: count, unpricedRequests: count, unmeteredRequests: count }),
  providers: z.array(z.object({ provider: label, ...costs })).max(2000),
  apps: apps.optional(),
  models: z.array(z.object({ provider: label, model: label, ...costs })).max(2000),
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ...costs })).max(366),
  filter: z.object({ provider: label.nullable(), model: label.nullable(),
    matched: z.boolean(), comboOverlap: z.boolean() }),
  sourceFilter: z.object({ client: z.enum(USAGE_SOURCE_CLIENTS), scope: z.literal("authenticated-key") }).optional(),
  legacyUnclassifiedRequests: count.optional(),
  usageIncomplete: z.literal(true).optional(),
  usageIncompleteReason: z.literal("oversized_rows").optional(),
});

export type HubUsageReport = z.infer<typeof hubUsageSchema>;

export function parseHubUsage(value: unknown): HubUsageReport | null {
  const result = hubUsageSchema.safeParse(value);
  return result.success ? result.data : null;
}
