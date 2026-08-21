import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 as win32Path } from "node:path";
import type { OAuthCredentials } from "./types";

export const WORKBUDDY_UPSTREAM_CHAT_URL = "https://www.codebuddy.cn/console/as/chat/completions";

export interface WorkBuddyNativeInputs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}

interface WorkBuddyAuthFile {
  auth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    domain?: unknown;
  };
  account?: {
    uid?: unknown;
    enterpriseId?: unknown;
  };
}

export interface WorkBuddySessionSnapshot {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expires: number;
  uid: string;
  domain?: string;
  enterpriseId?: string;
}

export interface WorkBuddyAuthHeaders extends Record<string, string> {
  Authorization: string;
  "X-User-Id": string;
  "Content-Type": string;
}

let cachedAuth: { path: string; mtimeMs: number; headers: WorkBuddyAuthHeaders } | null = null;

/** Resolve the WorkBuddy desktop OAuth session file for the current platform. */
export function resolveWorkBuddyAuthFilePath(inputs: WorkBuddyNativeInputs): string {
  const override = inputs.env.WORKBUDDY_AUTH_FILE?.trim();
  if (override) return override;
  if (inputs.platform === "darwin") {
    return join(
      inputs.home,
      "Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info",
    );
  }
  if (inputs.platform === "win32") {
    const appData = inputs.env.APPDATA?.trim()
      || (inputs.env.USERPROFILE?.trim()
        ? win32Path.join(inputs.env.USERPROFILE.trim(), "AppData", "Roaming")
        : "")
      || win32Path.join(inputs.home, "AppData", "Roaming");
    return win32Path.join(appData, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info");
  }
  const configHome = inputs.env.XDG_CONFIG_HOME?.trim() || join(inputs.home, ".config");
  return join(configHome, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info");
}

function parseExpiresAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/** Parse a WorkBuddy desktop session JSON payload into a normalized snapshot. */
export function parseWorkBuddyAuthFile(raw: string): WorkBuddySessionSnapshot | null {
  let parsed: WorkBuddyAuthFile;
  try {
    parsed = JSON.parse(raw) as WorkBuddyAuthFile;
  } catch {
    return null;
  }
  const accessToken = parsed.auth?.accessToken;
  const refreshToken = parsed.auth?.refreshToken;
  const uid = parsed.account?.uid;
  if (typeof accessToken !== "string" || !accessToken.trim()) return null;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) return null;
  if (typeof uid !== "string" || !uid.trim()) return null;
  const domain = typeof parsed.auth?.domain === "string" && parsed.auth.domain.trim()
    ? parsed.auth.domain.trim()
    : undefined;
  const enterpriseId = typeof parsed.account?.enterpriseId === "string" && parsed.account.enterpriseId.trim()
    ? parsed.account.enterpriseId.trim()
    : undefined;
  return {
    accessToken: accessToken.trim(),
    refreshToken: refreshToken.trim(),
    expires: parseExpiresAt(parsed.auth?.expiresAt),
    uid: uid.trim(),
    ...(domain ? { domain } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
  };
}

export function readWorkBuddySessionSnapshot(inputs: WorkBuddyNativeInputs): WorkBuddySessionSnapshot | null {
  const path = resolveWorkBuddyAuthFilePath(inputs);
  if (!existsSync(path)) return null;
  try {
    return parseWorkBuddyAuthFile(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function workBuddySessionToCredential(snapshot: WorkBuddySessionSnapshot): OAuthCredentials {
  return {
    access: snapshot.accessToken,
    refresh: snapshot.refreshToken,
    expires: snapshot.expires,
    accountId: snapshot.uid,
    source: "local-cli",
    workbuddy: {
      ...(snapshot.domain ? { domain: snapshot.domain } : {}),
      ...(snapshot.enterpriseId ? { enterpriseId: snapshot.enterpriseId } : {}),
    },
  };
}

export function buildWorkBuddyAuthHeaders(snapshot: WorkBuddySessionSnapshot): WorkBuddyAuthHeaders {
  const headers: WorkBuddyAuthHeaders = {
    Authorization: `Bearer ${snapshot.accessToken}`,
    "X-User-Id": snapshot.uid,
    "Content-Type": "application/json",
  };
  if (snapshot.domain) headers["X-Domain"] = snapshot.domain;
  if (snapshot.enterpriseId) {
    headers["X-Enterprise-Id"] = snapshot.enterpriseId;
    headers["X-Tenant-Id"] = snapshot.enterpriseId;
  }
  return headers;
}

export function readWorkBuddyAuthHeaders(inputs: WorkBuddyNativeInputs): WorkBuddyAuthHeaders {
  const path = resolveWorkBuddyAuthFilePath(inputs);
  if (!existsSync(path)) {
    throw new Error("WorkBuddy not logged in (auth file missing). Sign in to the WorkBuddy desktop app first.");
  }
  const stat = statSync(path);
  if (cachedAuth && cachedAuth.path === path && cachedAuth.mtimeMs === stat.mtimeMs) {
    return cachedAuth.headers;
  }
  const snapshot = readWorkBuddySessionSnapshot(inputs);
  if (!snapshot) throw new Error("Invalid WorkBuddy desktop session");
  const headers = buildWorkBuddyAuthHeaders(snapshot);
  cachedAuth = { path, mtimeMs: stat.mtimeMs, headers };
  return headers;
}

/** Test hook: clear the in-process auth header cache. */
export function resetWorkBuddyAuthCache(): void {
  cachedAuth = null;
}

export function runtimeWorkBuddyNativeInputs(): WorkBuddyNativeInputs {
  const home = process.platform === "win32"
    ? (process.env.USERPROFILE || homedir())
    : (process.env.HOME || homedir());
  return { env: process.env, platform: process.platform, home };
}
