import * as z from "zod/v4";

/** Keep invalid hand edits out of the live map without losing the rest of config.json. */
export const blockedModelRedirectsSchema = z.record(
  z.string().refine(key => key.trim().length > 0),
  z.string().refine(target => target.trim().length > 0),
);

/** Candidate writes must reject maps the read schema would silently discard. */
export function blockedModelRedirectsError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>).blockedModelRedirects;
  if (raw === undefined) return undefined;
  return blockedModelRedirectsSchema.safeParse(raw).success
    ? undefined
    : "schema_invalid: blockedModelRedirects requires a map of nonempty model keys to nonempty string targets";
}
