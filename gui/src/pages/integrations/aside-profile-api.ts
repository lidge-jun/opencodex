import { IntegrationApiError, readIntegrationResponse } from "./integration-api";

import { parseAsideProfileStatus, parseAsideProfileOutcomes, type AsideProfileStatus, type AsideProfileOutcome } from "./aside-profile-contract";
export type { AsideProfileStatus } from "./aside-profile-contract";

export interface AsideProfileList {
  profiles: AsideProfileStatus[];
  allEnabled: boolean;
  enabledCount: number;
  appliedCount: number;
  total: number;
  error?: string;
}
export interface AsideSyncResult {
  ok: boolean;
  results: AsideProfileOutcome[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never { throw new IntegrationApiError(502, { code: "invalid_aside_profile_response" }); }

export async function loadAsideProfiles(apiBase: string, signal?: AbortSignal): Promise<AsideProfileList> {
  const body = await readIntegrationResponse<unknown>(await fetch(`${apiBase}/api/client-integrations/aside/profiles`, { signal }));
  if (!isRecord(body) || !Array.isArray(body.profiles) || typeof body.allEnabled !== "boolean") invalid();
  const profiles = body.profiles.map(value => parseAsideProfileStatus(value) ?? invalid());
  if (new Set(profiles.map(row => row.profileId)).size !== profiles.length) invalid();
  const enabledCount = profiles.filter(row => row.enabled).length;
  const appliedCount = profiles.filter(row => row.state === "current" || row.state === "stale").length;
  if (body.total !== profiles.length || body.enabledCount !== enabledCount || body.appliedCount !== appliedCount
    || body.allEnabled !== (profiles.length > 0 && enabledCount === profiles.length)) invalid();
  return { profiles, allEnabled: body.allEnabled, enabledCount, appliedCount, total: profiles.length,
    ...(typeof body.error === "string" ? { error: body.error } : {}) };
}

export async function syncAsideProfiles(apiBase: string, signal?: AbortSignal): Promise<AsideSyncResult> {
  const body = await readIntegrationResponse<unknown>(await fetch(`${apiBase}/api/client-integrations/aside/sync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal,
  }));
  if (!isRecord(body) || typeof body.ok !== "boolean" || !Array.isArray(body.results)) invalid();
  if (body.results.some(value => !isRecord(value) || value.client !== "aside")) invalid();
  const results = parseAsideProfileOutcomes(body.results) ?? invalid();
  if (body.ok !== results.every(row => row.ok)) invalid();
  return { ok: body.ok, results };
}
