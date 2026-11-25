import * as z from "zod/v4";
import { isValidProviderName } from "../provider-name";

export const SUBSCRIPTION_RESERVE_SOFT = 0.6;
export const SUBSCRIPTION_RESERVE_HARD = 0.8;

const fraction = z.number().gt(0).max(1);
const providerModel = z.string().max(512).refine(value => {
  const [provider, ...model] = value.split("/");
  return isValidProviderName(provider!) && model.length > 0
    && model.every(part => part.length > 0 && !/[\s\p{Cc}*]/u.test(part));
}, "expected a concrete provider/model selector");

export const subscriptionReserveSchema = z.object({
  enabled: z.boolean().optional(),
  soft: fraction.optional(),
  hard: fraction.optional(),
  targets: z.array(providerModel).max(128).optional(),
}).strict().refine(
  policy => (policy.soft ?? SUBSCRIPTION_RESERVE_SOFT) <= (policy.hard ?? SUBSCRIPTION_RESERVE_HARD),
  { path: ["hard"], message: "hard must be at least soft after applying defaults" },
);

export function subscriptionReserveConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = (value as Record<string, unknown>).subscriptionReserve;
  if (policy === undefined) return null;
  const parsed = subscriptionReserveSchema.safeParse(policy);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0]!;
  const path = ["subscriptionReserve", ...issue.path].join(".");
  return `schema_invalid: ${path}: ${issue.code === "unrecognized_keys" ? "unexpected fields" : issue.message}`;
}
