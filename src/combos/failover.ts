import { classifyError } from "../lib/errors";
import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";

interface TargetCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

/** Map<`${comboId}\0${provider/model}`, TargetCooldown> */
const targetCooldowns = new Map<string, TargetCooldown>();

function cooldownMapKey(comboId: string, target: Pick<OcxComboTarget, "provider" | "model">): string {
  return `${comboId}\0${targetKey(target)}`;
}

function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function isComboTargetInCooldown(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): boolean {
  const key = cooldownMapKey(comboId, target);
  const entry = targetCooldowns.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    targetCooldowns.delete(key);
    return false;
  }
  return true;
}

export function coolComboTarget(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  opts?: { retryAfter?: string | null; now?: number; cooldownMs?: number },
): void {
  const now = opts?.now ?? Date.now();
  const cooldownMs = opts?.cooldownMs
    ?? parseRetryAfterMs(opts?.retryAfter, now)
    ?? DEFAULT_COOLDOWN_MS;
  targetCooldowns.set(cooldownMapKey(comboId, target), {
    cooldownUntil: now + Math.min(Math.max(cooldownMs, 1), MAX_COOLDOWN_MS),
  });
}

export function clearComboTargetCooldowns(comboId?: string): void {
  if (!comboId) {
    targetCooldowns.clear();
    return;
  }
  const prefix = `${comboId}\0`;
  for (const key of targetCooldowns.keys()) {
    if (key.startsWith(prefix)) targetCooldowns.delete(key);
  }
}

export type ComboFailureDecision = "hop" | "stop";

/**
 * Decide whether a failed upstream response should advance to the next combo target.
 * Permission/subscription gates cool+hop; auth-key and request-shape errors stop the chain.
 */
export function comboFailureDecision(status: number, message: string): ComboFailureDecision {
  const classified = classifyError(status, "upstream_error", message);
  if (
    classified.code === "context_length_exceeded"
    || classified.code === "invalid_request_error"
    || classified.code === "origin_rejected"
  ) {
    return "stop";
  }
  if (classified.code === "invalid_api_key" || classified.type === "authentication_error") {
    // Bad credentials usually affect the whole provider account — hoping to another model on
    // the same key rarely helps, but another provider in the combo might. Prefer hop for 401/403
    // only when the code is permission/subscription; pure invalid_api_key still hops so a
    // misconfigured member doesn't kill the chain.
    if (status === 401 && classified.code === "invalid_api_key") return "hop";
  }
  if (
    classified.code === "permission_denied"
    || classified.code === "subscription_required"
    || classified.type === "permission_error"
  ) {
    return "hop";
  }
  if (
    status === 429
    || classified.code === "rate_limit_exceeded"
    || classified.code === "insufficient_quota"
    || classified.code === "server_is_overloaded"
    || classified.code === "upstream_server_error"
    || status >= 500
    || status === 408
  ) {
    return "hop";
  }
  // Generic 403 without a better classification — hop (plan/model gate).
  if (status === 403) return "hop";
  // Other 4xx (404 model missing on that provider, 400) — hop so the rest of the combo can try.
  if (status >= 400 && status < 500) return "hop";
  return "stop";
}
