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
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export const DSH_PLATFORM_ORIGIN = "https://platform.deepseek.com";
export const DSH_INFERENCE_ORIGIN = "https://api.deepseek.com/anthropic";

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { detected: false, error: message };
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
    const timeoutSignal = AbortSignal.timeout(10_000);
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

    const body = (await response.json()) as {
      code?: number;
      data?: {
        biz_code?: number;
        biz_data?: {
          id?: string | null;
          email?: string;
          mobile?: string;
          mobile_number?: string;
          id_profile?: { name?: string | null; picture?: string | null };
        };
      };
    };

    if (body.code !== 0 || !body.data?.biz_data) {
      return { valid: false, error: `Platform error code: ${body.code ?? "unknown"}` };
    }

    const biz = body.data.biz_data;
    const email = biz.email?.trim() || undefined;
    const name = biz.id_profile?.name?.trim() || undefined;
    const accountId = biz.id?.trim() || email || biz.mobile?.trim() || "dsh-user";

    return {
      valid: true,
      accountId,
      email,
      name,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("DSH login aborted", "AbortError");
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: message };
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
