import { isAbsolute } from "node:path";
import { isRecord, LocalMessagingError } from "./types";

/** Profile names are bounded opaque native identifiers, never file paths or tool-controlled grants. */
export const isResumeProfile = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f]/.test(value);

type PermissionRead = (method: "configRequirements/read" | "permissionProfile/list", params: Record<string, unknown>) => Promise<unknown>;

/** Verify the host-selected grant before execution; do not inherit a persisted fallback selection. */
export async function verifyResumeProfile(read: PermissionRead, profile: string, cwd: unknown): Promise<void> {
  function refuse(code: string): never { throw new LocalMessagingError(code, "The explicitly selected resume permission profile could not be verified."); }
  if (!isResumeProfile(profile) || typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > 4096 || /[\x00-\x1f]/.test(cwd)) refuse("resume_permissions_unverified");
  const requirements = await read("configRequirements/read", {});
  if (!isRecord(requirements) || !Object.hasOwn(requirements, "requirements")) refuse("resume_permissions_unverified");
  // Native managed requirements can substitute their default even for an explicit profile.
  if (requirements.requirements !== null) refuse("resume_managed_policy_unsupported");
  const page = await read("permissionProfile/list", { cwd, limit: 50, cursor: null });
  if (!isRecord(page) || !Array.isArray(page.data) || page.data.length > 50
    || !(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 4096))) refuse("resume_permissions_unverified");
  const seen = new Set<string>();
  for (const item of page.data) {
    if (!isRecord(item) || !isResumeProfile(item.id) || typeof item.allowed !== "boolean" || seen.has(item.id)) refuse("resume_permissions_unverified");
    seen.add(item.id);
  }
  if (!page.data.some((item: Record<string, unknown>) => item.id === profile && item.allowed === true)) refuse("resume_profile_unavailable");
}
