import { z } from "zod";

export const MAX_HUB_USAGE_BYTES = 1024 * 1024;
const count = z.number().finite().nonnegative();
const label = z.string().min(1).max(2048).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const costs = { requests: count, totalTokens: count, estimatedCostUsd: count.optional() };

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
  models: z.array(z.object({ provider: label, model: label, ...costs })).max(2000),
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ...costs })).max(366),
  filter: z.object({ provider: label.nullable(), model: label.nullable(),
    matched: z.boolean(), comboOverlap: z.boolean() }),
  usageIncomplete: z.literal(true).optional(),
  usageIncompleteReason: z.literal("oversized_rows").optional(),
});

export type HubUsageReport = z.infer<typeof hubUsageSchema>;

export function parseHubUsage(value: unknown): HubUsageReport | null {
  const result = hubUsageSchema.safeParse(value);
  return result.success ? result.data : null;
}
