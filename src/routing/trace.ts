/**
 * Route decision trace: bounded, versioned, privacy-safe evidence of WHY a
 * provider/model/account was selected for a request (RI-01).
 *
 * Contract rules (devlog/_fin/260804_router_intelligence/000_master_plan.md):
 * - One trace per routing decision; fallback EXECUTION attempts stay in the
 *   usage entry's existing `attempts[]` array, never in this trace.
 * - Never persists prompts, message bodies, tool payloads, credentials,
 *   authorization headers, raw quota responses, or hidden reasoning.
 * - Stable wire values only; no localized strings.
 * - Deterministic bounds: candidates <= 8, exclusions per candidate <= 16,
 *   requirements <= 16, strings <= 128 chars, serialized trace <= 16 KiB.
 * - Truncation is explicit: `truncated` flags are set whenever a limit was
 *   enforced.
 */

import { randomBytes } from "node:crypto";

export type RouteDecisionKind =
  | "explicit-account"
  | "explicit-provider"
  | "native"
  | "combo"
  | "policy"
  | "default-provider";

export type Unknownable = number | boolean | "unknown";

export interface RouteRequirementEvidence {
  /** Stable wire code, e.g. "min-context-window" | "tools" | "image-input". */
  id: string;
  expected?: string | number | boolean;
  actual?: Unknownable | string;
  outcome: "satisfied" | "unsatisfied" | "unknown";
}

export interface RouteExclusionReason {
  /** Stable wire code, e.g. "cooldown" | "disabled" | "cost-limit". */
  code: string;
  detail?: string;
}

export interface RouteCapabilityEvidence {
  contextWindow?: number;
  tools?: Unknownable;
  image?: Unknownable;
  structuredOutput?: Unknownable;
  reasoningEfforts?: string[];
  /** `"unknown"` is reserved: it encodes missing evidence, never a real tier. */
  serviceTier?: string | "unknown";
  localOnly?: Unknownable;
  remoteAllowed?: Unknownable;
  encryptedCodexTasks?: Unknownable;
}

export interface RouteHealthEvidence {
  cooldownUntilMs?: number;
  softAvoidUntilMs?: number;
  successRate?: number;
  failures?: number;
  incompleteStreamRate?: number;
  recentLatencyMs?: number;
  sampleCount?: number;
  recencyWeight?: number;
}

export interface RouteQuotaEvidence {
  known: boolean;
  /** Remaining headroom as a fraction 0..1 (larger is better). */
  headroom?: number;
  headroomTokens?: number;
  exhausted?: boolean;
  resetAtMs?: number;
  reauthOrCooling?: boolean;
  reservedHeadroomTokens?: number;
  /** Stable wire code for the evidence source (e.g. "provider-report"). */
  source?: string;
}

/**
 * Stable wire outcome for `limits.maxEstimatedCostUsd` against this candidate's
 * cost evidence. Present only when a cap is configured. Non-excluding outcomes
 * (`satisfied`, `unknown-allowed`) must not be mirrored into `exclusions`.
 */
export type RouteCostCapOutcome =
  | "satisfied"
  | "exceeded"
  | "unknown-allowed"
  | "unknown-excluded";

export interface RouteCostEvidence {
  estimatedUsd?: number;
  /** Stable wire code for the price source (e.g. "registry" | "expected"). */
  priceSource?: string;
  incomplete?: boolean;
  limitUsd?: number;
  /**
   * Cap evaluation outcome when `limitUsd` / profile `maxEstimatedCostUsd` is set.
   * Distinguishes "known under the cap" from "unknown cost allowed by policy"
   * without treating the latter as an exclusion.
   */
  capOutcome?: RouteCostCapOutcome;
}

export interface RouteCompatibilitySuiteTrace {
  suiteId: string;
  evidenceLayer: string;
  /** Privacy-safe prefix of the exact subject used for this layer/suite. */
  subjectIdPrefix?: string;
  verdict?: string;
  minStatus?: string;
  fresh?: boolean;
  unknownPolicy?: string;
  degradedPolicy?: string;
  outcome: "satisfied" | "penalized" | "excluded" | "unknown";
  reason?: string;
}

