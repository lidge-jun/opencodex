/**
 * A local mirror of GOAT's `ocx.quota-pool/1` decoder (goat-si/goat
 * packages/contracts/src/quotaPool.ts, branch feat/quota-pool-contract, PR #690).
 *
 * Stricter than the consumer on purpose: objects are strict, so an unexpected key or a `null`
 * where the contract says "optional" fails here even though GOAT's forward-compatible arrays
 * would silently drop the element.
 */
import { z } from "zod";

const nonBlank = z.string().refine(value => value.trim().length > 0 && value === value.trim(), "trimmed non-empty");
const isoDateTime = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "ISO date-time");

export const QuotaWindowSchema = z.strictObject({
  id: nonBlank,
  kind: z.enum(["burst_5h", "daily", "weekly", "monthly", "credits", "custom"]),
  label: nonBlank,
  usedPercent: z.number().min(0).max(100).optional(),
  used: z.number().optional(),
  limit: z.number().optional(),
  unit: z.enum(["requests", "tokens", "credits", "usd"]).optional(),
  resetsAt: isoDateTime.optional(),
  windowSeconds: z.number().min(0).optional(),
  scopeModel: nonBlank.optional(),
  source: z.enum(["measured", "header", "estimated"]),
  observedAt: isoDateTime,
  exhausted: z.boolean().optional(),
});

export const QuotaAccountSchema = z.strictObject({
  provider: nonBlank,
  driver: nonBlank.optional(),
  accountRef: z.string().min(1),
  label: nonBlank.optional(),
  plan: nonBlank.optional(),
  state: z.enum(["available", "exhausted", "paused", "reauth", "unknown"]),
  windows: z.array(QuotaWindowSchema),
  failure: nonBlank.optional(),
});

export const QuotaPoolSchema = z.strictObject({
  schema: z.literal("ocx.quota-pool/1"),
  producer: z.strictObject({
    version: nonBlank,
    role: z.enum(["standalone", "hub", "client"]),
    homeId: nonBlank,
  }),
  generatedAt: isoDateTime,
  providers: z.array(z.strictObject({
    provider: nonBlank,
    accounts: z.array(QuotaAccountSchema),
    pooled: z.strictObject({
      windows: z.array(QuotaWindowSchema),
      headroom: z.number().optional(),
      nextResetAt: isoDateTime.optional(),
    }),
  })),
});

/** Every `null` anywhere in a decoded body: the contract omits unknown fields instead. */
export function nullPaths(value: unknown, path = "$"): string[] {
  if (value === null) return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => nullPaths(item, `${path}.${key}`));
  }
  return [];
}
