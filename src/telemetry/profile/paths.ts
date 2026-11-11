import { join } from "node:path";
import { getConfigDir } from "../../config/paths";

/**
 * Location of the opt-in public profile file. Kept free of I/O so the server's background
 * lifecycle can check for a profile without loading any profile code.
 */
export const TELEMETRY_PROFILE_FILE = "telemetry-profile.json";

export function telemetryProfilePath(configDir = getConfigDir()): string {
  return join(configDir, TELEMETRY_PROFILE_FILE);
}