export interface RouteCompatibilityEvidence {
  /** Legacy single-subject prefix retained for persisted trace compatibility. */
  subjectIdPrefix?: string;
  suites: RouteCompatibilitySuiteTrace[];
  truncated?: true;
}

export interface RouteScoreEvidence {
  total: number;
  components: {
    capability?: number;
    health?: number;
    quota?: number;
    cost?: number;
    latency?: number;
    configuredPriority?: number;
    compatibility?: number;
  };
}

export interface RouteCandidateTrace {
  provider: string;
  model: string;
  accountRef?: string;
  eligible: boolean;
  exclusions: RouteExclusionReason[];
  capability?: RouteCapabilityEvidence;
  health?: RouteHealthEvidence;
  quota?: RouteQuotaEvidence;
  cost?: RouteCostEvidence;
  compatibility?: RouteCompatibilityEvidence;
  score?: RouteScoreEvidence;
}

export interface RouteDecisionTraceV1 {
  version: 1;
  decisionId: string;
  createdAt: number;
  requestedModel: string;
  routeKind: RouteDecisionKind;
  profile?: { id: string; revision: string };
  requirements: RouteRequirementEvidence[];
  candidates: RouteCandidateTrace[];
  selected: {
    candidateIndex: number;
    provider: string;
    model: string;
    accountRef?: string;
    reason: string;
    tieBreak?: string;
  };
  truncated?: {
    candidates?: true;
    exclusions?: true;
    requirements?: true;
    strings?: true;
    compatibility?: true;
  };
}

export const MAX_TRACE_CANDIDATES = 8;
export const MAX_EXCLUSIONS_PER_CANDIDATE = 16;
export const MAX_REQUIREMENTS = 16;
export const MAX_TRACE_STRING = 128;
export const MAX_TRACE_BYTES = 16 * 1024;

const ROUTE_KINDS = new Set<RouteDecisionKind>([
  "explicit-account",
  "explicit-provider",
  "native",
  "combo",
  "policy",
  "default-provider",
]);

const REQUIREMENT_OUTCOMES = new Set(["satisfied", "unsatisfied", "unknown"]);

