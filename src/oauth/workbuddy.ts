import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthController, OAuthCredentials } from "./types";

export const WORKBUDDY_EXTERNAL_SESSION_REFRESH = "workbuddy-external-session";

const DEFAULT_DOMAIN = "www.codebuddy.cn";
const REFRESH_SKEW_MS = 60_000;

interface WorkBuddyAuthFile {
  account?: {
    uid?: unknown;
  };
  auth?: {
    accessToken?: unknown;
    domain?: unknown;
    expiresAt?: unknown;
  };
}

export interface WorkBuddySession {
  accessToken: string;
  userId: string;
  domain: string;
  expiresAt: number;
}

export interface WorkBuddyRequestIdentity {
  conversationId: string;
  requestId: string;
}

export function workBuddyAuthPath(): string {
  const override = process.env.WORKBUDDY_AUTH_FILE?.trim();
  if (override) return override;
  return join(
    homedir(),
    "Library",
    "Application Support",
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth",
    "workbuddy-desktop.info",
  );
}

function requiredHeaderValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`WorkBuddy ${label} is missing.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/u.test(normalized)) {
    throw new Error(`WorkBuddy ${label} is invalid.`);
  }
  return normalized;
}

function epochMilliseconds(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("WorkBuddy token expiry is missing or invalid.");
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function safeDomain(value: unknown): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_DOMAIN;
  if (
    candidate.length > 253
    || candidate.startsWith(".")
    || candidate.endsWith(".")
    || candidate.includes("..")
    || !/^[a-z0-9.-]+$/iu.test(candidate)
  ) throw new Error("WorkBuddy domain is invalid.");
  return candidate;
}

export function parseWorkBuddySession(raw: string): WorkBuddySession {
  let parsed: WorkBuddyAuthFile;
  try {
    parsed = JSON.parse(raw) as WorkBuddyAuthFile;
  } catch {
    throw new Error("The WorkBuddy desktop login file is not valid JSON.");
  }
  return {
    accessToken: requiredHeaderValue(parsed.auth?.accessToken, "access token", 32_768),
    userId: requiredHeaderValue(parsed.account?.uid, "user id", 1_024),
    domain: safeDomain(parsed.auth?.domain),
    expiresAt: epochMilliseconds(parsed.auth?.expiresAt),
  };
}

export function readWorkBuddySession(authFile = workBuddyAuthPath()): WorkBuddySession {
  let raw: string;
  try {
    raw = readFileSync(authFile, "utf8");
  } catch {
    throw new Error("Could not read the WorkBuddy desktop login. Open WorkBuddy and sign in first.");
  }
  return parseWorkBuddySession(raw);
}

export function credentialFromWorkBuddySession(session: WorkBuddySession): OAuthCredentials {
  return {
    access: session.accessToken,
    // Refresh remains owned by WorkBuddy. OpenCodex re-imports the desktop session
    // instead of copying or independently rotating WorkBuddy's refresh token.
    refresh: WORKBUDDY_EXTERNAL_SESSION_REFRESH,
    expires: session.expiresAt,
    accountId: session.userId,
    source: "local-cli",
  };
}

export function readWorkBuddyCredential(): OAuthCredentials {
  return credentialFromWorkBuddySession(readWorkBuddySession());
}

function assertCurrentSession(credential: OAuthCredentials): OAuthCredentials {
  if (credential.expires <= Date.now() + REFRESH_SKEW_MS) {
    throw new Error("The WorkBuddy desktop login is expired. Reopen WorkBuddy and sign in again.");
  }
  return credential;
}

export async function loginWorkBuddy(ctrl: OAuthController): Promise<OAuthCredentials> {
  ctrl.onProgress?.("Importing the current WorkBuddy desktop login...");
  return assertCurrentSession(readWorkBuddyCredential());
}

export async function refreshWorkBuddyToken(
  _refreshToken: string,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  if (signal?.aborted) throw new DOMException("WorkBuddy login refresh was aborted.", "AbortError");
  return assertCurrentSession(readWorkBuddyCredential());
}

export function buildWorkBuddyRequestHeaders(
  session = readWorkBuddySession(),
  identity: WorkBuddyRequestIdentity = {
    conversationId: randomUUID(),
    requestId: randomUUID().replaceAll("-", ""),
  },
): Record<string, string> {
  return {
    "X-User-Id": session.userId,
    "X-Domain": session.domain,
    "X-Product": "workbuddy-desktop",
    "X-IDE-Type": "workbuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-Conversation-ID": identity.conversationId,
    "X-Conversation-Request-ID": identity.requestId,
    "X-Conversation-Message-ID": identity.requestId,
    "X-Request-ID": identity.requestId,
    "X-Agent-Intent": "craft",
    "X-Private-Data": "false",
    "X-Requested-With": "XMLHttpRequest",
  };
}
