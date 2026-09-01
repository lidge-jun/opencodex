/**
 * Qoder CN OAuth flow (device authorization grant with PKCE).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
const DEFAULT_OPENAPI_HOST = "https://openapi.qoder.com.cn";
const DEFAULT_AUTH_HOST = "https://qoder.cn";
const MACHINE_ID_FILENAME = "qodercn-machine-id";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface QoderDevicePollResponse {
  token?: string;
  device_token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
  refresh_token_expires_at?: string;
  refresh_token_expires_in?: number;
  user_id?: string;
  user_name?: string;
  email?: string;
}

interface QoderTokenRefreshResponse {
  device_token?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
}

export function getMachineId(): string {
  const p = join(getConfigDir(), MACHINE_ID_FILENAME);
  try {
    if (existsSync(p)) {
      const id = readFileSync(p, "utf-8").trim();
      if (id) return id;
    }
  } catch (e) {
    if ((e as { code?: string })?.code !== "ENOENT") throw e;
  }
  const id = randomUUID();
  recordOwnedConfigPath(getConfigDir(), p);
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(p, id + "\n", { mode: 0o600 });
  return id;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("Login cancelled"));
    }, { once: true });
  });
}

async function pollForToken(nonce: string, verifier: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const search = new URLSearchParams({
    nonce,
    verifier,
    challenge_method: "S256",
  });
  const url = `${DEFAULT_OPENAPI_HOST}/api/v1/deviceToken/poll?${search}`;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (res.status === 404) {
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Qoder device token poll failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as QoderDevicePollResponse;
    const token = data.token || data.device_token;
    if (!token) throw new Error("Qoder poll response missing token");

    let expires = Date.now() + 24 * 3600 * 1000;
    if (typeof data.expires_at === "string") {
      const parsed = new Date(data.expires_at).getTime();
      if (Number.isFinite(parsed) && parsed > 0) expires = parsed - OAUTH_EXPIRY_SKEW_MS;
    } else if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in)) {
      expires = Date.now() + data.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS;
    }

    const accountId = data.user_id;
    const email = data.user_name || data.email;

    return {
      access: token,
      refresh: data.refresh_token || token,
      expires,
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
      source: "oauth",
    };
  }
  throw new Error("Qoder CN device authorization timed out");
}

export async function loginQoderCn(ctrl: OAuthController): Promise<OAuthCredentials> {
  const { verifier, challenge } = generatePKCE();
  const nonce = randomUUID();
  const machineId = getMachineId();
  const authUrl = `${DEFAULT_AUTH_HOST}/device/selectAccounts?challenge=${challenge}&challenge_method=S256&nonce=${nonce}&machine_id=${machineId}&client_id=${CLIENT_ID}`;

  ctrl.onAuth?.({
    url: authUrl,
    instructions: "Please complete the login in your browser",
  });

  return pollForToken(nonce, verifier, ctrl.signal);
}

export async function refreshQoderCnToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  const res = await fetch(`${DEFAULT_OPENAPI_HOST}/api/v1/deviceToken/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Qoder token refresh failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as QoderTokenRefreshResponse;
  const token = data.device_token || data.token;
  if (!token) throw new Error("Qoder refresh response missing token");
  let expires = Date.now() + 24 * 3600 * 1000;
  if (typeof data.expires_at === "string") {
    const parsed = new Date(data.expires_at).getTime();
    if (Number.isFinite(parsed) && parsed > 0) expires = parsed - OAUTH_EXPIRY_SKEW_MS;
  } else if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in)) {
    expires = Date.now() + data.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS;
  }
  return { access: token, refresh: data.refresh_token || refreshToken, expires, source: "oauth" };
}

export function resolveQoderAccountContext(token: string): { machineId: string; accountId: string } {
  const machineId = getMachineId();
  let accountId = "";
  try {
    const authPath = join(getConfigDir(), "auth.json");
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      const accounts = auth.qodercn?.accounts || [];
      const match = accounts.find((a: any) => a.credential?.access === token);
      if (match?.credential?.accountId) {
        accountId = match.credential.accountId;
      } else if (accounts[0]?.credential?.accountId) {
        accountId = accounts[0].credential.accountId;
      }
    }
  } catch (_e) {
    void _e;
  }
  return { machineId, accountId: accountId || "default-user" };
}