/** Cap a string at MAX_TRACE_STRING and record the truncation flag. */
function capString(value: string, budget: { strings?: true }): string {
  if (value.length <= MAX_TRACE_STRING) return value;
  budget.strings = true;
  return value.slice(0, MAX_TRACE_STRING);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unknownable(value: unknown): Unknownable | undefined {
  if (typeof value === "boolean") return value;
  if (finiteNumber(value)) return value;
  if (value === "unknown") return "unknown";
  return undefined;
}

export interface TraceCandidateInput {
  provider: string;
  model: string;
  accountRef?: string;
  eligible: boolean;
  exclusions: RouteExclusionReason[];
  score?: RouteScoreEvidence;
  capability?: RouteCapabilityEvidence;
  health?: RouteHealthEvidence;
  quota?: RouteQuotaEvidence;
  cost?: RouteCostEvidence;
  compatibility?: RouteCompatibilityEvidence;
}

export interface TraceBuildInput {
  requestedModel: string;
  routeKind: RouteDecisionKind;
  selected: {
    provider: string;
    model: string;
    accountRef?: string;
    reason: string;
    tieBreak?: string;
    /** Index into `candidates`; defaults to 0. */
    candidateIndex?: number;
  };
  profile?: { id: string; revision: string };
  requirements?: RouteRequirementEvidence[];
  candidates?: TraceCandidateInput[];
  now?: number;
}

interface ParseCaps {
  candidates?: true;
  exclusions?: true;
  requirements?: true;
  strings?: true;
  compatibility?: true;
}

/** Bounded candidate copy: strings capped, exclusions sliced, score/evidence kept. */
function buildCandidate(input: TraceCandidateInput, budget: ParseCaps): RouteCandidateTrace {
  const exclusions = input.exclusions.slice(0, MAX_EXCLUSIONS_PER_CANDIDATE);
  if (exclusions.length < input.exclusions.length) budget.exclusions = true;
  const capability = input.capability ? parseCapability(input.capability, budget) : undefined;
  const health = input.health ? parseHealth(input.health) : undefined;
  const quota = input.quota ? parseQuota(input.quota, budget) : undefined;
  const cost = input.cost ? parseCost(input.cost, budget) : undefined;
  const compatibility = input.compatibility ? parseCompatibility(input.compatibility, budget) : undefined;
  return {
    provider: capString(input.provider, budget),
    model: capString(input.model, budget),
    ...(input.accountRef !== undefined
      ? { accountRef: capString(input.accountRef, budget) }
      : {}),
    eligible: input.eligible,
    exclusions: exclusions.map(exclusion => ({
      code: capString(exclusion.code, budget),
      ...(exclusion.detail !== undefined
        ? { detail: capString(exclusion.detail, budget) }
        : {}),
    })),
    ...(input.score ? { score: input.score } : {}),
    ...(capability ? { capability } : {}),
    ...(health ? { health } : {}),
    ...(quota ? { quota } : {}),
    ...(cost ? { cost } : {}),
    ...(compatibility ? { compatibility } : {}),
  };
}

/** Bounded requirement copy with capped strings. */
function buildRequirement(requirement: RouteRequirementEvidence, budget: { strings?: true }): RouteRequirementEvidence {
  return {
    id: capString(requirement.id, budget),
    ...(requirement.expected !== undefined
      ? { expected: typeof requirement.expected === "string"
          ? capString(requirement.expected, budget)
          : requirement.expected }
      : {}),
    ...(requirement.actual !== undefined
      ? { actual: typeof requirement.actual === "string"
          ? capString(requirement.actual, budget)
          : requirement.actual }
      : {}),
    outcome: requirement.outcome,
  };
}

/**
 * Build a bounded decision trace. The builder never receives credentials: callers
 * pass provider/model NAME strings and opaque account references only.
 */
export function buildRouteDecisionTrace(input: TraceBuildInput): RouteDecisionTraceV1 {
  const budget: ParseCaps = {};
  const now = input.now ?? Date.now();
  const truncated: RouteDecisionTraceV1["truncated"] = {};
  let selectedIndex = Number.isInteger(input.selected.candidateIndex ?? 0)
    ? (input.selected.candidateIndex ?? 0)
    : 0;

  let candidates = (input.candidates ?? []).map(candidate => buildCandidate(candidate, budget));
  if (candidates.length > MAX_TRACE_CANDIDATES) {
    candidates = selectedIndex < MAX_TRACE_CANDIDATES
      ? candidates.slice(0, MAX_TRACE_CANDIDATES)
      : [...candidates.slice(0, MAX_TRACE_CANDIDATES - 1), candidates[selectedIndex]!];
    selectedIndex = Math.min(selectedIndex, candidates.length - 1);
    truncated.candidates = true;
  }
  if (candidates.length === 0) {
    candidates = [{
      provider: capString(input.selected.provider, budget),
      model: capString(input.selected.model, budget),
      ...(input.selected.accountRef !== undefined
        ? { accountRef: capString(input.selected.accountRef, budget) }
        : {}),
      eligible: true,
      exclusions: [],
    }];
  }

  let requirements = (input.requirements ?? []).map(requirement => buildRequirement(requirement, budget));
  if (requirements.length > MAX_REQUIREMENTS) {
    requirements = requirements.slice(0, MAX_REQUIREMENTS);
    truncated.requirements = true;
  }

  if (selectedIndex < 0 || selectedIndex >= candidates.length) selectedIndex = 0;

  const trace: RouteDecisionTraceV1 = {
    version: 1,
    decisionId: randomBytes(6).toString("hex"),
    createdAt: now,
    requestedModel: capString(input.requestedModel, budget),
    routeKind: input.routeKind,
    ...(input.profile
      ? {
        profile: {
          id: capString(input.profile.id, budget),
          revision: capString(input.profile.revision, budget),
        },
      }
      : {}),
    requirements,
    candidates,
    selected: {
      candidateIndex: selectedIndex,
      provider: capString(input.selected.provider, budget),
      model: capString(input.selected.model, budget),
      ...(input.selected.accountRef !== undefined
        ? { accountRef: capString(input.selected.accountRef, budget) }
        : {}),
      reason: capString(input.selected.reason, budget),
      ...(input.selected.tieBreak !== undefined
        ? { tieBreak: capString(input.selected.tieBreak, budget) }
        : {}),
    },
  };

  if (budget.strings) truncated.strings = true;
  if (budget.exclusions) truncated.exclusions = true;
  if (budget.candidates) truncated.candidates = true;
  if (budget.compatibility) truncated.compatibility = true;
  if (Object.keys(truncated).length > 0) trace.truncated = truncated;

  return enforceByteBudget(trace);
}

/** Serialized UTF-8 length of a value (JSON is measured in bytes, not code units). */
function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Deterministic byte-budget enforcement: drop details, then shrink candidates. */
function enforceByteBudget(trace: RouteDecisionTraceV1): RouteDecisionTraceV1 {
  if (serializedByteLength(trace) <= MAX_TRACE_BYTES) return trace;
  const truncated = { ...trace.truncated, strings: true as const };
  const candidates = trace.candidates.map(candidate => ({
    ...candidate,
    exclusions: candidate.exclusions.map(exclusion => ({ code: exclusion.code })),
  }));
  const slimmed: RouteDecisionTraceV1 = { ...trace, truncated, candidates };
  if (serializedByteLength(slimmed) <= MAX_TRACE_BYTES) return slimmed;
  const half = Math.max(1, Math.floor(MAX_TRACE_CANDIDATES / 2));
  const selectedIndex = trace.selected.candidateIndex;
  const kept = selectedIndex < half
    ? slimmed.candidates.slice(0, half)
    : [...slimmed.candidates.slice(0, half - 1), slimmed.candidates[selectedIndex]!];
  let result: RouteDecisionTraceV1 = {
    ...slimmed,
    truncated: { ...truncated, candidates: true as const },
    candidates: kept,
    selected: { ...slimmed.selected, candidateIndex: Math.min(selectedIndex, kept.length - 1) },
  };
  for (let stage = 0; stage < 4 && serializedByteLength(result) > MAX_TRACE_BYTES; stage++) {
    if (stage === 0) {
      result = {
        ...result,
        truncated: { ...result.truncated, exclusions: true as const },
        candidates: result.candidates.map(candidate => ({
          ...candidate,
          exclusions: candidate.exclusions.slice(0, 8),
        })),
      };
    } else if (stage === 1) {
      result = {
        ...result,
        truncated: { ...result.truncated, exclusions: true as const },
        candidates: result.candidates.map(candidate => ({ ...candidate, exclusions: [] })),
      };
    } else {
      const half = Math.max(1, Math.ceil(result.candidates.length / 2));
      const index = result.selected.candidateIndex;
      const shrinkKept = index < half
        ? result.candidates.slice(0, half)
        : [...result.candidates.slice(0, half - 1), result.candidates[index]!];
      result = {
        ...result,
        truncated: { ...result.truncated, candidates: true as const },
        candidates: shrinkKept,
        selected: { ...result.selected, candidateIndex: Math.min(index, shrinkKept.length - 1) },
      };
    }
  }
  return result;
}

/** Defensive parse of one persisted exclusion reason. */
function parseExclusion(raw: unknown, caps: ParseCaps): RouteExclusionReason | null {
  if (!isPlainRecord(raw)) return null;
  const code = raw.code;
  if (typeof code !== "string" || code.length === 0) return null;
  if (code.length > MAX_TRACE_STRING) caps.strings = true;
  const out: RouteExclusionReason = { code: code.slice(0, MAX_TRACE_STRING) };
  if (typeof raw.detail === "string") {
    if (raw.detail.length > MAX_TRACE_STRING) caps.strings = true;
    out.detail = raw.detail.slice(0, MAX_TRACE_STRING);
  }
  return out;
}

/** Defensive parse of one persisted requirement; rejects unknown outcomes. */
function parseRequirement(raw: unknown, caps: ParseCaps): RouteRequirementEvidence | null {
  if (!isPlainRecord(raw)) return null;
  const id = raw.id;
  const outcome = raw.outcome;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof outcome !== "string" || !REQUIREMENT_OUTCOMES.has(outcome)) return null;
  if (id.length > MAX_TRACE_STRING) caps.strings = true;
  const out: RouteRequirementEvidence = {
    id: id.slice(0, MAX_TRACE_STRING),
    outcome: outcome as RouteRequirementEvidence["outcome"],
  };
  if (typeof raw.expected === "string") {
    if (raw.expected.length > MAX_TRACE_STRING) caps.strings = true;
    out.expected = raw.expected.slice(0, MAX_TRACE_STRING);
  } else if (typeof raw.expected === "number" || typeof raw.expected === "boolean") {
    out.expected = raw.expected;
  }
  if (typeof raw.actual === "string") {
    if (raw.actual.length > MAX_TRACE_STRING) caps.strings = true;
    out.actual = raw.actual.slice(0, MAX_TRACE_STRING);
  } else if (unknownable(raw.actual) !== undefined) {
    out.actual = unknownable(raw.actual);
  }
  return out;
}

