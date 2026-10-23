import * as z from "zod/v4";

/** Percent of a routed model's context window told to Codex when the config sets no window. */
export const unlistedModelsToldContextWindowSchema = z.number().gt(0).lte(100);

export function unlistedModelsToldContextWindowConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const percent = (value as Record<string, unknown>).unlistedModelsToldContextWindow;
  return percent === undefined || unlistedModelsToldContextWindowSchema.safeParse(percent).success
    ? null : "schema_invalid: unlistedModelsToldContextWindow: must be a number greater than 0 and at most 100, or omitted";
}
