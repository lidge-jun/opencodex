/**
 * DeepSeek Harness Account OAuth implementation (Import-first).
 *
 * Imports existing authenticated account from DeepSeek Harness Desktop
 * (`$DSH_HOME/.credentials.yaml`, default `~/.dsh/.credentials.yaml`).
 *
 * Invariant: The DSH credential store is strictly READ-ONLY to OpenCodeX.
 * OpenCodeX NEVER mutates, overwrites, deletes, or changes permissions of `~/.dsh/.credentials.yaml`.
 */

import type { OAuthController, OAuthCredentials } from "./types";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export const DSH_PLATFORM_ORIGIN = "https://platform.deepseek.com";
export const DSH_INFERENCE_ORIGIN = "https://api.deepseek.com/anthropic";

/**
 * Byte ceiling for the profile document returned by /auth-api/v0/users/current.
 *
 * A legitimate profile is a small fixed-shape JSON object (code, data.biz_code,
 * biz_data.id/email/id_profile{name,picture}) well under a few KiB; 64 KiB matches
 * the shared bounded-body ceiling and still leaves orders of magnitude of
 * headroom. Anything larger is rejected before parsing so a hostile or broken
 * upstream cannot turn an import validation into unbounded memory work.
 */
export const DSH_PROFILE_MAX_BYTES = 64 * 1024;

/** Wall-clock budget for the profile request and its body read, in milliseconds. */
const DSH_PROFILE_FETCH_TIMEOUT_MS = 10_000;

export interface DshAccountDetectionResult {
  detected: boolean;
  token?: string;
  issuer?: string;
  error?: string;
}

export interface DshValidatedAccountIdentity {
  valid: boolean;
  accountId?: string;
  email?: string;
  name?: string;
  error?: string;
}

export function resolveDshCredentialsPath(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(dshHome, ".credentials.yaml");
}

/**
 * Pure read-only probe to detect whether DeepSeek Harness Desktop is installed
 * and signed in on this machine.
 * NEVER writes, creates, mutates, or deletes any file.
 */
export function detectDshAccount(): DshAccountDetectionResult {
  const filePath = resolveDshCredentialsPath();
  if (!existsSync(filePath)) {
    return { detected: false };
  }
  try {
    const content = readFileSync(filePath, "utf8");
    const data = Bun.YAML.parse(content) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      return { detected: false };
    }
    const records = data.records as Record<string, unknown> | undefined;
    const accountRecord = records?.["deepseek-account-platform/default"] as {
      kind?: string;
      payload?: { version?: number; token?: string; issuer?: string };
    } | undefined;

    if (accountRecord?.kind === "grant" && typeof accountRecord.payload?.token === "string" && accountRecord.payload.token.length > 0) {
      return {
        detected: true,
        token: accountRecord.payload.token,
        issuer: accountRecord.payload.issuer ?? DSH_PLATFORM_ORIGIN,
      };
    }
    return { detected: false };
  } catch {
    return { detected: false, error: "CREDENTIAL_FILE_READ_FAILED" };
  }
}

/**
 * Validate token against DeepSeek's authoritative profile endpoint:
 * GET https://platform.deepseek.com/auth-api/v0/users/current
 */