/** Whitelisted capability-evidence parse; unknown fields are dropped. */
function parseCapability(raw: unknown, caps: ParseCaps): RouteCapabilityEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: RouteCapabilityEvidence = {};
  if (finiteNumber(raw.contextWindow)) out.contextWindow = raw.contextWindow;
  const tools = unknownable(raw.tools);
  if (tools !== undefined) out.tools = tools;
  const image = unknownable(raw.image);
  if (image !== undefined) out.image = image;
  const structuredOutput = unknownable(raw.structuredOutput);
  if (structuredOutput !== undefined) out.structuredOutput = structuredOutput;
  const rawReasoningEfforts = Array.isArray(raw.reasoningEfforts)
    ? raw.reasoningEfforts
    : undefined;
  const reasoningEfforts = rawReasoningEfforts
    ? Array.from(
      { length: Math.min(rawReasoningEfforts.length, 8) },
      (_, index) => rawReasoningEfforts[index],
    )
    : undefined;
  if (reasoningEfforts
    && reasoningEfforts.every((value): value is string => typeof value === "string")) {
    if (reasoningEfforts.some((value: unknown) => typeof value === "string"
      && value.length > MAX_TRACE_STRING)) caps.strings = true;
    out.reasoningEfforts = reasoningEfforts.map(value => value.slice(0, MAX_TRACE_STRING));
  }
  if (raw.serviceTier === "unknown") {
    out.serviceTier = "unknown";
  } else if (typeof raw.serviceTier === "string" && raw.serviceTier) {
    if (raw.serviceTier.length > MAX_TRACE_STRING) caps.strings = true;
    out.serviceTier = raw.serviceTier.slice(0, MAX_TRACE_STRING);
  }
  const localOnly = unknownable(raw.localOnly);
  if (localOnly !== undefined) out.localOnly = localOnly;
  const remoteAllowed = unknownable(raw.remoteAllowed);
  if (remoteAllowed !== undefined) out.remoteAllowed = remoteAllowed;
  const encryptedCodexTasks = unknownable(raw.encryptedCodexTasks);
  if (encryptedCodexTasks !== undefined) out.encryptedCodexTasks = encryptedCodexTasks;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Whitelisted health-evidence parse; non-numeric fields are dropped. */
