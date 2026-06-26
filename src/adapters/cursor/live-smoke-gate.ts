export const CURSOR_LIVE_SMOKE_TOKEN_ENV = "OPENCODEX_CURSOR_TEST_TOKEN";
export const CURSOR_LIVE_SMOKE_BASE_URL_ENV = "OPENCODEX_CURSOR_TEST_BASE_URL";
export const CURSOR_LIVE_SMOKE_DEFAULT_BASE_URL = "https://api2.cursor.sh";

export interface CursorLiveSmokeGate {
  enabled: boolean;
  envName: string;
  baseUrl: string;
  skipReason?: string;
}

export function getCursorLiveSmokeToken(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const token = env[CURSOR_LIVE_SMOKE_TOKEN_ENV]?.trim();
  return token ? token : undefined;
}

export function readCursorLiveSmokeGate(
  env: Record<string, string | undefined> = process.env,
): CursorLiveSmokeGate {
  const baseUrl = env[CURSOR_LIVE_SMOKE_BASE_URL_ENV]?.trim() || CURSOR_LIVE_SMOKE_DEFAULT_BASE_URL;
  if (!getCursorLiveSmokeToken(env)) {
    return {
      enabled: false,
      envName: CURSOR_LIVE_SMOKE_TOKEN_ENV,
      baseUrl,
      skipReason: `${CURSOR_LIVE_SMOKE_TOKEN_ENV} is not set; live Cursor smoke is skipped.`,
    };
  }
  return {
    enabled: true,
    envName: CURSOR_LIVE_SMOKE_TOKEN_ENV,
    baseUrl,
  };
}

export function cursorLiveSmokeSkipMessage(gate: CursorLiveSmokeGate = readCursorLiveSmokeGate()): string {
  if (gate.enabled) return "Cursor live smoke credential is present.";
  return gate.skipReason ?? `${gate.envName} is not set; live Cursor smoke is skipped.`;
}
