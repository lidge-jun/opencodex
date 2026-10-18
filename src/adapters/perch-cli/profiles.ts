import type { CodingAgentProviderProfile } from "../coding-agent/profile";

/**
 * Profile for the Perch CLI (`perchai-cli`), driven headlessly with `perch run --json`.
 *
 * The CLI owns the account: OpenCodex stores no Perch token and injects none. The child only learns
 * where the operator's own `cli-auth-session.json` lives (`PERCH_CLI_AUTH_DIR`), so a token refresh
 * the CLI performs mid-turn is written back to the operator's real session file.
 *
 * Evidence (verified 2026-10-17 against perchai-cli 2.4.109): see `./adapter.ts`.
 */
export interface PerchCliProfile extends CodingAgentProviderProfile {
  family: "perch";
}

export const PERCH_CLI_PROFILE: PerchCliProfile = {
  providerId: "perch-cli",
  family: "perch",
  region: "global",
  label: "Perch CLI",
  canonicalBaseUrl: "https://app.perchai.app",
  binaryCandidates: ["perch"],
  installHint: "npm install -g perchai-cli && perch login",
  documentationUrl: "https://app.perchai.app",
};

export const PERCH_CLI_PROFILES: readonly PerchCliProfile[] = [PERCH_CLI_PROFILE];
