/**
 * Devin / Cognition OAuth.
 *
 * Login prefers an already-minted long-lived API key from the local Devin
 * credential store (~/.pi/agent/auth.json -> devin.access).
 * Browser fallback uses the same Auth0 sign-in flow as the Devin desktop
 * client (windsurf.com/windsurf/signin with redirect_uri=show-auth-token),
 * then exchanges the pasted Firebase ID token via Cognition's RegisterUser.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LocalTokenImportMode, OAuthController, OAuthCredentials } from "./types";
import { DEFAULT_REGION, type WindsurfRegion } from "./devin/types";
import { registerUser } from "./devin/register-user";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_API_SERVER = "https://server.codeium.com";
export const DEVIN_DEFAULT_API_SERVER = DEFAULT_API_SERVER;

function shouldImportLocal(mode: LocalTokenImportMode | undefined): boolean {
  return mode !== "off";
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length < 2 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function identityFromApiKey(apiKey: string): { accountId?: string; email?: string } {
  const jwtPart = apiKey.includes("$") ? apiKey.slice(apiKey.indexOf("$") + 1) : apiKey;
  const payload = decodeJwtPayload(jwtPart);
  const email = typeof payload?.email === "string" && payload.email.length > 0 ? payload.email : undefined;
  const sub = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  const authUid = typeof payload?.auth_uid === "string" && payload.auth_uid.length > 0 ? payload.auth_uid : undefined;
  return { ...(email ? { email } : {}), ...(sub || authUid ? { accountId: sub ?? authUid } : {}) };
}

function credentialsFromApiKey(apiKey: string, source: OAuthCredentials["source"] = "oauth"): OAuthCredentials {
  const identity = identityFromApiKey(apiKey);
  return {
    access: apiKey,
    refresh: "",
    expires: Date.now() + ONE_YEAR_MS,
    source,
    apiBaseUrl: DEFAULT_API_SERVER,
    ...identity,
  };
}

interface PiDevinAuthSlot { type?: unknown; access?: unknown; refresh?: unknown; expires?: unknown }

export async function importLocalPiDevinAuth(signal?: AbortSignal): Promise<OAuthCredentials | undefined> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Devin login aborted", "AbortError");
  }
  let parsed: { devin?: PiDevinAuthSlot };
  try {
    parsed = JSON.parse(await Bun.file(join(homedir(), ".pi", "agent", "auth.json")).text()) as { devin?: PiDevinAuthSlot };
  } catch {
    return undefined;
  }
  const access = parsed.devin?.access;
  if (typeof access !== "string" || access.trim().length === 0) return undefined;
  return credentialsFromApiKey(access.trim(), "local-cli");
}

function buildSignInUrl(region: WindsurfRegion): string {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: region.oauthClientId,
    redirect_uri: "show-auth-token",
    state: randomUUID(),
    prompt: "login",
  });
  return region.website + "/windsurf/signin?" + params.toString();
}

async function loginDevinBrowser(ctrl: OAuthController, region: WindsurfRegion): Promise<OAuthCredentials> {
  const url = buildSignInUrl(region);
  ctrl.onAuth?.({
    url,
    instructions: "Sign in with your Cognition/Devin account, then paste the on-screen auth token here.",
  });
  ctrl.onProgress?.("Waiting for the pasted auth token...");
  const pasted = (await ctrl.onManualCodeInput?.())?.trim();
  if (!pasted) throw new Error("No auth token pasted; cannot complete Devin sign-in.");
  const result = await registerUser(pasted, region);
  return {
    ...credentialsFromApiKey(result.apiKey, "oauth"),
    ...(result.name ? { email: result.name } : {}),
    apiBaseUrl: result.apiServerUrl || DEFAULT_API_SERVER,
  };
}

export async function loginDevin(
  ctrl: OAuthController,
  opts?: { importLocal?: LocalTokenImportMode; forceLogin?: boolean },
): Promise<OAuthCredentials> {
  const importLocal = opts?.forceLogin ? "off" : (opts?.importLocal ?? "fallback");
  if (shouldImportLocal(importLocal)) {
    const local = await importLocalPiDevinAuth(ctrl.signal);
    if (local) {
      ctrl.onProgress?.("Imported Devin API key from ~/.pi/agent/auth.json");
      return local;
    }
    if (importLocal === "only") {
      throw new Error("No Devin token found at ~/.pi/agent/auth.json.");
    }
  }
  return loginDevinBrowser(ctrl, DEFAULT_REGION);
}

export async function refreshDevinToken(
  _refreshToken: string,
  _signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (credential?.access) {
    return {
      ...credential,
      refresh: credential.refresh ?? "",
      expires: Math.max(credential.expires, Date.now() + ONE_YEAR_MS),
    };
  }
  throw new Error("Devin API keys do not refresh. Run ocx login devin again.");
}

