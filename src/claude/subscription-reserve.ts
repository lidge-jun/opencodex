/**
 * Claude subscription weekly reserve: staged downgrade as the weekly window fills.
 *
 * The native Claude passthrough lane (`anthropicNativePassthrough` in `src/server/claude-messages.ts`)
 * terminates Claude Code's TLS (the claude-intercept listener) and so sees the upstream
 * `anthropic-ratelimit-unified-7d-utilization` / `-7d-reset` response headers of the caller's own
 * subscription. Until this module nothing recorded them for that lane. This module records the latest
 * weekly utilization (persisted, so a restart keeps it) and answers one question per request: may this
 * request still use Claude, or should it be served by the configured downgrade targets?
 *
 *   utilization >= soft (default 0.60): background / subagent traffic is downgraded.
 *   utilization >= hard (default 0.80): only interactive traffic may use Claude.
 *
 * Pattern adopted from Hermes-agent (MIT, NousResearch): credential seat order with
 * "reserve for interactive", and a route record (requested -> served, reason) on every downgrade.
 *
 * Opt-in: the policy lives in `<config dir>/subscription-reserve.json`; a missing file means disabled.
 * `targets` must name at least one routed `provider/model` selector, otherwise nothing is downgraded.
 * The traffic class comes from {@link classifyTraffic}; see its comment for the signals that exist.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";

export type TrafficClass = "interactive" | "background";

export interface ReservePolicy {
  enabled: boolean;
  /** Fraction (0-1) at which background traffic is downgraded. */
  soft: number;
  /** Fraction (0-1) at which only interactive traffic may use Claude. */
  hard: number;
  /** Routed `provider/model` selectors tried in order for downgraded requests. */
  targets: string[];
}

export interface WeeklyObservation {
  /** Fraction 0-1 as reported by the unified header. */
  utilization: number;
  /** Epoch ms of the window reset, when reported. */
  resetAt?: number;
  observedAt: number;
}

export interface ReserveDecision {
  action: "allow" | "downgrade";
  traffic: TrafficClass;
  utilization?: number;
  tier?: "soft" | "hard";
  target?: string;
  reason: string;
}

const DEFAULT_POLICY: ReservePolicy = { enabled: false, soft: 0.6, hard: 0.8, targets: [] };
/** An observation older than this is ignored unless its reset time is still in the future. */
const MAX_OBSERVATION_AGE_MS = 8 * 24 * 60 * 60 * 1000;

let observation: WeeklyObservation | null | undefined;

function policyPath(): string { return join(getConfigDir(), "subscription-reserve.json"); }
function statePath(): string { return join(getConfigDir(), "subscription-reserve-state.json"); }

export function readReservePolicy(): ReservePolicy {
  try {
    const raw = JSON.parse(readFileSync(policyPath(), "utf8")) as Partial<ReservePolicy>;
    const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 && v <= 1 ? v : d);
    const soft = num(raw.soft, DEFAULT_POLICY.soft);
    const hard = Math.max(num(raw.hard, DEFAULT_POLICY.hard), soft);
    const targets = Array.isArray(raw.targets)
      ? raw.targets.filter((t): t is string => typeof t === "string" && t.includes("/"))
      : [];
    return { enabled: raw.enabled === true, soft, hard, targets };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function finite(value: string | null): number | undefined {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Record the weekly window from an upstream response. Returns the stored observation, if any. */
export function observeWeeklyHeaders(headers: Headers, now = Date.now()): WeeklyObservation | undefined {
  const utilization = finite(headers.get("anthropic-ratelimit-unified-7d-utilization"));
  if (utilization === undefined || utilization < 0 || utilization > 1.5) return undefined;
  const reset = finite(headers.get("anthropic-ratelimit-unified-7d-reset"));
  const next: WeeklyObservation = {
    utilization: Math.min(utilization, 1),
    ...(reset !== undefined && reset > 0 ? { resetAt: reset * 1000 } : {}),
    observedAt: now,
  };
  observation = next;
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    atomicWriteFile(statePath(), JSON.stringify(next));
  } catch { /* the in-memory value still serves this process */ }
  return next;
}

export function currentWeeklyObservation(now = Date.now()): WeeklyObservation | undefined {
  if (observation === undefined) {
    try { observation = existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) as WeeklyObservation : null; }
    catch { observation = null; }
  }
  const o = observation;
  if (!o || typeof o.utilization !== "number") return undefined;
  // A weekly window that has reset since the observation starts again from zero.
  if (o.resetAt !== undefined && o.resetAt <= now) return undefined;
  if (o.resetAt === undefined && now - o.observedAt > MAX_OBSERVATION_AGE_MS) return undefined;
  return o;
}

/**
 * Interactive vs background. Signals that exist today, in priority order:
 *  1. `x-ocx-priority: background|interactive` on the request (explicit, set by a wrapper or hook).
 *  2. A Haiku-class model: Claude Code sends titles, summaries and quota probes there.
 *  3. A tiny `max_tokens` (<= 64) with no tools: quota probes and classifier calls.
 * Claude Code does not mark Task-tool subagent turns on the wire, so a subagent running on the main
 * model is classified as interactive until such a marker (or a per-agent header) exists.
 */
export function classifyTraffic(headers: Headers, body: { model?: unknown; max_tokens?: unknown; tools?: unknown }): TrafficClass {
  const explicit = headers.get("x-ocx-priority")?.trim().toLowerCase();
  if (explicit === "background" || explicit === "interactive") return explicit;
  if (typeof body.model === "string" && /haiku/i.test(body.model)) return "background";
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  if (typeof body.max_tokens === "number" && body.max_tokens <= 64 && tools === 0) return "background";
  return "interactive";
}

export function decideReserve(
  traffic: TrafficClass,
  policy: ReservePolicy = readReservePolicy(),
  now = Date.now(),
): ReserveDecision {
  if (!policy.enabled) return { action: "allow", traffic, reason: "reserve policy disabled" };
  const seen = currentWeeklyObservation(now);
  if (!seen) return { action: "allow", traffic, reason: "no weekly utilization observed" };
  const pct = Math.round(seen.utilization * 100);
  const tier = seen.utilization >= policy.hard ? "hard" : seen.utilization >= policy.soft ? "soft" : undefined;
  if (!tier || traffic === "interactive" || policy.targets.length === 0) {
    return { action: "allow", traffic, utilization: seen.utilization, reason: !tier ? `weekly ${pct}% below reserve` : traffic === "interactive" ? `interactive keeps Claude at ${pct}% weekly` : "no downgrade targets configured" };
  }
  return {
    action: "downgrade", traffic, utilization: seen.utilization, tier, target: policy.targets[0],
    reason: `weekly Claude ${pct}% >= ${Math.round((tier === "hard" ? policy.hard : policy.soft) * 100)}%: ${traffic} traffic downgraded`,
  };
}

/** Test seam. */
export function resetReserveStateForTests(): void { observation = undefined; }