export async function validateDshAccountToken(
  token: string,
  signal?: AbortSignal,
): Promise<DshValidatedAccountIdentity> {
  try {
    const timeoutSignal = AbortSignal.timeout(DSH_PROFILE_FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(`${DSH_PLATFORM_ORIGIN}/auth-api/v0/users/current`, {
      method: "GET",
      headers: {
        "x-dsh-auth-token": token,
        "accept": "application/json",
      },
      redirect: "manual",
      signal: combinedSignal,
    });

    if (response.status === 401) {
      return { valid: false, error: "ACCOUNT_TOKEN_INVALID" };
    }
    if (!response.ok) {
      return { valid: false, error: `Platform returned HTTP ${response.status}` };
    }

    // A declared length past the cap is rejected without touching the stream.
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > DSH_PROFILE_MAX_BYTES) {
      try {
        void response.body?.cancel(
          new DOMException("DSH profile response is too large", "QuotaExceededError"),
        ).catch(() => undefined);
      } catch {
        // Best-effort cancellation only.
      }
      return { valid: false, error: "PROFILE_VALIDATION_FAILED" };
    }

    // Missing or understated Content-Length still meets the cap on the decoded
    // stream itself: once an over-limit byte is observed the retained buffer is
    // discarded and cancellation is requested on the body. Malformed UTF-8 fails
    // closed so a replacement character can never alter the authoritative ID.
    const bounded = await readBoundedResponseBody(response, {
      signal: combinedSignal,
      maxBytes: DSH_PROFILE_MAX_BYTES,
      totalTimeoutMs: DSH_PROFILE_FETCH_TIMEOUT_MS,
      inactivityTimeoutMs: DSH_PROFILE_FETCH_TIMEOUT_MS,
      fatalUtf8: true,
    });
    if (bounded.oversized || bounded.truncated || !bounded.displaySafe) {
      return { valid: false, error: "PROFILE_VALIDATION_FAILED" };
    }

    const body = JSON.parse(bounded.text) as {
      code?: number;
      data?: {
        biz_code?: number;
        biz_data?: {
          id?: string | null;
          email?: string;
          id_profile?: { name?: string | null; picture?: string | null };
        };
      };
    };

    if (body.code !== 0 || body.data?.biz_code !== 0 || !body.data.biz_data) {
      return { valid: false, error: `Platform error code: ${body.code ?? "unknown"}` };
    }

    const biz = body.data.biz_data;
    // Account-store slot matching and reauthentication require the same stable upstream ID.
    // Email/phone/display names and a shared fallback must never identify an imported account.
    const accountId = typeof biz.id === "string" ? biz.id.trim() : "";
    if (!accountId) return { valid: false, error: "ACCOUNT_IDENTITY_UNVERIFIED" };
    const email = typeof biz.email === "string" ? biz.email.trim() || undefined : undefined;
    const name = typeof biz.id_profile?.name === "string" ? biz.id_profile.name.trim() || undefined : undefined;

    return {
      valid: true,
      accountId,
      email,
      name,
    };
  } catch {
    if (signal?.aborted) throw signal.reason ?? new DOMException("DSH login aborted", "AbortError");
    // Parser and transport errors may contain profile data or credential-file contents.
    return { valid: false, error: "PROFILE_VALIDATION_FAILED" };
  }
}

export interface DshLoginOptions {
  forceLogin?: boolean;
}

/**
 * Explicit user login action for DSH Account.
 * Reuses the existing DSH local credential after live authoritative validation.
 */
export async function loginDshAccount(
  ctrl: OAuthController,
  _opts: DshLoginOptions = {},
): Promise<OAuthCredentials> {
  if (ctrl.signal?.aborted) {
    throw ctrl.signal.reason ?? new DOMException("DSH login aborted", "AbortError");
  }

  const detection = detectDshAccount();
  if (!detection.detected || !detection.token) {
    throw new Error(
      "DeepSeek Harness account not found in ~/.dsh/.credentials.yaml. " +
      "Please sign in to DeepSeek Harness Desktop first, then import your account.",
    );
  }

  const validation = await validateDshAccountToken(detection.token, ctrl.signal);
  if (!validation.valid || !validation.accountId) {
    throw new Error(
      `DeepSeek Harness account token in ~/.dsh/.credentials.yaml is invalid or expired (${validation.error ?? "unknown"}). ` +
      "Please re-login in DeepSeek Harness Desktop, then try again.",
    );
  }

  return {
    access: detection.token,
    refresh: detection.token,
    expires: Number.MAX_SAFE_INTEGER,
    accountId: validation.accountId,
    email: validation.email,
    source: "credential-file",
  };
}

/**
 * Token refresh for DSH Account.
 * DSH accounts use long-lived session grant tokens without an automatic rotation endpoint.
 * In accordance with the explicit-import contract, background or automatic refresh MUST NOT
 * automatically re-read or adopt new credentials from ~/.dsh/.credentials.yaml.
 * If the grant is rejected or expires, this throws a terminal error so the account transitions
 * to needsReauth, requiring explicit user re-import.
 */
export async function refreshDshAccountToken(
  _refreshToken: string,
  _signal?: AbortSignal,
  _credential?: OAuthCredentials,
  _accountId?: string,
): Promise<OAuthCredentials> {
  throw new Error("DeepSeek Harness account session expired or revoked. Please sign in to DeepSeek Harness Desktop and re-import.");
}

/** Provider-owned auth hooks keep the shared OAuth registry within its line budget. */
export const DSH_ACCOUNT_AUTH = {
  login: loginDshAccount,
  refresh: refreshDshAccountToken,
  defaultRefreshPolicy: "disabled" as const,
};
