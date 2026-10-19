import { validateAntigravityImportCredential } from "../google-antigravity";
import { upsertCredentialByIdentity } from "../store";
import type { OAuthCredentials } from "../types";
import { probeAntigravityUsageQuota } from "../../providers/quota/antigravity";
import {
  ACCOUNT_IMPORT_FORMAT,
  ACCOUNT_IMPORT_MAX_EMAIL_LENGTH,
  ACCOUNT_IMPORT_PROVIDER,
  throwIfAccountImportAborted,
  type AccountImportAdapter,
  type CockpitAccountRecord,
  type ValidatedAntigravityCredential,
} from "./types";

export interface AntigravityImportAdapterDeps {
  validate(refreshToken: string, signal?: AbortSignal): Promise<ValidatedAntigravityCredential>;
  upsert(credential: OAuthCredentials): Promise<"inserted" | "updated">;
  /**
   * Prove that the freshly validated account token can use an operator-supplied project.
   * Without this owner a fallback project is never admitted.
   */
  verifyProject?(accessToken: string, projectId: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * The account-bound admission probe for a fallback project: the same Cloud Code Assist quota
 * probe the account pool runs, authenticated with this account's own access token against the
 * named project. Only a parsed quota answer admits it; denial, rate limiting, transport failure
 * or an unusable body all keep the record out.
 */
export async function verifyAntigravityImportProject(accessToken: string, projectId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    return (await probeAntigravityUsageQuota(accessToken, projectId, signal)).kind === "available" && !signal?.aborted;
  } catch {
    return false;
  }
}

function safeProviderEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (
    normalized.length === 0
    || normalized.length > ACCOUNT_IMPORT_MAX_EMAIL_LENGTH
    || normalized !== normalized.trim()
    || /[\x00-\x20\x7f]/.test(normalized)
  ) return null;
  return normalized;
}

export function createAntigravityAccountImportAdapter(
  deps: AntigravityImportAdapterDeps = {
    validate: validateAntigravityImportCredential,
    upsert: credential => upsertCredentialByIdentity(ACCOUNT_IMPORT_PROVIDER, credential),
    verifyProject: verifyAntigravityImportProject,
  },
): AccountImportAdapter {
  return {
    provider: ACCOUNT_IMPORT_PROVIDER,
    format: ACCOUNT_IMPORT_FORMAT,
    async importRecord(record: CockpitAccountRecord, signal?: AbortSignal) {
      throwIfAccountImportAborted(signal);
      let credential: ValidatedAntigravityCredential;
      try {
        credential = await deps.validate(record.refreshToken, signal);
      } catch {
        throwIfAccountImportAborted(signal);
        return { status: "failed", code: "credential_rejected" };
      }

      throwIfAccountImportAborted(signal);

      const providerEmail = safeProviderEmail(credential.email);
      if (!providerEmail) return { status: "failed", code: "credential_rejected" };
      if (providerEmail !== record.email) return { status: "failed", code: "identity_mismatch" };
      // Automatic discovery wins: a discovered project is used as-is and the record's project_id
      // is ignored. The record's project is a fallback only, admitted after an account-bound probe.
      let projectId = typeof credential.projectId === "string" && credential.projectId.length > 0
        ? credential.projectId
        : undefined;
      if (!projectId && record.projectId && deps.verifyProject) {
        let admitted = false;
        try {
          admitted = await deps.verifyProject(credential.access, record.projectId, signal);
        } catch {
          admitted = false;
        }
        throwIfAccountImportAborted(signal);
        if (admitted) projectId = record.projectId;
      }
      if (!projectId) return { status: "failed", code: "missing_project" };

      throwIfAccountImportAborted(signal);
      try {
        const disposition = await deps.upsert({
          ...credential,
          email: providerEmail,
          projectId,
          source: "credential-file",
        });
        return disposition === "updated"
          ? { status: "updated", code: "updated" }
          : { status: "imported", code: "imported" };
      } catch {
        return { status: "failed", code: "persist_failed" };
      }
    },
  };
}
