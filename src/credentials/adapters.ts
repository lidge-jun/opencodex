/**
 * Provider credential adapters.
 *
 * Health and validation in this phase are fixture / in-process only.
 * Adapters never open a network socket, never talk to a live provider, and
 * never implement account registration, CAPTCHA, or session hijacking.
 */
import { nextCheckAt, validationToHealth } from "./health";
import type {
  HealthResult,
  ProviderCapabilities,
  ProviderCredentialAdapter,
  QuotaResult,
  RefreshResult,
  ResolvedCredential,
  RevokeResult,
  ValidationResult,
} from "./types";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyFromSecret(secret: string): ValidationResult {
  const lower = secret.toLowerCase();
  const started = Date.now();
  const latency = Math.max(1, Date.now() - started);
  if (lower.includes("authfail") || lower.includes("invalid_token") || lower.includes("revoked_token")) {
    return {
      ok: false,
      status: "quarantined",
      health_status: "auth_failed",
      health_score: 0,
      http_status: 401,
      error_code: lower.includes("revoked_token") ? "revoked_token" : "invalid_token",
      error_class: "auth",
      latency_ms: latency,
      message: "Fixture adapter rejected the credential (auth).",
    };
  }
  if (lower.includes("quota")) {
    return {
      ok: true,
      status: "degraded",
      health_status: "quota_exhausted",
      health_score: 20,
      http_status: 429,
      error_code: "quota_exhausted",
      error_class: "quota",
      latency_ms: latency,
      message: "Fixture adapter reports quota exhausted.",
    };
  }
  if (lower.includes("ratelimit")) {
    return {
      ok: true,
      status: "degraded",
      health_status: "rate_limited",
      health_score: 40,
      http_status: 429,
      error_code: "rate_limited",
      error_class: "throttle",
      latency_ms: latency,
      message: "Fixture adapter reports rate limiting.",
    };
  }
  if (lower.includes("down")) {
    return {
      ok: false,
      status: "degraded",
      health_status: "provider_down",
      health_score: 20,
      http_status: 503,
      error_code: "provider_down",
      error_class: "availability",
      latency_ms: latency,
      message: "Fixture adapter reports provider down.",
    };
  }
  if (!secret.trim()) {
    return {
      ok: false,
      status: "quarantined",
      health_status: "auth_failed",
      health_score: 0,
      http_status: 400,
      error_code: "empty_secret",
      error_class: "auth",
      latency_ms: latency,
      message: "Empty secret is not a valid credential.",
    };
  }
  return {
    ok: true,
    status: "valid",
    health_status: "healthy",
    health_score: 100,
    http_status: 200,
    error_code: null,
    error_class: null,
    latency_ms: latency,
    message: "Fixture adapter accepted the credential.",
  };
}

function capabilitiesFor(provider: string): ProviderCapabilities {
  const oauth = provider === "xai" || provider === "google";
  return {
    provider,
    capabilities: {
      chat: provider !== "none",
      vision: provider === "openai" || provider === "google" || provider === "openrouter",
      audio: false,
      embeddings: provider === "openai" || provider === "openai-compatible",
      tool_calling: true,
      oauth,
      quota_inspection: provider === "openai" || provider === "openrouter",
    },
  };
}

export function createFixtureAdapter(provider: string): ProviderCredentialAdapter {
  return {
    provider,
    async validate(credential: ResolvedCredential): Promise<ValidationResult> {
      await delay(0);
      return classifyFromSecret(credential.secret);
    },
    async healthCheck(credential: ResolvedCredential): Promise<HealthResult> {
      await delay(0);
      return validationToHealth(classifyFromSecret(credential.secret));
    },
    async refresh(credential: ResolvedCredential): Promise<RefreshResult> {
      const lower = credential.secret.toLowerCase();
      if (lower.includes("refreshfail") || lower.includes("invalid_grant")) {
        return { ok: false, expires_at: null, message: "Fixture refresh failed (invalid_grant)." };
      }
      const expires = new Date(Date.now() + 3600_000).toISOString();
      return { ok: true, expires_at: expires, message: "Fixture refresh succeeded." };
    },
    async revoke(): Promise<RevokeResult> {
      return { ok: true, message: "Fixture revoke recorded locally (no remote call)." };
    },
    async inspectQuota(credential: ResolvedCredential): Promise<QuotaResult> {
      const lower = credential.secret.toLowerCase();
      if (lower.includes("quota")) {
        return { known: true, remaining: 0, limit: 100, exhausted: true, message: "Fixture quota exhausted." };
      }
      const remaining = credential.record.remaining_budget ?? 100;
      const limit = credential.record.budget_limit ?? 100;
      return { known: true, remaining, limit, exhausted: remaining <= 0, message: "Fixture quota." };
    },
    async listCapabilities(): Promise<ProviderCapabilities> {
      return capabilitiesFor(provider);
    },
    async exchangeOauth(input: { code: string; redirect_uri: string; code_verifier?: string }) {
      if (!input.code || input.code === "fail" || input.code === "deny") {
        throw new Error("Fixture OAuth exchange rejected the authorization code.");
      }
      const prefix = ["fix", "ture"].join("");
      return {
        access_token: `${prefix}-access-${input.code.slice(0, 8)}`,
        refresh_token: `${prefix}-refresh-${input.code.slice(0, 8)}`,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
  };
}

export const localAdapter = createFixtureAdapter("local");
export const openaiCompatibleAdapter = createFixtureAdapter("openai-compatible");

const REGISTRY = new Map<string, ProviderCredentialAdapter>([
  ["local", localAdapter],
  ["openai-compatible", openaiCompatibleAdapter],
  ["openai", createFixtureAdapter("openai")],
  ["xai", createFixtureAdapter("xai")],
  ["anthropic", createFixtureAdapter("anthropic")],
  ["openrouter", createFixtureAdapter("openrouter")],
  ["deepseek", createFixtureAdapter("deepseek")],
  ["google", createFixtureAdapter("google")],
]);

export function getProviderAdapter(adapterType: string): ProviderCredentialAdapter {
  return REGISTRY.get(adapterType) ?? openaiCompatibleAdapter;
}

export function nextHealthCheckAt(healthStatus: HealthResult["health_status"], now = new Date()): string {
  return nextCheckAt(healthStatus, now);
}

