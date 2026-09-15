import { FEATURE_FLAG_ENV } from "./constants";

/**
 * Feature flag for the Security Control Plane.
 *
 * Production default is off until an operator opts in. Tests enable the plane
 * by constructing SecurityControlService with an explicit database path; they
 * do not rely on this flag. The management API and CLI refuse mutating work
 * when the flag is false.
 */
export function isSecurityControlPlaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FEATURE_FLAG_ENV]?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}