function parseHealth(raw: unknown): RouteHealthEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: RouteHealthEvidence = {};
  if (finiteNumber(raw.cooldownUntilMs)) out.cooldownUntilMs = raw.cooldownUntilMs;
  if (finiteNumber(raw.softAvoidUntilMs)) out.softAvoidUntilMs = raw.softAvoidUntilMs;
  if (finiteNumber(raw.successRate)) out.successRate = raw.successRate;
  if (finiteNumber(raw.failures)) out.failures = raw.failures;
  if (finiteNumber(raw.incompleteStreamRate)) out.incompleteStreamRate = raw.incompleteStreamRate;
  if (finiteNumber(raw.recentLatencyMs)) out.recentLatencyMs = raw.recentLatencyMs;
  if (finiteNumber(raw.sampleCount)) out.sampleCount = raw.sampleCount;
  if (finiteNumber(raw.recencyWeight)) out.recencyWeight = raw.recencyWeight;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Whitelisted quota-evidence parse; requires a boolean `known`. */
function parseQuota(raw: unknown, caps: ParseCaps): RouteQuotaEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (typeof raw.known !== "boolean") return undefined;
  const out: RouteQuotaEvidence = { known: raw.known };
  if (finiteNumber(raw.headroom)) out.headroom = Math.max(0, Math.min(1, raw.headroom));
  if (finiteNumber(raw.headroomTokens)) out.headroomTokens = raw.headroomTokens;
  if (typeof raw.exhausted === "boolean") out.exhausted = raw.exhausted;
  if (finiteNumber(raw.resetAtMs)) out.resetAtMs = raw.resetAtMs;
  if (typeof raw.reauthOrCooling === "boolean") out.reauthOrCooling = raw.reauthOrCooling;
  if (finiteNumber(raw.reservedHeadroomTokens)) out.reservedHeadroomTokens = raw.reservedHeadroomTokens;
  if (typeof raw.source === "string" && raw.source) {
    if (raw.source.length > MAX_TRACE_STRING) caps.strings = true;
    out.source = raw.source.slice(0, MAX_TRACE_STRING);
  }
  return out;
}

