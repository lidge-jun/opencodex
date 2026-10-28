import { IntegrationApiError, readIntegrationResponse, type IntegrationState } from "./integration-api";

/** One Hermes profile as GET /api/client-integrations/hermes/profiles reports it (#7674). */
export interface HermesProfileStatus {
  hermesProfile: string;
  configPath: string;
  state: IntegrationState;
  installed: boolean;
  error?: string;
}

const STATES: readonly IntegrationState[] = ["absent", "current", "stale", "conflict", "unsafe"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(): never {
  throw new IntegrationApiError(502, { code: "invalid_hermes_profile_response" });
}

/** The default profile first, then every named profile; the server owns discovery. */
export async function loadHermesProfiles(apiBase: string, signal?: AbortSignal): Promise<HermesProfileStatus[]> {
  const body = await readIntegrationResponse<unknown>(await fetch(apiBase + "/api/client-integrations/hermes/profiles", { signal }));
  if (!isRecord(body) || !Array.isArray(body.profiles)) invalid();
  const profiles = body.profiles.map((row): HermesProfileStatus => {
    if (!isRecord(row) || typeof row.hermesProfile !== "string" || typeof row.configPath !== "string"
      || typeof row.installed !== "boolean" || !STATES.includes(row.state as IntegrationState)) invalid();
    return {
      hermesProfile: row.hermesProfile, configPath: row.configPath,
      state: row.state as IntegrationState, installed: row.installed,
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    };
  });
  if (profiles[0]?.hermesProfile !== "default" || new Set(profiles.map(row => row.hermesProfile)).size !== profiles.length) invalid();
  return profiles;
}
