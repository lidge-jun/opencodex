import { FEATURE_FLAG_ENV, LEGACY_FALLBACK_ENV } from "./constants";

/**
 * Feature flag for the Provider Access Control Plane.
 *
 * Production default is off until an operator opts in. Tests enable the plane
 * by constructing CredentialRuntimeService with an explicit database path; they
 * do not rely on this flag. The management API and CLI refuse mutating work
 * when the flag is false.
 */
export function isCredentialRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FEATURE_FLAG_ENV]?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export function allowLegacySecretFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LEGACY_FALLBACK_ENV]?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