const COST_CAP_OUTCOMES = new Set<RouteCostCapOutcome>([
  "satisfied",
  "exceeded",
  "unknown-allowed",
  "unknown-excluded",
]);

/** Whitelisted cost-evidence parse. */
function parseCost(raw: unknown, caps: ParseCaps): RouteCostEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const out: RouteCostEvidence = {};
  if (finiteNumber(raw.estimatedUsd)) out.estimatedUsd = raw.estimatedUsd;
  if (typeof raw.priceSource === "string" && raw.priceSource) {
    if (raw.priceSource.length > MAX_TRACE_STRING) caps.strings = true;
    out.priceSource = raw.priceSource.slice(0, MAX_TRACE_STRING);
  }
  if (typeof raw.incomplete === "boolean") out.incomplete = raw.incomplete;
  if (finiteNumber(raw.limitUsd)) out.limitUsd = raw.limitUsd;
  if (out.limitUsd !== undefined
    && typeof raw.capOutcome === "string"
    && COST_CAP_OUTCOMES.has(raw.capOutcome as RouteCostCapOutcome)) {
    out.capOutcome = raw.capOutcome as RouteCostCapOutcome;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const MAX_COMPATIBILITY_SUITES = 8;
const COMPATIBILITY_OUTCOMES = new Set(["satisfied", "penalized", "excluded", "unknown"]);

function parseCompatibility(raw: unknown, caps: ParseCaps): RouteCompatibilityEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const suitesRaw = Array.isArray(raw.suites) ? raw.suites : [];
  if (suitesRaw.length > MAX_COMPATIBILITY_SUITES || raw.truncated === true) caps.compatibility = true;
  const suites: RouteCompatibilitySuiteTrace[] = [];
  for (const entry of suitesRaw.slice(0, MAX_COMPATIBILITY_SUITES)) {
    if (!isPlainRecord(entry)) continue;
    const suiteId = entry.suiteId;
    const evidenceLayer = entry.evidenceLayer;
    const outcome = entry.outcome;
    if (typeof suiteId !== "string" || typeof evidenceLayer !== "string") continue;
    if (typeof outcome !== "string" || !COMPATIBILITY_OUTCOMES.has(outcome)) continue;
    const row: RouteCompatibilitySuiteTrace = {
      suiteId: capString(suiteId, caps),
      evidenceLayer: capString(evidenceLayer, caps),
      outcome: outcome as RouteCompatibilitySuiteTrace["outcome"],
    };
    if (typeof entry.subjectIdPrefix === "string" && entry.subjectIdPrefix) {
      row.subjectIdPrefix = capString(entry.subjectIdPrefix, caps);
    }
    for (const key of ["verdict", "minStatus", "reason", "unknownPolicy", "degradedPolicy"] as const) {
      if (typeof entry[key] === "string") row[key] = capString(entry[key] as string, caps);
    }
    if (typeof entry.fresh === "boolean") row.fresh = entry.fresh;
    suites.push(row);
  }
  const out: RouteCompatibilityEvidence = {
    suites,
    ...(raw.truncated === true ? { truncated: true as const } : {}),
  };
  if (typeof raw.subjectIdPrefix === "string" && raw.subjectIdPrefix) {
    out.subjectIdPrefix = capString(raw.subjectIdPrefix, caps);
  }
  return suites.length > 0 || out.subjectIdPrefix || out.truncated ? out : undefined;
}

