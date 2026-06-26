import type { OAuthController, OAuthCredentials } from "./types";

export const CURSOR_OAUTH_PROVIDER_ID = "cursor";
export const CURSOR_OAUTH_DISABLED_MESSAGE =
  "Cursor OAuth is intentionally disabled until the Cursor transport and exec bridge are audited.";

export class CursorOAuthDisabledError extends Error {
  readonly code = "cursor_oauth_disabled";

  constructor(message = CURSOR_OAUTH_DISABLED_MESSAGE) {
    super(message);
    this.name = "CursorOAuthDisabledError";
  }
}

export function cursorOAuthDisabledError(): CursorOAuthDisabledError {
  return new CursorOAuthDisabledError();
}

export async function loginCursor(_ctrl: OAuthController): Promise<OAuthCredentials> {
  throw cursorOAuthDisabledError();
}

export async function refreshCursorToken(_refreshToken: string): Promise<OAuthCredentials> {
  throw cursorOAuthDisabledError();
}
