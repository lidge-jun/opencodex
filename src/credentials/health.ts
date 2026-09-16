import { HEALTH_INTERVAL_SECONDS } from "./constants";
import type { HealthResult, HealthStatus, ValidationResult } from "./types";

export interface HealthScoreInput {
  authOk: boolean;
  reachable: boolean;
  latencyMs: number | null;
  rateLimited: boolean;
  quotaExhausted: boolean;
  consecutiveFailures: number;
  expired: boolean;
  successRatio: number;
}

export function classifyHealth(input: HealthScoreInput): HealthStatus {
  if (input.expired) return "unhealthy";
  if (!input.authOk) return "auth_failed";
  if (input.quotaExhausted) return "quota_exhausted";
  if (input.rateLimited) return "rate_limited";
  if (!input.reachable) return "provider_down";
  if (input.consecutiveFailures >= 5) return "unhealthy";
  if (input.consecutiveFailures >= 2 || (input.latencyMs ?? 0) > 5_000) return "degraded";
  if (input.successRatio < 0.9 || (input.latencyMs ?? 0) > 1_500) return "warning";
  return "healthy";
}

export function scoreHealth(input: HealthScoreInput): number {
  const status = classifyHealth(input);
  if (status === "auth_failed" || status === "unhealthy" || input.expired) return 0;
  if (status === "provider_down") return 20;
  if (status === "quota_exhausted") return 20;
  if (status === "rate_limited") return 40;
  if (status === "degraded") return 60;
  if (status === "warning") return 80;
  let score = 100;
  if ((input.latencyMs ?? 0) > 800) score -= 10;
  if (input.successRatio < 0.99) score -= 5;
  return Math.max(0, Math.min(100, score));
}

export function nextCheckAt(status: HealthStatus, now = new Date(), jitterRatio = 0.2): string {
  const base = HEALTH_INTERVAL_SECONDS[status] ?? 900;
  if (base <= 0) return now.toISOString();
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
  const ms = Math.max(1, Math.round(base * 1000 * jitter));
  return new Date(now.getTime() + ms).toISOString();
}

export function validationToHealth(result: ValidationResult, now = new Date()): HealthResult {
  return {
    ...result,
    next_check_at: nextCheckAt(result.health_status, now),
  };
}

