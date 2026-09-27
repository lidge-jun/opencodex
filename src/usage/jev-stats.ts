import type { OcxComboDefaultEffort } from "../types";
import type { PersistedUsageEntry } from "./log";
import { usageDisplayTotalTokens } from "./totals";

export const JEV_DECISION_GATES = [
  "apply",
  "missing_key",
  "no_choices",
  "no_state",
  "timeout",
  "network",
  "redirect",
  "http",
  "malformed",
  "invalid",
] as const;

export type JevDecisionGate = (typeof JEV_DECISION_GATES)[number];

const JEV_GATE_SET = new Set<string>(JEV_DECISION_GATES);
const JEV_EFFORTS = new Set<OcxComboDefaultEffort>([
  "low", "medium", "high", "xhigh", "max", "ultra",
]);
const MAX_COMBO_ID_CHARS = 128;
// JEV accepts provider/model candidate fields up to 512 characters. Preserve
// that same identity on telemetry so a selected target still joins its attempt.
const MAX_TARGET_IDENTITY_CHARS = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export interface PersistedJevDecisionV1 {
  version: 1;
  comboId: string;
  selected: {
    provider: string;
    model: string;
    effort: OcxComboDefaultEffort | null;
  };
  gate: JevDecisionGate;
  latencyMs: number;
  confidence?: number;
  chosenProbability?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface JevStatsModelRow {
  provider: string;
  model: string;
  /** Aggregate bucket for identities beyond the retained model-cardinality cap. */
  overflow: boolean;
  picks: number;
  appliedPicks: number;
  failOpenPicks: number;
  attempts: number;
  measuredAttempts: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  efforts: Array<{ effort: OcxComboDefaultEffort | null; picks: number }>;
}

export const MAX_JEV_STATS_MODEL_ROWS = 256;

export interface JevStatsAccumulator {
  readonly estimatedBytes: number;
  add(entry: PersistedUsageEntry): void;
  clone(): JevStatsAccumulator;
  summarize(range: string, generatedAt: number): JevStatsResponse;
}

export interface JevStatsResponse {
  range: string;
  comboId: string | null;
  since: number | null;
  until?: number;
  generatedAt: number;
  summary: {
    decisions: number;
    appliedDecisions: number;
    failOpenDecisions: number;
    successfulRequests: number;
    requestsWithModelFallback: number;
    modelAttempts: number;
    measuredModelAttempts: number;
    modelInputTokens: number;
    modelOutputTokens: number;
    modelReasoningTokens: number;
    modelCacheReadTokens: number;
    modelCacheWriteTokens: number;
    modelTotalTokens: number;
    decisionUsageReported: number;
    decisionInputTokens: number;
    decisionOutputTokens: number;
    decisionTotalTokens: number;
    averageLatencyMs: number | null;
    averageConfidence: number | null;
    averageChosenProbability: number | null;
  };
  gates: Array<{ gate: JevDecisionGate; decisions: number }>;
  models: JevStatsModelRow[];
  snapshotWindowStart: number | null;
  snapshotWindowEnd: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedIdentity(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARS.test(normalized)) return undefined;
  return normalized.slice(0, maxLength);
}

export function normalizeJevStatsComboId(value: unknown): string | undefined {
  return boundedIdentity(value, MAX_COMBO_ID_CHARS);
}

function boundedCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

function saturatingAdd(total: number, value: number): number {
  if (!Number.isFinite(value) || value <= 0) return total;
  return total >= Number.MAX_SAFE_INTEGER - value
    ? Number.MAX_SAFE_INTEGER
    : total + value;
}

function probability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function normalizedDecisionUsage(value: unknown): PersistedJevDecisionV1["usage"] {
  if (!isRecord(value)) return undefined;
  const inputTokens = boundedCount(value.inputTokens ?? value.input_tokens);
  const outputTokens = boundedCount(value.outputTokens ?? value.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: saturatingAdd(inputTokens, outputTokens),
  };
}

/**
 * Re-validates the privacy-bounded decision record at both write and hydration boundaries.
 * Only closed enums, bounded identifiers and finite counters survive; prompts and credentials
 * have no slot in this shape.
 */
export function normalizePersistedJevDecision(value: unknown): PersistedJevDecisionV1 | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.selected)) return undefined;
  const comboId = boundedIdentity(value.comboId, MAX_COMBO_ID_CHARS);
  const provider = boundedIdentity(value.selected.provider, MAX_TARGET_IDENTITY_CHARS);
  const model = boundedIdentity(value.selected.model, MAX_TARGET_IDENTITY_CHARS);
  const effort = value.selected.effort;
  const gate = value.gate;
  const latencyMs = boundedCount(value.latencyMs);
  if (!comboId || !provider || !model || latencyMs === undefined) return undefined;
  if (effort !== null && (typeof effort !== "string" || !JEV_EFFORTS.has(effort as OcxComboDefaultEffort))) {
    return undefined;
  }
  if (typeof gate !== "string" || !JEV_GATE_SET.has(gate)) return undefined;
  const confidence = probability(value.confidence);
  const chosenProbability = probability(value.chosenProbability);
  const usage = normalizedDecisionUsage(value.usage);
  return {
    version: 1,
    comboId,
    selected: {
      provider,
      model,
      effort: effort as OcxComboDefaultEffort | null,
    },
    gate: gate as JevDecisionGate,
    latencyMs,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(chosenProbability !== undefined ? { chosenProbability } : {}),
    ...(usage ? { usage } : {}),
  };
}

