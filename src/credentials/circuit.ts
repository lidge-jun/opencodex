import { CIRCUIT_COOLDOWN_MS, CIRCUIT_OPEN_THRESHOLD } from "./constants";
import type { CircuitBreakerRow, CircuitState } from "./types";

export function breakerId(providerId: string, credentialId: string | null): string {
  return `brk_${providerId}_${credentialId ?? "provider"}`;
}

export function initialBreaker(providerId: string, credentialId: string | null, now = new Date()): CircuitBreakerRow {
  return {
    id: breakerId(providerId, credentialId),
    provider_id: providerId,
    credential_id: credentialId,
    state: "closed",
    failure_count: 0,
    opened_at: null,
    cooldown_until: null,
    updated_at: now.toISOString(),
  };
}

export function recordCircuitFailure(current: CircuitBreakerRow, now = new Date()): CircuitBreakerRow {
  const failures = current.failure_count + 1;
  if (failures >= CIRCUIT_OPEN_THRESHOLD) {
    return {
      ...current,
      state: "open",
      failure_count: failures,
      opened_at: now.toISOString(),
      cooldown_until: new Date(now.getTime() + CIRCUIT_COOLDOWN_MS).toISOString(),
      updated_at: now.toISOString(),
    };
  }
  return { ...current, failure_count: failures, updated_at: now.toISOString() };
}

export function recordCircuitSuccess(current: CircuitBreakerRow, now = new Date()): CircuitBreakerRow {
  if (current.state === "half_open" || current.state === "open") {
    return {
      ...current,
      state: "closed",
      failure_count: 0,
      opened_at: null,
      cooldown_until: null,
      updated_at: now.toISOString(),
    };
  }
  return { ...current, failure_count: 0, updated_at: now.toISOString() };
}

export function maybeHalfOpen(current: CircuitBreakerRow, now = new Date()): CircuitBreakerRow {
  if (current.state !== "open" || !current.cooldown_until) return current;
  if (Date.parse(current.cooldown_until) > now.getTime()) return current;
  return { ...current, state: "half_open", updated_at: now.toISOString() };
}

export function isCircuitBlocking(state: CircuitState): boolean {
  return state === "open";
}

