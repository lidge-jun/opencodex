import type { AdapterType, CredentialStatus, HealthStatus, SensitiveAction } from "./types";

export const FEATURE_FLAG_ENV = "CREDENTIAL_RUNTIME_ENABLED";
export const MASTER_KEY_ENV = "CREDENTIAL_MASTER_KEY";
export const MASTER_KEY_ID_ENV = "CREDENTIAL_MASTER_KEY_ID";
export const HEALTH_ENABLED_ENV = "CREDENTIAL_HEALTH_ENABLED";
export const HEALTH_INTERVAL_ENV = "CREDENTIAL_HEALTH_INTERVAL_SECONDS";
export const EXPIRY_WATCH_ENV = "CREDENTIAL_EXPIRY_WATCH_ENABLED";
export const OAUTH_CALLBACK_BASE_ENV = "OAUTH_CALLBACK_BASE_URL";
export const LEASE_TTL_ENV = "CREDENTIAL_LEASE_DEFAULT_TTL_SECONDS";
export const POLICY_DEFAULT_ENV = "CREDENTIAL_POLICY_DEFAULT";
export const AUDIT_ENABLED_ENV = "CREDENTIAL_AUDIT_ENABLED";
export const LEGACY_FALLBACK_ENV = "ALLOW_LEGACY_SECRET_FALLBACK";
export const DB_PATH_ENV = "PAO_CREDENTIAL_DB_PATH";

export const DEFAULT_LEASE_TTL_SECONDS = 300;
export const DEFAULT_APPROVAL_TTL_MINUTES = 30;
export const DEFAULT_OAUTH_TTL_SECONDS = 600;
export const DEFAULT_HEALTH_INTERVAL_SECONDS = 900;
export const AUTH_FAILURE_QUARANTINE_THRESHOLD = 3;
export const CIRCUIT_OPEN_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 60_000;
export const MASK_PLACEHOLDER = "********";

export const LEGAL_STATUS_TRANSITIONS: Record<CredentialStatus, readonly CredentialStatus[]> = {
  new: ["validating", "disabled", "revoked"],
  validating: ["valid", "quarantined", "disabled", "revoked"],
  valid: ["active", "quarantined", "disabled", "revoked", "expired", "validating", "rotating"],
  active: ["degraded", "quarantined", "expired", "revoked", "rotating", "disabled", "validating"],
  degraded: ["active", "quarantined", "disabled", "revoked", "expired", "validating", "rotating"],
  rotating: ["active", "degraded", "quarantined", "revoked", "disabled", "validating"],
  quarantined: ["disabled", "revoked", "validating"],
  expired: ["revoked", "disabled", "validating"],
  revoked: ["disabled"],
  disabled: ["validating"],
};

export const ROUTING_ELIGIBLE_STATUSES: readonly CredentialStatus[] = ["active", "degraded"];

export const NO_CHECK_HEALTH: readonly HealthStatus[] = ["auth_failed"];
export const NO_CHECK_STATUS: readonly CredentialStatus[] = ["expired", "revoked", "disabled", "quarantined"];

export const SENSITIVE_ACTIONS: readonly SensitiveAction[] = [
  "credential.export",
  "credential.revoke",
  "credential.delete",
  "credential.rotate",
  "vault.reveal",
  "policy.override",
  "provider.disable",
  "bulk.import",
];

export const SEEDED_PROVIDERS: ReadonlyArray<{
  slug: string;
  name: string;
  adapter_type: AdapterType;
  oauth_supported: boolean;
  quota_inspection_supported: boolean;
  revocation_supported: boolean;
}> = [
  { slug: "openai", name: "OpenAI", adapter_type: "openai", oauth_supported: false, quota_inspection_supported: true, revocation_supported: false },
  { slug: "xai", name: "xAI", adapter_type: "xai", oauth_supported: true, quota_inspection_supported: false, revocation_supported: false },
  { slug: "anthropic", name: "Anthropic", adapter_type: "anthropic", oauth_supported: false, quota_inspection_supported: false, revocation_supported: false },
  { slug: "openrouter", name: "OpenRouter", adapter_type: "openrouter", oauth_supported: false, quota_inspection_supported: true, revocation_supported: false },
  { slug: "deepseek", name: "DeepSeek", adapter_type: "deepseek", oauth_supported: false, quota_inspection_supported: false, revocation_supported: false },
  { slug: "google", name: "Google", adapter_type: "google", oauth_supported: true, quota_inspection_supported: false, revocation_supported: true },
  { slug: "openai-compatible", name: "OpenAI Compatible", adapter_type: "openai-compatible", oauth_supported: false, quota_inspection_supported: false, revocation_supported: false },
  { slug: "local", name: "Local", adapter_type: "local", oauth_supported: false, quota_inspection_supported: false, revocation_supported: false },
];

export const HEALTH_INTERVAL_SECONDS: Record<HealthStatus, number> = {
  unknown: 900,
  healthy: 900,
  warning: 300,
  degraded: 120,
  unhealthy: 120,
  rate_limited: 120,
  quota_exhausted: 600,
  auth_failed: 0,
  provider_down: 180,
};

export const TRANSIENT_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
export const AUTH_HTTP_STATUS = new Set([400, 401, 403]);
export const AUTH_ERROR_CODES = new Set(["invalid_grant", "invalid_token", "revoked_token"]);

export const REDACT_KEYS = [
  "authorization",
  "bearer",
  "api_key",
  "access_token",
  "refresh_token",
  "cookie",
  "session",
  "client_secret",
  "secret",
  "password",
  "token",
];

