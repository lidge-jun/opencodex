import { estimateTokens } from "../lib/token-estimate";
import type { OcxComboConfig, OcxComboTarget, OcxConfig, OcxEconomicAllowance, OcxEconomicSnapshot } from "../types";
import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";
import { targetKey } from "./types";
type EconomicTarget = OcxComboTarget & { weight: number };

export interface EconomicRequestEstimate {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  fixedRequests?: number;
  kind: "observed" | "configured" | "historical" | "fallback";
}

export interface EconomicActualUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  requests?: number;
  credits?: number;
  usd?: number;
}

const ECONOMIC_ACTUAL_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "requests", "credits", "usd"] as const;

export type EconomicHardExclusion =
  | "attempted"
  | "unconfigured"
  | "disabled"
  | "missing-allowance"
  | "hard-headroom"
  | "stale-quota"
  | "max-marginal-usd"
  | "ineligible";

export type EconomicSoftSignal =
  | "reserve"
  | "unknown-quota"
  | "expiration-pressure";

export type EconomicRankingBand = "excluded" | "expiration" | "marginal-cost" | string;

export interface EconomicSelectionCandidate {
  target: EconomicTarget;
  eligible: boolean;
  exclusions: EconomicHardExclusion[];
  softSignals: EconomicSoftSignal[];
  configIndex: number;
  cashCost: number | "included" | "unknown";
  consumption: number[];
  postRequestRemaining: Array<number | null>;
  reserveThresholds: Array<number | null>;
  burnPressure: number | null;
  marginalUsd: number | null;
  stale: boolean;
  rankingBand: EconomicRankingBand;
  allowances: Array<{
    id: string;
    capacity: number | null;
    remaining: number | null;
    reserved: number;
    predicted: number;
    postRequestRemaining: number | null;
    reserveThreshold: number;
    resetAt?: number;
    expiresAt?: number;
    source?: string;
    ageMs?: number;
    stale: boolean;
  }>;
}

export interface EconomicSelectionResult {
  target?: EconomicTarget;
  targetIndex: number | null;
  candidates: EconomicSelectionCandidate[];
  reason: string;
  reservationId?: string;
}

export interface EconomicExplanation extends EconomicSelectionResult {
  comboId: string;
  strategy: "economy";
  selectedTarget: string | null;
  generatedAt: number;
}

interface Reservation {
  id: string;
  allowanceId: string;
  unit: OcxEconomicAllowance["unit"];
  amount: number;
  rates?: OcxEconomicAllowance["rates"];
  pricing?: OcxComboTarget["pricing"];
  expiresAt: number;
  generation: number;
}

const snapshots = new Map<string, OcxEconomicSnapshot>();
const reservations = new Map<string, Reservation>();
const settledReservationIds = new Set<string>();
const SETTLED_IDS_LIMIT = 10_000;
let reservationSequence = 0;
let lastReconciledGeneration = 0;
let liveAllowanceIds = new Set<string>();
const RESERVATION_TTL_MS = 10 * 60_000;
const EPSILON = 1e-9;

