import { validateAntigravityImportCredential } from "../google-antigravity";
import { upsertCredentialByIdentity } from "../store";
import type { OAuthCredentials } from "../types";
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
      if (typeof credential.projectId !== "string" || credential.projectId.length === 0) {
        return { status: "failed", code: "missing_project" };
      }

      throwIfAccountImportAborted(signal);
      try {
        const disposition = await deps.upsert({
          ...credential,
          email: providerEmail,
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
