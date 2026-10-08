import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getConfigPath } from "../config/paths";
import { anthropicInstanceRowShapeMatches, type AnthropicInstanceId, type AnthropicInstanceRow } from "../providers/anthropic-instance-id";
import type { OcxConfig } from "../types";
import { normalizeAnthropicIdentity } from "./anthropic-identity";
import type { AuthStore } from "./store";
import type { OAuthCredentials } from "./types";

export class AnthropicCrossInstanceDuplicateError extends Error {
  readonly code = "ANTHROPIC_CROSS_INSTANCE_DUPLICATE";
  constructor() {
    super("This Anthropic credential is already registered in the other pool; use a different account or remove the existing registration first.");
    this.name = "AnthropicCrossInstanceDuplicateError";
  }
}

export class AnthropicLocalCliImportError extends Error {
  readonly code = "ANTHROPIC_LOCAL_CLI_IMPORT_FORBIDDEN";
  constructor() {
    super("Anthropic Pool 2 supports browser OAuth only; local Claude Code credentials cannot be imported or adopted.");
    this.name = "AnthropicLocalCliImportError";
  }
}

export class AnthropicInstanceCollisionError extends Error {
  readonly code = "ANTHROPIC_INSTANCE_COLLISION";
  constructor(credentialWritten = false) {
    super("anthropic2 is already configured as a custom provider; rename the custom provider before logging in to Pool 2."
      + (credentialWritten ? " The saved Pool 2 credential remains an orphan auth row; remove it or rename the custom provider before retrying." : ""));
    this.name = "AnthropicInstanceCollisionError";
  }
}

export function assertAnthropicInstanceLoginConfig(config: Pick<OcxConfig, "providers">, provider: string, credentialWritten = false): void {
  if (provider !== "anthropic2") return;
  const row = config.providers.anthropic2;
  if (Object.hasOwn(config.providers, provider) && !anthropicInstanceRowShapeMatches(provider, row)) {
    throw new AnthropicInstanceCollisionError(credentialWritten);
  }
  // A malformed custom row (for example, missing baseUrl) can disappear behind loadConfig's
  // fallback. Raw presence still owns this namespace; onboarding must not overwrite its bytes.
  let raw: string;
  try { raw = readFileSync(getConfigPath(), "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw new Error("Cannot verify Anthropic Pool 2 ownership in the existing config file.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { throw new Error("Cannot verify Anthropic Pool 2 ownership in the existing config file."); }
  const providers = parsed && typeof parsed === "object" && "providers" in parsed ? parsed.providers : undefined;
  if (providers && typeof providers === "object" && Object.hasOwn(providers, provider)) {
    const persisted = (providers as Record<string, unknown>)[provider];
    if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)
      || !anthropicInstanceRowShapeMatches(provider, persisted as AnthropicInstanceRow)) {
      throw new AnthropicInstanceCollisionError(credentialWritten);
    }
  }
}

export function assertAnthropicCredentialSource(instance: AnthropicInstanceId, credential: OAuthCredentials): void {
  if (instance === "anthropic2" && credential.source === "local-cli") throw new AnthropicLocalCliImportError();
}

function tokenFingerprint(token: string): string | undefined {
  return token.length > 0 ? createHash("sha256").update(token).digest("hex") : undefined;
}

/** Registration only, called under the auth-store writer lock before any row changes. */
export function assertNoCrossAnthropicRegistration(store: AuthStore, instance: AnthropicInstanceId, credential: OAuthCredentials): void {
  assertAnthropicCredentialSource(instance, credential);
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  const tokens = new Set([tokenFingerprint(credential.access), tokenFingerprint(credential.refresh)]
    .filter((fingerprint): fingerprint is string => fingerprint !== undefined));
  const identity = normalizeAnthropicIdentity(credential.anthropicIdentity, credential.access);
  // Paused, needs-reauth and orphan rows retain ownership; labels are never proof.
  for (const row of store[other]?.accounts ?? []) {
    const access = tokenFingerprint(row.credential.access);
    const refresh = tokenFingerprint(row.credential.refresh);
    const existingIdentity = normalizeAnthropicIdentity(row.credential.anthropicIdentity, row.credential.access);
    if ((access !== undefined && tokens.has(access)) || (refresh !== undefined && tokens.has(refresh))
      || (identity && existingIdentity && identity.accountUuid === existingIdentity.accountUuid)) {
      throw new AnthropicCrossInstanceDuplicateError();
    }
  }
}