function rememberSettledId(id: string): void {
  settledReservationIds.add(id);
  if (settledReservationIds.size > SETTLED_IDS_LIMIT) {
    const excess = settledReservationIds.size - SETTLED_IDS_LIMIT;
    const iterator = settledReservationIds.values();
    for (let i = 0; i < excess; i += 1) {
      const oldest = iterator.next().value as string | undefined;
      if (oldest === undefined) break;
      settledReservationIds.delete(oldest);
    }
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safe(value: number | undefined): number {
  return finiteNonNegative(value) ? value : 0;
}

function allowanceFor(config: OcxConfig, id: string): OcxEconomicAllowance | undefined {
  return config.economicAllowances?.[id];
}

function snapshotAge(snapshot: OcxEconomicSnapshot | undefined, now: number): number {
  return snapshot ? Math.max(0, now - snapshot.updatedAt) : Number.POSITIVE_INFINITY;
}

export interface SnapshotFreshness {
  status: "fresh" | "stale" | "unknown";
  ageMs: number | null;
  reason?: "missing-snapshot" | "stale-snapshot" | "expired-window" | "past-reset" | "rolling-reset" | "missing-calendar-reset";
}

function finiteBoundary(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function effectiveBoundary(allowance: OcxEconomicAllowance, snapshot: OcxEconomicSnapshot): number | undefined {
  switch (allowance.window.kind) {
    case "balance":
      return undefined;
    case "rolling": {
      const start = finiteBoundary(snapshot.windowStart);
      return start === undefined ? undefined : start + allowance.window.durationMs;
    }
    case "calendar":
      return finiteBoundary(snapshot.resetAt);
    case "expiresAt":
      return Math.min(allowance.window.expiresAt, ...( [finiteBoundary(snapshot.resetAt), finiteBoundary(snapshot.expiresAt)].filter((value): value is number => value !== undefined) ));
  }
}

export function snapshotFreshness(
  snapshot: OcxEconomicSnapshot | undefined,
  allowance: OcxEconomicAllowance,
  now: number,
): SnapshotFreshness {
  if (!snapshot) return { status: "unknown", ageMs: null, reason: "missing-snapshot" };
  const ageMs = snapshotAge(snapshot, now);
  if (ageMs > (allowance.staleAfterMs ?? 15 * 60_000)) return { status: "stale", ageMs, reason: "stale-snapshot" };
  const boundary = effectiveBoundary(allowance, snapshot);
  if (allowance.window.kind === "calendar" && boundary === undefined) {
    return { status: "unknown", ageMs, reason: "missing-calendar-reset" };
  }
  if (allowance.window.kind === "rolling" && boundary === undefined) {
    return { status: "unknown", ageMs, reason: "rolling-reset" };
  }
  if (boundary !== undefined && boundary <= now) {
    return { status: "unknown", ageMs, reason: allowance.window.kind === "rolling" ? "rolling-reset" : snapshot.resetAt !== undefined && snapshot.resetAt <= now ? "past-reset" : "expired-window" };
  }
  if (snapshot.resetAt !== undefined && snapshot.resetAt <= now && allowance.window.kind !== "balance") {
    return { status: "unknown", ageMs, reason: "past-reset" };
  }
  return { status: "fresh", ageMs };
}

export function usableHeadroom(
  allowance: OcxEconomicAllowance,
  snapshot: OcxEconomicSnapshot | undefined,
  consumption: number,
  reserved: number,
  now: number,
): number | null {
  if (snapshotFreshness(snapshot, allowance, now).status !== "fresh") return null;
  if (!finiteNonNegative(snapshot?.remaining) || !finiteNonNegative(consumption) || !finiteNonNegative(reserved)) return null;
  const value = snapshot.remaining - reserved - consumption;
  return Number.isFinite(value) && Object.is(value, -0) ? 0 : Number.isFinite(value) ? value : null;
}

function reserveAmount(allowance: OcxEconomicAllowance): number {
  const value = allowance.reserveAmount !== undefined
    ? allowance.reserveAmount
    : allowance.reserveFraction !== undefined ? allowance.capacity * allowance.reserveFraction : 0;
  return finiteNonNegative(value) ? value : 0;
}

function activeReserved(allowanceId: string, now: number): number {
  let total = 0;
  for (const reservation of reservations.values()) {
    if (reservation.expiresAt <= now) continue;
    if (reservation.allowanceId === allowanceId) total += reservation.amount;
  }
  return total;
}

function windowDurationMs(allowance: OcxEconomicAllowance, snapshot: OcxEconomicSnapshot, now: number): number | null {
  if (allowance.window.kind === "rolling") return allowance.window.durationMs;
  if (snapshot.windowStart !== undefined && snapshot.resetAt !== undefined) {
    return Math.max(0, snapshot.resetAt - snapshot.windowStart);
  }
  if (snapshot.resetAt !== undefined && snapshot.resetAt > now) return Math.max(0, snapshot.resetAt - now);
  if (snapshot.expiresAt !== undefined && snapshot.expiresAt > now) return Math.max(0, snapshot.expiresAt - now);
  return null;
}

export function estimateEconomicRequest(body: unknown, modelId?: string): EconomicRequestEstimate {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const input = record.input ?? record.messages ?? body ?? "";
  const inputTokens = estimateTokens(typeof input === "string" ? input : JSON.stringify(input), modelId);
  const maxOutput = record.max_output_tokens ?? record.max_tokens;
  if (typeof maxOutput === "number" && Number.isFinite(maxOutput) && maxOutput >= 0) {
    return { inputTokens, outputTokens: Math.floor(maxOutput), kind: "configured" };
  }
  return { inputTokens, outputTokens: 1024, kind: "fallback" };
}

export function economicConsumption(
  allowance: OcxEconomicAllowance,
  estimate: EconomicRequestEstimate,
  pricing?: OcxComboTarget["pricing"],
): number {
  const input = safe(estimate.inputTokens);
  const output = safe(estimate.outputTokens);
  const fixedRequests = safe(estimate.fixedRequests ?? 1);
  switch (allowance.unit) {
    case "requests": return fixedRequests;
    case "inputTokens": return input;
    case "outputTokens": return output;
    case "totalTokens": return input + output;
    case "credits":
      return safe(allowance.rates?.fixedPerRequest ?? 0) * fixedRequests
        + safe(allowance.rates?.inputPerMillion ?? 0) * input / 1_000_000
        + safe(allowance.rates?.outputPerMillion ?? 0) * output / 1_000_000
        + safe(allowance.rates?.cachedInputPerMillion ?? 0) * safe(estimate.cachedInputTokens) / 1_000_000;
    case "usd":
      return safe(pricing?.fixedPerRequest ?? allowance.rates?.fixedPerRequest ?? 0) * fixedRequests
        + safe(pricing?.inputUsdPerMillion ?? allowance.rates?.inputPerMillion ?? 0) * input / 1_000_000
        + safe(pricing?.outputUsdPerMillion ?? allowance.rates?.outputPerMillion ?? 0) * output / 1_000_000
        + safe(pricing?.cachedInputUsdPerMillion ?? allowance.rates?.cachedInputPerMillion ?? 0) * safe(estimate.cachedInputTokens) / 1_000_000;
  }
}

function marginalUsd(target: OcxComboTarget, estimate: EconomicRequestEstimate): number | null {
  const pricing = target.pricing;
  if (!pricing) return target.allowances?.length ? 0 : null;
  const value = safe(pricing.fixedPerRequest) + safe(pricing.inputUsdPerMillion) * safe(estimate.inputTokens) / 1_000_000
    + safe(pricing.outputUsdPerMillion) * safe(estimate.outputTokens) / 1_000_000
    + safe(pricing.cachedInputUsdPerMillion) * safe(estimate.cachedInputTokens) / 1_000_000;
  return Number.isFinite(value) ? value : null;
}

function cashCostFor(target: OcxComboTarget, estimate: EconomicRequestEstimate, cost: number | null): number | "included" | "unknown" {
  if (target.pricing) {
    return cost !== null && Number.isFinite(cost) ? cost : "unknown";
  }
  if (target.allowances?.length) return "included";
  return "unknown";
}

function expiryPressure(allowance: OcxEconomicAllowance, snapshot: OcxEconomicSnapshot | undefined, now: number): number | null {
  if (allowance.rollover !== false || allowance.window.kind === "balance" || !snapshot) return null;
  const expiry = snapshot.expiresAt ?? snapshot.resetAt;
  const duration = windowDurationMs(allowance, snapshot, now);
  if (expiry === undefined || duration === null || duration <= 0) return null;
  const timeFraction = Math.max(EPSILON, Math.min(1, (expiry - now) / duration));
  return Math.max(0, safe(snapshot.remaining) / Math.max(EPSILON, allowance.capacity)) / timeFraction;
}

function unknownPolicy(combo: OcxComboConfig): "allow" | "deprioritize" | "reject" {
  return combo.economy?.unknownQuota ?? "deprioritize";
}

function compareCandidates(a: EconomicSelectionCandidate, b: EconomicSelectionCandidate): number {
  const eligible = (a.eligible ? 0 : 1) - (b.eligible ? 0 : 1);
  if (eligible !== 0) return eligible;
  const reserve = (a.softSignals.includes("reserve") ? 1 : 0) - (b.softSignals.includes("reserve") ? 1 : 0);
  if (reserve !== 0) return reserve;
  const unknown = (a.softSignals.includes("unknown-quota") ? 1 : 0) - (b.softSignals.includes("unknown-quota") ? 1 : 0);
  if (unknown !== 0) return unknown;
  const pressure = (b.burnPressure ?? -1) - (a.burnPressure ?? -1);
  if (pressure !== 0) return pressure;
  const aFinite = typeof a.marginalUsd === "number" && Number.isFinite(a.marginalUsd);
  const bFinite = typeof b.marginalUsd === "number" && Number.isFinite(b.marginalUsd);
  if (aFinite && bFinite) {
    if (a.marginalUsd! < b.marginalUsd!) return -1;
    if (a.marginalUsd! > b.marginalUsd!) return 1;
  } else if (aFinite && !bFinite) return -1;
  else if (!aFinite && bFinite) return 1;
  return a.configIndex - b.configIndex;
}

function candidateFor(
  config: OcxConfig,
  combo: OcxComboConfig,
  target: EconomicTarget,
  estimate: EconomicRequestEstimate,
  now: number,
  index: number,
  excluded: ReadonlySet<string>,
): EconomicSelectionCandidate {
  const hardExclusions: EconomicHardExclusion[] = [];
  const softSignals: EconomicSoftSignal[] = [];
  const allowances = target.allowances ?? [];
  const consumptions: number[] = [];
  const postRequestRemaining: Array<number | null> = [];
  const reserveThresholds: Array<number | null> = [];
  const allowanceDetails: EconomicSelectionCandidate["allowances"] = [];
  let pressure: number | null = null;
  let stale = false;
  if (excluded.has(targetKey(target))) hardExclusions.push("attempted");
  const provider = config.providers[target.provider];
  if (!provider) hardExclusions.push("unconfigured");
  else if (provider.disabled === true) hardExclusions.push("disabled");
  for (const allowanceId of allowances) {
    const allowance = allowanceFor(config, allowanceId);
    const snapshot = snapshots.get(allowanceId);
    if (!allowance) {
      hardExclusions.push("missing-allowance");
      continue;
    }
    const amount = economicConsumption(allowance, estimate, target.pricing);
    const reserved = activeReserved(allowanceId, now);
    const freshness = snapshotFreshness(snapshot, allowance, now);
    const post = usableHeadroom(allowance, snapshot, amount, reserved, now);
    const remaining = post === null || !snapshot ? null : post + amount;
    consumptions.push(amount);
    postRequestRemaining.push(post);
    reserveThresholds.push(reserveAmount(allowance));
    stale ||= freshness.status !== "fresh";
    allowanceDetails.push({
      id: allowanceId,
      capacity: allowance.capacity,
      remaining,
      reserved,
      predicted: amount,
      postRequestRemaining: post,
      reserveThreshold: reserveAmount(allowance),
      ...(snapshot?.resetAt !== undefined ? { resetAt: snapshot.resetAt } : {}),
      ...(snapshot?.expiresAt !== undefined ? { expiresAt: snapshot.expiresAt } : {}),
      ...(snapshot ? { source: snapshot.source, ageMs: snapshotAge(snapshot, now) } : {}),
      stale: freshness.status !== "fresh",
    });
    if (post !== null && post < -EPSILON) hardExclusions.push("hard-headroom");
    if (post !== null && post < reserveAmount(allowance) - EPSILON) {
      if (!softSignals.includes("reserve")) softSignals.push("reserve");
    }
    const p = expiryPressure(allowance, snapshot, now);
    if (p !== null) pressure = Math.max(pressure ?? 0, p);
  }
  if (stale && unknownPolicy(combo) === "reject") hardExclusions.push("stale-quota");
  else if (stale && unknownPolicy(combo) === "deprioritize") {
    if (!softSignals.includes("unknown-quota")) softSignals.push("unknown-quota");
  }
  if (pressure !== null && !softSignals.includes("expiration-pressure")) softSignals.push("expiration-pressure");
  const maxSpend = combo.economy?.maxMarginalUsd;
  const cost = marginalUsd(target, estimate);
  if (maxSpend !== undefined) {
    if (cost === null || cost > maxSpend) hardExclusions.push("max-marginal-usd");
  }
  const cashCost = cashCostFor(target, estimate, cost);
  const eligible = hardExclusions.length === 0;
  return {
    target,
    eligible,
    exclusions: hardExclusions,
    softSignals,
    configIndex: index,
    cashCost,
    consumption: consumptions,
    postRequestRemaining,
    reserveThresholds,
    burnPressure: pressure,
    marginalUsd: cost,
    stale,
    rankingBand: hardExclusions.includes("hard-headroom") ? "excluded" : pressure !== null ? "expiration" : cost !== null ? "marginal-cost" : `order-${index + 1}`,
    allowances: allowanceDetails,
  };
}

export function selectEconomicTarget(
  config: OcxConfig,
  comboId: string,
  estimate: EconomicRequestEstimate,
  now = Date.now(),
  excluded: Iterable<string> = [],
  isEligible?: (target: EconomicTarget) => boolean,
): EconomicSelectionResult {
  const combo = config.combos?.[comboId];
  if (!combo || combo.strategy !== "economy") return { targetIndex: null, candidates: [], reason: "not-economy" };
  sweepExpiredEconomicReservations(now);
  const candidates = combo.targets.map((target, index) => {
    const candidate = candidateFor(config, combo, { ...target, weight: target.weight ?? 1 }, estimate, now, index, new Set(excluded));
    if (isEligible && !isEligible(candidate.target)) {
      if (!candidate.exclusions.includes("ineligible")) candidate.exclusions.push("ineligible");
      candidate.eligible = candidate.exclusions.length === 0;
    }
    return candidate;
  });
  const available = candidates.filter(candidate => candidate.eligible);
  if (available.length === 0) return { targetIndex: null, candidates, reason: "no-economically-eligible-target" };
  const winner = available.slice().sort(compareCandidates)[0]!;
  return {
    target: winner.target,
    targetIndex: combo.targets.findIndex(target => targetKey(target) === targetKey(winner.target)),
    candidates,
    reason: winner.rankingBand === "expiration" ? "expiration pressure" : winner.rankingBand === "marginal-cost" ? "lowest marginal cost" : "stable target order",
  };
}

export function reserveEconomicSelection(
  config: OcxConfig,
  comboId: string,
  estimate: EconomicRequestEstimate,
  now = Date.now(),
  excluded: Iterable<string> = [],
  isEligible?: (target: EconomicTarget) => boolean,
): EconomicSelectionResult {
  const attempted = new Set(excluded);
  const targetCount = config.combos?.[comboId]?.targets.length ?? 0;
  const reserve = (currentExcluded: Set<string>): EconomicSelectionResult => {
    const result = selectEconomicTarget(config, comboId, estimate, now, currentExcluded, isEligible);
    if (!result.target) return result;
    const id = `econ-${++reservationSequence}`;
    const reservationsToAdd: Reservation[] = [];
    for (const allowanceId of result.target.allowances ?? []) {
      const allowance = allowanceFor(config, allowanceId);
      const snapshot = snapshots.get(allowanceId);
      if (!allowance || !snapshot) continue;
      const amount = economicConsumption(allowance, estimate, result.target.pricing);
      const headroom = usableHeadroom(allowance, snapshot, amount, activeReserved(allowanceId, now), now);
      if (headroom === null || headroom < -EPSILON) {
        if (currentExcluded.size >= targetCount) {
          return { targetIndex: null, candidates: result.candidates, reason: "reservation-headroom-race" };
        }
        const nextExcluded = new Set(currentExcluded);
        nextExcluded.add(targetKey(result.target));
        const fallback = reserve(nextExcluded);
        return fallback.target
          ? { ...fallback, reason: "reservation-headroom-race" }
          : { targetIndex: null, candidates: fallback.candidates, reason: "reservation-headroom-race" };
      }
      reservationsToAdd.push({
        id,
        allowanceId,
        unit: allowance.unit,
        amount,
        ...(allowance.rates ? { rates: { ...allowance.rates } } : {}),
        ...(result.target.pricing ? { pricing: { ...result.target.pricing } } : {}),
        expiresAt: now + RESERVATION_TTL_MS,
        generation: captureConfigGeneration(),
      });
    }
    for (const reservation of reservationsToAdd) reservations.set(`${id}\0${reservation.allowanceId}`, reservation);
    return { ...result, reservationId: id };
  };
  return reserve(attempted);
}

export function releaseEconomicReservation(id: string | undefined): void {
  if (!id) return;
  for (const key of reservations.keys()) if (key.startsWith(`${id}\0`)) reservations.delete(key);
}

/** Drop every in-flight reservation referencing an allowance. Used by operator
 * snapshot PUT/DELETE so a replaced or cleared snapshot cannot leave stale
 * reservations blocking headroom until TTL expiry. */
export function clearEconomicReservationsForAllowance(allowanceId: string): void {
  for (const key of reservations.keys()) {
    const reservation = reservations.get(key);
    if (reservation?.allowanceId === allowanceId) reservations.delete(key);
  }
}

/** Count non-expired reservations for an allowance (operator snapshot conflict checks). */
export function countEconomicReservationsForAllowance(allowanceId: string, now = Date.now()): number {
  let count = 0;
  for (const reservation of reservations.values()) {
    if (reservation.allowanceId === allowanceId && reservation.expiresAt > now) count += 1;
  }
  return count;
}

function actualForAllowance(reservation: Reservation, actual: EconomicActualUsage): number | undefined {
  switch (reservation.unit) {
    case "inputTokens": return actual.inputTokens;
    case "outputTokens": return actual.outputTokens;
    case "totalTokens": return actual.totalTokens;
    case "requests": return actual.requests;
    case "credits":
      if (actual.credits !== undefined) return actual.credits;
      return economicConsumption(
        { unit: "credits", capacity: 0, window: { kind: "balance" }, rates: reservation.rates },
        {
          inputTokens: safe(actual.inputTokens),
          outputTokens: safe(actual.outputTokens),
          cachedInputTokens: safe(actual.cachedInputTokens),
          fixedRequests: safe(actual.requests ?? 1),
          kind: "observed",
        },
      );
    case "usd":
      if (actual.usd !== undefined) return actual.usd;
      return economicConsumption(
        { unit: "usd", capacity: 0, window: { kind: "balance" }, rates: reservation.rates },
        {
          inputTokens: safe(actual.inputTokens),
          outputTokens: safe(actual.outputTokens),
          cachedInputTokens: safe(actual.cachedInputTokens),
          fixedRequests: safe(actual.requests ?? 1),
          kind: "observed",
        },
        reservation.pricing,
      );
  }
}

export function settleEconomicReservation(id: string | undefined, actual: EconomicActualUsage | undefined, now = Date.now()): void {
  if (!id || settledReservationIds.has(id)) return;
  const actualRecord = actual as Record<string, unknown> | undefined;
  if (actualRecord) {
    for (const field of ECONOMIC_ACTUAL_FIELDS) {
      if (actualRecord[field] !== undefined && !finiteNonNegative(actualRecord[field])) {
        releaseEconomicReservation(id);
        throw new TypeError(`Invalid economic actual usage: ${field}`);
      }
    }
  }
  const entries = [...reservations.entries()].filter(([, reservation]) => reservation.id === id);
  if (entries.length === 0) {
    rememberSettledId(id);
    return;
  }
  for (const [key, reservation] of entries) {
    const snapshot = snapshots.get(reservation.allowanceId);
    if (snapshot && actual !== undefined) {
      const actualAmount = actualForAllowance(reservation, actual);
      if (actualAmount !== undefined) {
        const remaining = Math.max(0, safe(snapshot.remaining) - actualAmount);
        snapshots.set(reservation.allowanceId, { ...snapshot, remaining, updatedAt: now });
      }
    }
    reservations.delete(key);
  }
  rememberSettledId(id);
}

export function setEconomicQuotaSnapshot(id: string, snapshot: OcxEconomicSnapshot): void {
  if (!finiteNonNegative(snapshot.remaining) || !finiteNonNegative(snapshot.updatedAt)) return;
  snapshots.set(id, { ...snapshot, remaining: Math.max(0, snapshot.remaining) });
}

export function getEconomicQuotaSnapshot(id: string): OcxEconomicSnapshot | undefined {
  return snapshots.get(id);
}

export function sweepExpiredEconomicReservations(now = Date.now()): number {
  let removed = 0;
  for (const [key, reservation] of reservations) {
    if (reservation.expiresAt > now) continue;
    reservations.delete(key);
    removed += 1;
  }
  return removed;
}

export function reconcileEconomicState(context: GenerationContext & { allowanceIds?: ReadonlySet<string> }): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  liveAllowanceIds = new Set(context.allowanceIds ?? []);
  let removed = 0;
  for (const id of snapshots.keys()) {
    if (liveAllowanceIds.has(id)) continue;
    snapshots.delete(id);
    removed += 1;
  }
  for (const [key, reservation] of reservations) {
    if (liveAllowanceIds.has(reservation.allowanceId)) continue;
    reservations.delete(key);
    removed += 1;
  }
  lastReconciledGeneration = context.generation;
  return removed;
}

export function clearEconomicState(): void {
  snapshots.clear();
  reservations.clear();
  settledReservationIds.clear();
  reservationSequence = 0;
  lastReconciledGeneration = 0;
  liveAllowanceIds = new Set();
}

export function clearEconomicQuotaSnapshot(id: string): boolean {
  return snapshots.delete(id);
}

export function explainEconomicCombo(config: OcxConfig, comboId: string, estimate: EconomicRequestEstimate, now = Date.now()): EconomicExplanation {
  const result = selectEconomicTarget(config, comboId, estimate, now);
  return {
    ...result,
    comboId,
    strategy: "economy",
    selectedTarget: result.target ? targetKey(result.target) : null,
    generatedAt: now,
  };
}