interface MutableModelRow extends Omit<JevStatsModelRow, "efforts"> {
  effortCounts: Map<OcxComboDefaultEffort | null, number>;
}

interface JevStatsAccumulatorOptions {
  comboId?: string | null;
  since?: number | null;
  until?: number;
}

function cacheReadTokens(usage: NonNullable<NonNullable<PersistedUsageEntry["attempts"]>[number]["usage"]>): number {
  if (typeof usage.cacheReadInputTokens === "number") return usage.cacheReadInputTokens;
  if (typeof usage.cachedInputTokens !== "number") return 0;
  return typeof usage.cacheCreationInputTokens === "number"
    ? Math.max(0, usage.cachedInputTokens - usage.cacheCreationInputTokens)
    : usage.cachedInputTokens;
}

function finiteToken(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

function mean(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

function nextMean(current: number | null, count: number, value: number): number {
  if (current === null || count === 0) return value;
  if (count >= Number.MAX_SAFE_INTEGER) return current;
  return current + (value - current) / (count + 1);
}

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

export function createJevStatsAccumulator(options: JevStatsAccumulatorOptions = {}): JevStatsAccumulator {
  return new StreamingJevStatsAccumulator(options);
}

function blankModelRow(provider: string, model: string, overflow = false): MutableModelRow {
  return {
    provider,
    model,
    overflow,
    picks: 0,
    appliedPicks: 0,
    failOpenPicks: 0,
    attempts: 0,
    measuredAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    effortCounts: new Map(),
  };
}

function cloneModelRow(row: MutableModelRow): MutableModelRow {
  return { ...row, effortCounts: new Map(row.effortCounts) };
}

function publicModelRow({ effortCounts, ...row }: MutableModelRow): JevStatsModelRow {
  return {
    ...row,
    efforts: [...effortCounts].map(([effort, picks]) => ({ effort, picks })),
  };
}

class StreamingJevStatsAccumulator implements JevStatsAccumulator {
  private readonly comboId: string | null;
  private readonly since: number | null;
  private readonly until: number | undefined;
  private readonly models = new Map<string, MutableModelRow>();
  private overflowModel: MutableModelRow | null = null;
  private readonly gates = new Map<JevDecisionGate, number>();
  private snapshotWindowStart: number | null = null;
  private snapshotWindowEnd: number | null = null;
  private decisions = 0;
  private appliedDecisions = 0;
  private successfulRequests = 0;
  private requestsWithModelFallback = 0;
  private modelAttempts = 0;
  private measuredModelAttempts = 0;
  private modelInputTokens = 0;
  private modelOutputTokens = 0;
  private modelReasoningTokens = 0;
  private modelCacheReadTokens = 0;
  private modelCacheWriteTokens = 0;
  private modelTotalTokens = 0;
  private decisionUsageReported = 0;
  private decisionInputTokens = 0;
  private decisionOutputTokens = 0;
  private decisionTotalTokens = 0;
  private averageLatencyMs: number | null = null;
  private confidenceTotal = 0;
  private confidenceCount = 0;
  private probabilityTotal = 0;
  private probabilityCount = 0;

  constructor(options: JevStatsAccumulatorOptions = {}) {
    this.comboId = boundedIdentity(options.comboId, MAX_COMBO_ID_CHARS) ?? null;
    this.since = options.since === null || options.since === undefined ? null : options.since;
    this.until = options.until;
  }

  get estimatedBytes(): number {
    let bytes = 512;
    for (const row of this.models.values()) {
      bytes += 256 + (row.provider.length + row.model.length) * 2 + row.effortCounts.size * 32;
    }
    if (this.overflowModel) bytes += 256 + this.overflowModel.effortCounts.size * 32;
    return bytes;
  }

  private rowFor(provider: string, model: string): MutableModelRow {
    const key = modelKey(provider, model);
    const existing = this.models.get(key);
    if (existing) return existing;
    // Keep one of the 256 public rows for the aggregate overflow bucket. This
    // bounds retained memory, sort work and response size even if a ledger was
    // populated with attacker-controlled or short-lived model identities.
    if (this.models.size < MAX_JEV_STATS_MODEL_ROWS - 1) {
      const row = blankModelRow(provider, model);
      this.models.set(key, row);
      return row;
    }
    // Empty target identities never survive normalization, so the explicit
    // overflow flag plus this empty tuple cannot collide with a real row.
    this.overflowModel ??= blankModelRow("", "", true);
    return this.overflowModel;
  }

  add(entry: PersistedUsageEntry): void {
    if (Number.isFinite(entry.timestamp)) {
      this.snapshotWindowStart = this.snapshotWindowStart === null
        ? entry.timestamp
        : Math.min(this.snapshotWindowStart, entry.timestamp);
      this.snapshotWindowEnd = this.snapshotWindowEnd === null
        ? entry.timestamp
        : Math.max(this.snapshotWindowEnd, entry.timestamp);
    }
    if ((this.since !== null && entry.timestamp < this.since)
      || (this.until !== undefined && entry.timestamp > this.until)) return;
    const decision = normalizePersistedJevDecision(entry.jevDecision);
    if (!decision || (this.comboId !== null && decision.comboId !== this.comboId)) return;

    this.averageLatencyMs = nextMean(this.averageLatencyMs, this.decisions, decision.latencyMs);
    this.decisions = saturatingAdd(this.decisions, 1);
    if (decision.gate === "apply") this.appliedDecisions = saturatingAdd(this.appliedDecisions, 1);
    if (entry.status >= 200 && entry.status < 400) {
      this.successfulRequests = saturatingAdd(this.successfulRequests, 1);
    }
    this.gates.set(decision.gate, saturatingAdd(this.gates.get(decision.gate) ?? 0, 1));
    if (decision.confidence !== undefined) {
      this.confidenceTotal = saturatingAdd(this.confidenceTotal, decision.confidence);
      this.confidenceCount = saturatingAdd(this.confidenceCount, 1);
    }
    if (decision.chosenProbability !== undefined) {
      this.probabilityTotal = saturatingAdd(this.probabilityTotal, decision.chosenProbability);
      this.probabilityCount = saturatingAdd(this.probabilityCount, 1);
    }
    if (decision.usage) {
      this.decisionUsageReported = saturatingAdd(this.decisionUsageReported, 1);
      this.decisionInputTokens = saturatingAdd(this.decisionInputTokens, decision.usage.inputTokens);
      this.decisionOutputTokens = saturatingAdd(this.decisionOutputTokens, decision.usage.outputTokens);
      this.decisionTotalTokens = saturatingAdd(this.decisionTotalTokens, decision.usage.totalTokens);
    }

    const selected = this.rowFor(decision.selected.provider, decision.selected.model);
    selected.picks = saturatingAdd(selected.picks, 1);
    if (decision.gate === "apply") selected.appliedPicks = saturatingAdd(selected.appliedPicks, 1);
    else selected.failOpenPicks = saturatingAdd(selected.failOpenPicks, 1);
    selected.effortCounts.set(
      decision.selected.effort,
      saturatingAdd(selected.effortCounts.get(decision.selected.effort) ?? 0, 1),
    );

    const attempts = (entry.attempts ?? []).flatMap(attempt => {
      const sendCount = boundedCount(attempt.sendCount) ?? 0;
      if (sendCount === 0) return [];
      const provider = boundedIdentity(attempt.provider, MAX_TARGET_IDENTITY_CHARS);
      const model = boundedIdentity(attempt.model, MAX_TARGET_IDENTITY_CHARS);
      return provider && model ? [{ attempt, provider, model, sendCount }] : [];
    });
    if (attempts.some(({ provider, model }) => provider !== decision.selected.provider
      || model !== decision.selected.model)) {
      this.requestsWithModelFallback = saturatingAdd(this.requestsWithModelFallback, 1);
    }
    for (const { attempt, provider, model: modelId, sendCount } of attempts) {
      const model = this.rowFor(provider, modelId);
      model.attempts = saturatingAdd(model.attempts, sendCount);
      this.modelAttempts = saturatingAdd(this.modelAttempts, sendCount);
      if (!attempt.usage || (attempt.usageStatus !== "reported" && attempt.usageStatus !== "estimated")) continue;
      model.measuredAttempts = saturatingAdd(model.measuredAttempts, 1);
      this.measuredModelAttempts = saturatingAdd(this.measuredModelAttempts, 1);
      const inputTokens = finiteToken(attempt.usage.inputTokens);
      const outputTokens = finiteToken(attempt.usage.outputTokens);
      const reasoningTokens = finiteToken(attempt.usage.reasoningOutputTokens);
      const readTokens = finiteToken(cacheReadTokens(attempt.usage));
      const writeTokens = finiteToken(attempt.usage.cacheCreationInputTokens);
      const totalTokens = finiteToken(usageDisplayTotalTokens(attempt.usage, attempt.totalTokens));
      model.inputTokens = saturatingAdd(model.inputTokens, inputTokens);
      model.outputTokens = saturatingAdd(model.outputTokens, outputTokens);
      model.reasoningTokens = saturatingAdd(model.reasoningTokens, reasoningTokens);
      model.cacheReadTokens = saturatingAdd(model.cacheReadTokens, readTokens);
      model.cacheWriteTokens = saturatingAdd(model.cacheWriteTokens, writeTokens);
      model.totalTokens = saturatingAdd(model.totalTokens, totalTokens);
      this.modelInputTokens = saturatingAdd(this.modelInputTokens, inputTokens);
      this.modelOutputTokens = saturatingAdd(this.modelOutputTokens, outputTokens);
      this.modelReasoningTokens = saturatingAdd(this.modelReasoningTokens, reasoningTokens);
      this.modelCacheReadTokens = saturatingAdd(this.modelCacheReadTokens, readTokens);
      this.modelCacheWriteTokens = saturatingAdd(this.modelCacheWriteTokens, writeTokens);
      this.modelTotalTokens = saturatingAdd(this.modelTotalTokens, totalTokens);
    }
  }

  clone(): JevStatsAccumulator {
    const cloned = new StreamingJevStatsAccumulator({
      comboId: this.comboId,
      since: this.since,
      ...(this.until !== undefined ? { until: this.until } : {}),
    });
    for (const [key, row] of this.models) cloned.models.set(key, cloneModelRow(row));
    cloned.overflowModel = this.overflowModel ? cloneModelRow(this.overflowModel) : null;
    for (const [gate, count] of this.gates) cloned.gates.set(gate, count);
    cloned.snapshotWindowStart = this.snapshotWindowStart;
    cloned.snapshotWindowEnd = this.snapshotWindowEnd;
    cloned.decisions = this.decisions;
    cloned.appliedDecisions = this.appliedDecisions;
    cloned.successfulRequests = this.successfulRequests;
    cloned.requestsWithModelFallback = this.requestsWithModelFallback;
    cloned.modelAttempts = this.modelAttempts;
    cloned.measuredModelAttempts = this.measuredModelAttempts;
    cloned.modelInputTokens = this.modelInputTokens;
    cloned.modelOutputTokens = this.modelOutputTokens;
    cloned.modelReasoningTokens = this.modelReasoningTokens;
    cloned.modelCacheReadTokens = this.modelCacheReadTokens;
    cloned.modelCacheWriteTokens = this.modelCacheWriteTokens;
    cloned.modelTotalTokens = this.modelTotalTokens;
    cloned.decisionUsageReported = this.decisionUsageReported;
    cloned.decisionInputTokens = this.decisionInputTokens;
    cloned.decisionOutputTokens = this.decisionOutputTokens;
    cloned.decisionTotalTokens = this.decisionTotalTokens;
    cloned.averageLatencyMs = this.averageLatencyMs;
    cloned.confidenceTotal = this.confidenceTotal;
    cloned.confidenceCount = this.confidenceCount;
    cloned.probabilityTotal = this.probabilityTotal;
    cloned.probabilityCount = this.probabilityCount;
    return cloned;
  }

  summarize(range: string, generatedAt: number): JevStatsResponse {
    const rows = [
      ...this.models.values(),
      ...(this.overflowModel ? [this.overflowModel] : []),
    ]
      .map(publicModelRow)
      .sort((left, right) => right.picks - left.picks
        || right.attempts - left.attempts
        || left.provider.localeCompare(right.provider)
        || left.model.localeCompare(right.model));
    return {
      range,
      comboId: this.comboId,
      since: this.since,
      ...(this.until !== undefined ? { until: this.until } : {}),
      generatedAt,
      summary: {
        decisions: this.decisions,
        appliedDecisions: this.appliedDecisions,
        failOpenDecisions: this.decisions - this.appliedDecisions,
        successfulRequests: this.successfulRequests,
        requestsWithModelFallback: this.requestsWithModelFallback,
        modelAttempts: this.modelAttempts,
        measuredModelAttempts: this.measuredModelAttempts,
        modelInputTokens: this.modelInputTokens,
        modelOutputTokens: this.modelOutputTokens,
        modelReasoningTokens: this.modelReasoningTokens,
        modelCacheReadTokens: this.modelCacheReadTokens,
        modelCacheWriteTokens: this.modelCacheWriteTokens,
        modelTotalTokens: this.modelTotalTokens,
        decisionUsageReported: this.decisionUsageReported,
        decisionInputTokens: this.decisionInputTokens,
        decisionOutputTokens: this.decisionOutputTokens,
        decisionTotalTokens: this.decisionTotalTokens,
        averageLatencyMs: this.averageLatencyMs,
        averageConfidence: mean(this.confidenceTotal, this.confidenceCount),
        averageChosenProbability: mean(this.probabilityTotal, this.probabilityCount),
      },
      gates: JEV_DECISION_GATES.flatMap(gate => {
        const count = this.gates.get(gate) ?? 0;
        return count > 0 ? [{ gate, decisions: count }] : [];
      }),
      models: rows,
      snapshotWindowStart: this.snapshotWindowStart,
      snapshotWindowEnd: this.snapshotWindowEnd,
    };
  }
}
