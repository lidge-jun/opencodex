import * as z from "zod/v4";
/** Startup resumes observation only. Certificate trust, app launch and Apply are never saved here. */
export const desktopCompatibilitySchema = z.object({ startOnProxyStart: z.boolean() }).strict();
export function desktopCompatibilityConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const setting = (value as Record<string, unknown>).desktopCompatibility;
  return setting === undefined || desktopCompatibilitySchema.safeParse(setting).success
    ? null : "schema_invalid: desktopCompatibility: requires only boolean startOnProxyStart";
}
