import { REPLIT_DEFAULT_HOST_SUFFIX } from "./constants";

export type ValidatedReplitOrigin = string & { readonly __validatedReplitOrigin: unique symbol };

export function canonicalizeReplitOrigin(raw: string): ValidatedReplitOrigin {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("origin must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("origin must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("origin must not include credentials");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("origin must not include a path");
  }
  if (parsed.search) {
    throw new Error("origin must not include a query");
  }
  if (parsed.hash) {
    throw new Error("origin must not include a hash");
  }
  if (!parsed.hostname) {
    throw new Error("origin must include a hostname");
  }
  return parsed.origin as ValidatedReplitOrigin;
}

export type ReplitOriginValidationResult =
  | { ok: true; origin: ValidatedReplitOrigin }
  | { ok: false; error: string };

export function validateReplitOrigin(
  raw: string,
  options?: { allowCustomDomain?: boolean },
): ReplitOriginValidationResult {
  let origin: ValidatedReplitOrigin;
  try {
    origin = canonicalizeReplitOrigin(raw);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "origin must be a valid URL" };
  }
  const hostname = new URL(origin).hostname.toLowerCase();
  if (!options?.allowCustomDomain && !hostname.endsWith(REPLIT_DEFAULT_HOST_SUFFIX)) {
    return {
      ok: false,
      error: `origin hostname must end with ${REPLIT_DEFAULT_HOST_SUFFIX} unless allowCustomDomain is set`,
    };
  }
  return { ok: true, origin };
}