/** Whitelisted score parse; requires a finite `total` and bounded components. */
function parseScore(raw: unknown): RouteScoreEvidence | undefined {
  if (!isPlainRecord(raw)) return undefined;
  if (!finiteNumber(raw.total)) return undefined;
  const components = isPlainRecord(raw.components) ? raw.components : {};
  const parsedComponents: RouteScoreEvidence["components"] = {};
  for (const key of ["capability", "health", "quota", "cost", "latency", "configuredPriority", "compatibility"] as const) {
    if (finiteNumber(components[key])) parsedComponents[key] = components[key];
  }
  return { total: raw.total, components: parsedComponents };
}

/** Defensive parse of one persisted candidate with bounded evidence blocks. */
function parseCandidate(raw: unknown, caps: ParseCaps): RouteCandidateTrace | null {
  if (!isPlainRecord(raw)) return null;
  const provider = raw.provider;
  const model = raw.model;
  if (typeof provider !== "string" || provider.length === 0) return null;
  if (typeof model !== "string" || model.length === 0) return null;
  if (provider.length > MAX_TRACE_STRING) caps.strings = true;
  if (model.length > MAX_TRACE_STRING) caps.strings = true;
  if (typeof raw.accountRef === "string" && raw.accountRef.length > MAX_TRACE_STRING) caps.strings = true;
  if (typeof raw.eligible !== "boolean") return null;
  if (Array.isArray(raw.exclusions) && raw.exclusions.length > MAX_EXCLUSIONS_PER_CANDIDATE) caps.exclusions = true;
  const exclusions = Array.isArray(raw.exclusions)
    ? raw.exclusions.slice(0, MAX_EXCLUSIONS_PER_CANDIDATE)
      .map(value => parseExclusion(value, caps))
      .filter((value): value is RouteExclusionReason => value !== null)
    : [];
  const capability = parseCapability(raw.capability, caps);
  const health = parseHealth(raw.health);
  const quota = parseQuota(raw.quota, caps);
  const cost = parseCost(raw.cost, caps);
  const compatibility = parseCompatibility(raw.compatibility, caps);
  const score = parseScore(raw.score);
  return {
    provider: provider.slice(0, MAX_TRACE_STRING),
    model: model.slice(0, MAX_TRACE_STRING),
    ...(typeof raw.accountRef === "string"
      ? { accountRef: raw.accountRef.slice(0, MAX_TRACE_STRING) }
      : {}),
    eligible: raw.eligible,
    exclusions: exclusions.slice(0, MAX_EXCLUSIONS_PER_CANDIDATE),
    ...(capability ? { capability } : {}),
    ...(health ? { health } : {}),
    ...(quota ? { quota } : {}),
    ...(cost ? { cost } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(score ? { score } : {}),
  };
}

/**
 * Defensive parse of a persisted trace. Returns null when the row is not a
 * version-1 trace; otherwise returns a bounded, whitelisted copy. Invalid
 * evidence objects are dropped rather than poisoning the DTO.
 */
export function normalizeRouteDecisionTrace(raw: unknown): RouteDecisionTraceV1 | null {
  if (!isPlainRecord(raw)) return null;
  if (raw.version !== 1) return null;
  const caps: ParseCaps = {};
  const decisionId = raw.decisionId;
  const createdAt = raw.createdAt;
  const requestedModel = raw.requestedModel;
  const routeKind = raw.routeKind;
  if (typeof decisionId !== "string" || decisionId.length === 0) return null;
  if (!/^[0-9a-f]{12}$/.test(decisionId)) return null;
  if (decisionId.length > MAX_TRACE_STRING) caps.strings = true;
  if (!finiteNumber(createdAt)) return null;
  if (typeof requestedModel !== "string" || requestedModel.length === 0) return null;
  if (requestedModel.length > MAX_TRACE_STRING) caps.strings = true;
  if (typeof routeKind !== "string" || !ROUTE_KINDS.has(routeKind as RouteDecisionKind)) return null;
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) return null;
  if (raw.candidates.length > MAX_TRACE_CANDIDATES) caps.candidates = true;

  const candidates = raw.candidates
    .slice(0, MAX_TRACE_CANDIDATES)
    .map(value => parseCandidate(value, caps))
    .filter((value): value is RouteCandidateTrace => value !== null)
    .slice(0, MAX_TRACE_CANDIDATES);
  if (candidates.length === 0) return null;

  const selected = isPlainRecord(raw.selected) ? raw.selected : null;
  if (!selected) return null;
  const selectedProvider = selected.provider;
  const selectedModel = selected.model;
  const selectedReason = selected.reason;
  if (typeof selectedProvider !== "string" || typeof selectedModel !== "string") return null;
  if (typeof selectedReason !== "string") return null;
  if (selectedProvider.length > MAX_TRACE_STRING) caps.strings = true;
  if (selectedModel.length > MAX_TRACE_STRING) caps.strings = true;
  if (selectedReason.length > MAX_TRACE_STRING) caps.strings = true;
  if (typeof selected.accountRef === "string" && selected.accountRef.length > MAX_TRACE_STRING) caps.strings = true;
  if (typeof selected.tieBreak === "string" && selected.tieBreak.length > MAX_TRACE_STRING) caps.strings = true;
  const candidateIndex = Number.isInteger(selected.candidateIndex)
    ? selected.candidateIndex as number
    : 0;
  if (candidateIndex < 0 || candidateIndex >= candidates.length) return null;

  const rawRequirements = Array.isArray(raw.requirements) ? raw.requirements : [];
  if (rawRequirements.length > MAX_REQUIREMENTS) caps.requirements = true;
  const requirements = rawRequirements
    .slice(0, MAX_REQUIREMENTS)
    .map(value => parseRequirement(value, caps))
    .filter((value): value is RouteRequirementEvidence => value !== null)
    .slice(0, MAX_REQUIREMENTS);

  const profile = isPlainRecord(raw.profile)
    && typeof raw.profile.id === "string"
    && typeof raw.profile.revision === "string"
    ? (() => {
      if (raw.profile.id.length > MAX_TRACE_STRING) caps.strings = true;
      if (raw.profile.revision.length > MAX_TRACE_STRING) caps.strings = true;
      return {
        id: raw.profile.id.slice(0, MAX_TRACE_STRING),
        revision: raw.profile.revision.slice(0, MAX_TRACE_STRING),
      };
    })()
    : undefined;

  const incoming = isPlainRecord(raw.truncated) ? raw.truncated : {};
  const truncated: RouteDecisionTraceV1["truncated"] = {};
  if (incoming.candidates === true || caps.candidates) truncated.candidates = true;
  if (incoming.exclusions === true || caps.exclusions) truncated.exclusions = true;
  if (incoming.requirements === true || caps.requirements) truncated.requirements = true;
  if (incoming.strings === true || caps.strings) truncated.strings = true;
  if (incoming.compatibility === true || caps.compatibility) truncated.compatibility = true;

  return {
    version: 1,
    decisionId: decisionId.slice(0, MAX_TRACE_STRING),
    createdAt,
    requestedModel: requestedModel.slice(0, MAX_TRACE_STRING),
    routeKind: routeKind as RouteDecisionKind,
    ...(profile ? { profile } : {}),
    requirements,
    candidates,
    selected: {
      candidateIndex,
      provider: selectedProvider.slice(0, MAX_TRACE_STRING),
      model: selectedModel.slice(0, MAX_TRACE_STRING),
      ...(typeof selected.accountRef === "string"
        ? { accountRef: selected.accountRef.slice(0, MAX_TRACE_STRING) }
        : {}),
      reason: selectedReason.slice(0, MAX_TRACE_STRING),
      ...(typeof selected.tieBreak === "string"
        ? { tieBreak: selected.tieBreak.slice(0, MAX_TRACE_STRING) }
        : {}),
    },
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
  };
}
