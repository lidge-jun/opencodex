import { z } from "zod";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import { parseAnthropicModelRoutes } from "../oauth/anthropic-model-routes";

const text = z.string().max(4096);
export const accountId = z.string().refine(id => id === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(id));
export const threshold = z.number().int().min(0).max(100);
const nullableThreshold = threshold.nullable();
const row = z.object({
  id: accountId, alias: text.optional(), autoSwitchThresholdOverride: nullableThreshold.optional(),
  quota: z.object({ shortWindowSeconds: z.number().finite().optional(), shortResetAt: z.number().finite().optional(),
    weeklyResetAt: z.number().finite().optional() }).nullable().optional(),
  quotaAutoRefresh: z.object({ fiveHourAvailable: z.boolean(), weeklyAvailable: z.boolean(),
    fiveHourEnabled: z.boolean(), weeklyEnabled: z.boolean() }).optional(),
});
export const rosterSchema = z.object({ accounts: z.array(row).refine(rows => new Set(rows.map(r => r.id)).size === rows.length) });
const fields = z.enum(["enabled", "strategy", "stickyLimit", "autoSwitchThreshold", "quotaWindow", "maxConcurrentPerAccount", "routes"]);
export const poolSchema = z.object({
  provider: z.string(), kind: z.enum(["codex", "anthropic", "generic"]), supported: z.array(fields),
  enabled: z.boolean().nullable(), enabledEffective: z.boolean(),
  strategy: z.enum(["quota", "round-robin", "fill-first", "reset-first", "least-loaded"]).nullable(),
  stickyLimit: z.number().int().min(1).max(100).nullable(), autoSwitchThreshold: nullableThreshold,
  quotaWindow: z.enum(["five-hour", "weekly", "max-utilization"]).nullable(),
  maxConcurrentPerAccount: z.number().int().min(1).max(100).nullable(),
  routes: z.unknown().transform((value, ctx) => {
    if (value === null) return null;
    const parsed = parseAnthropicModelRoutes(value);
    if (parsed.ok) return parsed.routes;
    ctx.addIssue({ code: "custom", message: "Invalid routes" });
    return z.NEVER;
  }),
  // The server returns a static validation diagnostic here; never forward its text.
  routesError: z.string().transform(() => "Stored model routes are invalid.").optional(), inert: z.boolean().optional(),
});
export const thresholdReceipt = z.object({ ok: z.literal(true), id: accountId,
  autoSwitchThresholdOverride: nullableThreshold, autoSwitchThreshold: threshold });
export const creditReceipt = z.object({ ok: z.literal(true), id: accountId, creditsAfterLimit: z.boolean() });
export const creditAllReceipt = z.object({ ok: z.literal(true), all: z.boolean(),
  ids: z.array(accountId).refine(ids => new Set(ids).size === ids.length) });
const window = z.enum(["five_hour", "seven_day", "seven_day_overage_included"]);
// The server preserves any Date.parse-compatible timestamp; do not narrow it to Z-only ISO.
const date = text.refine(value => !Number.isNaN(Date.parse(value))).nullable();
const grantId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const grant = z.object({ id: grantId, label: text, resetsTotal: z.number().int().nonnegative(),
  resetsLeft: z.number().int().nonnegative(), startsAt: date, endsAt: date, clears: z.array(window),
  paused: z.boolean(), usableNow: z.boolean(), useRequiresLimit: z.boolean(),
  percentUsed: z.object({ five_hour: threshold.optional(), seven_day: threshold.optional(),
    seven_day_overage_included: threshold.optional() }),
}).refine(value => value.resetsLeft <= value.resetsTotal);
export const grantsSchema = z.object({ accountId: text.min(1), eligible: z.boolean(),
  ineligibleReason: z.enum(["config_off", "tier", "seat", "mobile", "surface", "cli_version", "no_grant", "tenure", "other_experiment", "unavailable", "unknown"]).nullable(),
  atLimit: z.boolean(), grants: z.array(grant).refine(values => new Set(values.map(value => value.id)).size === values.length), nextGrantId: grantId.nullable(), weeklyResetsAt: date, cooldownUntil: date,
  pendingOperation: z.object({ operationId: z.string().uuid(), grantId, createdAt: z.number().finite(),
    retryableUntil: z.number().finite() }).nullable(), journalAvailable: z.boolean(),
});
export function parseDto<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid account policy response");
  return parsed.data;
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid account policy response");
  return value as Record<string, unknown>;
}
