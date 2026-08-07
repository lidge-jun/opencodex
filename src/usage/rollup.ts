import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { getConfigDir, renameAtomicFile } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { baseProviderLabel } from "../providers/label";
import { JAWCODE_TABLE_FINGERPRINT } from "../generated/jawcode-model-metadata";
import {
  currentUsageLogRevision,
  normalizeUsageEntry,
  usageLogPath,
  usageLogRevisionKey,
  type PersistedUsageEntry,
  type UsageStatus,
} from "./log";
import {
  estimateComboCost,
  estimateRequestCost,
  ROLLUP_COST_SEMANTICS_VERSION,
  serviceTierContext,
} from "./cost";
import {
  CONTEXT_TIERS,
  EXPECTED_PRICE_OVERLAYS,
  PRIORITY_MULTIPLIERS,
} from "./expected-prices";
import {
  foldAttributionStatuses,
  localDateKey,
  usageAttributions,
  usageModelIdentity,
  type UsageAttribution,
} from "./summary";
import { usageDisplayTotalTokens } from "./totals";

export const ROLLUP_MIN_AGE_DAYS = 9;
const ROLLUP_ATTEMPT_THROTTLE_MS = 10 * 60 * 1_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const BOUNDARY_DIGEST_BYTES = 4 * 1024;
/**
 * Upper bound on the raw-byte span folded into ONE segment per iteration. The
 * fold loop still catches up a larger backlog in a single call, but each
 * iteration materializes at most this many bytes of parsed entries, so first
 * fold over a multi-GB usage.jsonl is bounded-memory instead of loading the
 * whole eligible prefix (review thread: unbounded prefix materialization).
 */
let foldSegmentCapBytes = 64 * 1024 * 1024;

/** Test seam: shrink the per-segment fold cap so bounded-fold behavior is testable with small fixtures. */
export function setFoldSegmentCapForTests(bytes: number | null): void {
  foldSegmentCapBytes = bytes ?? 64 * 1024 * 1024;
}

export interface RollupMeta {
  version: 1;
  lineageKey: string;
  priceFingerprint: string;
  lastFoldAttemptAt: number;
  updatedAt: number;
}

export interface RollupCommitRow {
  kind: "commit"; lineageKey: string; seg: number; toOffset: number;
  attemptId: string; rowCount: number; payloadDigest: string; boundaryDigest: string;
  attributionSinceMs: number | null; oldestTimestampMs: number | null; foldedAt: number;
}

export interface RollupStatusCounts {
  reported: number; unreported: number; unsupported: number; estimated: number;
}

export interface RollupTokenSums {
  inputTokens: number; outputTokens: number; cacheReadInputTokens: number;
  cacheCreationInputTokens: number; reasoningOutputTokens: number; totalTokens: number;
}

export type RollupSurfaceKey = "codex" | "claude" | "claude-desktop" | "grok";

export interface RollupDayRow {
  kind: "day"; seg: number; attemptId: string; date: string; surface: RollupSurfaceKey;
  statusCounts: RollupStatusCounts; attemptCount: number; tokens: RollupTokenSums;
  estimatedCostUsd: number; pricedRequests: number; unpricedRequests: number; unmeteredRequests: number;
}

export interface RollupModelRow {
  kind: "model"; seg: number; attemptId: string; date: string; surface: RollupSurfaceKey;
  provider: string; model: string; resolvedModel?: string; requests: number; attemptCount: number;
  foldedStatusCounts: RollupStatusCounts;
  tokens: Pick<RollupTokenSums, "inputTokens" | "outputTokens" | "totalTokens">;
  estimatedCostUsd: number;
}

export interface RollupProviderRow {
  kind: "provider"; seg: number; attemptId: string; date: string; surface: RollupSurfaceKey; provider: string;
  requests: number; attemptCount: number; foldedStatusCounts: RollupStatusCounts;
  totalTokens: number; estimatedCostUsd: number;
}

export interface RollupKeyRow {
  kind: "key"; seg: number; attemptId: string; date: string;
  admissionKind: "configured" | "environment" | "loopback";
  apiKeyId?: string; requests: number; requestsWithTimestamp: number; lastUsedAtMs: number | null;
}

export interface RollupSnapshot {
  cutlineOffset: number;
  attributionSinceMs: number | null;
  oldestTimestampMs: number | null;
  days: RollupDayRow[];
  models: RollupModelRow[];
  providers: RollupProviderRow[];
  keys: RollupKeyRow[];
}

type RollupGroupRow = RollupDayRow | RollupModelRow | RollupProviderRow | RollupKeyRow;
type ParsedSegment = { commit: RollupCommitRow; rows: RollupGroupRow[] };

interface ParsedRollup {
  snapshot: RollupSnapshot;
  segments: ParsedSegment[];
}

interface DayAccumulator {
  statusCounts: RollupStatusCounts;
  attemptCount: number;
  tokens: RollupTokenSums;
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
}

interface AttributionAccumulator {
  firstResolvedModel?: string;
  attemptCount: number;
  statusesByRequest: Map<string, UsageStatus[]>;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface ProviderAccumulator {
  attemptCount: number;
  statusesByRequest: Map<string, UsageStatus[]>;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface KeyAccumulator {
  requests: number;
  requestsWithTimestamp: number;
  lastUsedAtMs: number | null;
}

let rollupFlight: Promise<void> | null = null;
/** Memoized read-time boundary validation, keyed on the raw log's revision. */
let boundaryValidationCache: { key: string; valid: boolean } | null = null;

function rollupPath(): string {
  return join(getConfigDir(), "usage-rollup.jsonl");
}

function rollupMetaPath(): string {
  return join(getConfigDir(), "usage-rollup-meta.json");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function currentRollupPriceFingerprint(): string {
  return sha256(stableStringify({
    semantics: ROLLUP_COST_SEMANTICS_VERSION,
    jawcode: JAWCODE_TABLE_FINGERPRINT,
    overlays: EXPECTED_PRICE_OVERLAYS,
    priority: PRIORITY_MULTIPLIERS,
    contextTiers: CONTEXT_TIERS,
  }));
}

function lineageKey(): string | null {
  const revision = currentUsageLogRevision();
  return revision ? `${revision.dev}\0${revision.ino}\0${revision.birthtimeMs}` : null;
}

function readExactly(fd: number, length: number, position: number): Buffer | null {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, output, offset, length - offset, position + offset);
    if (count === 0) return null;
    offset += count;
  }
  return output;
}

function blankStatuses(): RollupStatusCounts {
  return { reported: 0, unreported: 0, unsupported: 0, estimated: 0 };
}

function blankTokens(): RollupTokenSums {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function bumpStatus(counts: RollupStatusCounts, status: UsageStatus): void {
  counts[status] += 1;
}

function addStatusCounts(target: RollupStatusCounts, source: RollupStatusCounts): void {
  target.reported += source.reported;
  target.unreported += source.unreported;
  target.unsupported += source.unsupported;
  target.estimated += source.estimated;
}

function addTokenSums(target: RollupTokenSums, source: RollupTokenSums): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
}

function entryTokenSums(entry: Pick<PersistedUsageEntry, "usage" | "totalTokens">): RollupTokenSums {
  const sums = blankTokens();
  if (!entry.usage) return sums;
  sums.inputTokens = entry.usage.inputTokens;
  sums.outputTokens = entry.usage.outputTokens;
  const creation = entry.usage.cacheCreationInputTokens ?? 0;
  const read = typeof entry.usage.cacheReadInputTokens === "number"
    ? entry.usage.cacheReadInputTokens
    : typeof entry.usage.cachedInputTokens === "number" && typeof entry.usage.cacheCreationInputTokens === "number"
      ? Math.max(0, entry.usage.cachedInputTokens - entry.usage.cacheCreationInputTokens)
      : entry.usage.cachedInputTokens ?? 0;
  sums.cacheReadInputTokens = read;
  sums.cacheCreationInputTokens = creation;
  sums.reasoningOutputTokens = entry.usage.reasoningOutputTokens ?? 0;
  sums.totalTokens = usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
  return sums;
}

function surfaceKey(entry: PersistedUsageEntry): RollupSurfaceKey {
  return entry.surface ?? "codex";
}

function usableTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isGroupRow(value: unknown): value is RollupGroupRow {
  if (!isObject(value) || typeof value.seg !== "number" || typeof value.attemptId !== "string") return false;
  return value.kind === "day" || value.kind === "model" || value.kind === "provider" || value.kind === "key";
}

function isCommitRow(value: unknown): value is RollupCommitRow {
  if (!isObject(value) || value.kind !== "commit") return false;
  return typeof value.lineageKey === "string"
    && typeof value.seg === "number" && Number.isSafeInteger(value.seg) && value.seg >= 0
    && typeof value.toOffset === "number" && Number.isSafeInteger(value.toOffset) && value.toOffset > value.seg
    && typeof value.attemptId === "string" && value.attemptId.length > 0
    && typeof value.rowCount === "number" && Number.isSafeInteger(value.rowCount) && value.rowCount >= 0
    && typeof value.payloadDigest === "string" && typeof value.boundaryDigest === "string"
    && (value.attributionSinceMs === null || typeof value.attributionSinceMs === "number")
    && (value.oldestTimestampMs === null || typeof value.oldestTimestampMs === "number")
    && typeof value.foldedAt === "number";
}

function readMeta(): RollupMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(rollupMetaPath(), "utf8")) as unknown;
    if (!isObject(parsed)) return null;
    if (parsed.version !== 1 || typeof parsed.lineageKey !== "string"
      || typeof parsed.priceFingerprint !== "string"
      || typeof parsed.lastFoldAttemptAt !== "number" || typeof parsed.updatedAt !== "number") return null;
    return parsed as unknown as RollupMeta;
  } catch {
    return null;
  }
}

function parseRollup(expectedLineage: string): ParsedRollup {
  const empty: RollupSnapshot = {
    cutlineOffset: 0,
    attributionSinceMs: null,
    oldestTimestampMs: null,
    days: [], models: [], providers: [], keys: [],
  };
  if (!existsSync(rollupPath())) return { snapshot: empty, segments: [] };
  let text: string;
  try {
    text = readFileSync(rollupPath(), "utf8");
  } catch {
    return { snapshot: empty, segments: [] };
  }
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { snapshot: empty, segments: [] };
  const attempts = new Map<string, { rows: RollupGroupRow[]; payload: string }>();
  const validBySeg = new Map<number, ParsedSegment>();
  for (const line of text.slice(0, lastNewline + 1).split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (isGroupRow(parsed)) {
      const key = `${parsed.seg}\0${parsed.attemptId}`;
      const attempt = attempts.get(key) ?? { rows: [], payload: "" };
      attempt.rows.push(parsed);
      attempt.payload += `${line}\n`;
      attempts.set(key, attempt);
      continue;
    }
    if (!isCommitRow(parsed) || parsed.lineageKey !== expectedLineage || validBySeg.has(parsed.seg)) continue;
    const attempt = attempts.get(`${parsed.seg}\0${parsed.attemptId}`);
    if (!attempt || attempt.rows.length !== parsed.rowCount || sha256(attempt.payload) !== parsed.payloadDigest) continue;
    validBySeg.set(parsed.seg, { commit: parsed, rows: [...attempt.rows] });
  }
  const segments: ParsedSegment[] = [];
  for (let offset = 0; validBySeg.has(offset);) {
    const segment = validBySeg.get(offset)!;
    segments.push(segment);
    offset = segment.commit.toOffset;
  }
  return { snapshot: mergeSegments(segments), segments };
}

function mergeSegments(segments: ParsedSegment[]): RollupSnapshot {
  const days = new Map<string, RollupDayRow>();
  const models = new Map<string, RollupModelRow>();
  const providers = new Map<string, RollupProviderRow>();
  const keys = new Map<string, RollupKeyRow>();
  let attributionSinceMs: number | null = null;
  let oldestTimestampMs: number | null = null;
  for (const { commit, rows } of segments) {
    if (commit.attributionSinceMs !== null) attributionSinceMs = attributionSinceMs === null
      ? commit.attributionSinceMs : Math.min(attributionSinceMs, commit.attributionSinceMs);
    if (commit.oldestTimestampMs !== null) oldestTimestampMs = oldestTimestampMs === null
      ? commit.oldestTimestampMs : Math.min(oldestTimestampMs, commit.oldestTimestampMs);
    for (const row of rows) mergeGroupRow(row, days, models, providers, keys);
  }
  return {
    cutlineOffset: segments.at(-1)?.commit.toOffset ?? 0,
    attributionSinceMs,
    oldestTimestampMs,
    days: [...days.values()],
    models: [...models.values()],
    providers: [...providers.values()],
    keys: [...keys.values()],
  };
}

function mergeGroupRow(
  row: RollupGroupRow,
  days: Map<string, RollupDayRow>,
  models: Map<string, RollupModelRow>,
  providers: Map<string, RollupProviderRow>,
  keys: Map<string, RollupKeyRow>,
): void {
  if (row.kind === "day") {
    const key = `${row.date}\0${row.surface}`;
    const current = days.get(key);
    if (!current) { days.set(key, structuredClone(row)); return; }
    addStatusCounts(current.statusCounts, row.statusCounts);
    addTokenSums(current.tokens, row.tokens);
    current.attemptCount += row.attemptCount;
    current.estimatedCostUsd += row.estimatedCostUsd;
    current.pricedRequests += row.pricedRequests;
    current.unpricedRequests += row.unpricedRequests;
    current.unmeteredRequests += row.unmeteredRequests;
    return;
  }
  if (row.kind === "model") {
    const key = `${row.date}\0${row.surface}\0${row.provider}\0${row.model}`;
    const current = models.get(key);
    if (!current) { models.set(key, structuredClone(row)); return; }
    current.requests += row.requests;
    current.attemptCount += row.attemptCount;
    addStatusCounts(current.foldedStatusCounts, row.foldedStatusCounts);
    current.tokens.inputTokens += row.tokens.inputTokens;
    current.tokens.outputTokens += row.tokens.outputTokens;
    current.tokens.totalTokens += row.tokens.totalTokens;
    current.estimatedCostUsd += row.estimatedCostUsd;
    return;
  }
  if (row.kind === "provider") {
    const key = `${row.date}\0${row.surface}\0${row.provider}`;
    const current = providers.get(key);
    if (!current) { providers.set(key, structuredClone(row)); return; }
    current.requests += row.requests;
    current.attemptCount += row.attemptCount;
    addStatusCounts(current.foldedStatusCounts, row.foldedStatusCounts);
    current.totalTokens += row.totalTokens;
    current.estimatedCostUsd += row.estimatedCostUsd;
    return;
  }
  const key = `${row.date}\0${row.admissionKind}\0${row.apiKeyId ?? ""}`;
  const current = keys.get(key);
  if (!current) { keys.set(key, structuredClone(row)); return; }
  current.requests += row.requests;
  current.requestsWithTimestamp += row.requestsWithTimestamp;
  if (row.lastUsedAtMs !== null) current.lastUsedAtMs = current.lastUsedAtMs === null
    ? row.lastUsedAtMs : Math.max(current.lastUsedAtMs, row.lastUsedAtMs);
}

export function readRollupSnapshot(): RollupSnapshot | null {
  try {
    if (!existsSync(rollupPath())) return null;
    const meta = readMeta();
    const currentLineage = lineageKey();
    if (!meta || !currentLineage || meta.version !== 1
      || meta.lineageKey !== currentLineage
      || meta.priceFingerprint !== currentRollupPriceFingerprint()) return null;
    const parsed = parseRollup(currentLineage);
    // Read-time boundary validity (review threads: truncated/rewritten raw log
    // within a throttle window must not serve a stale sidecar). The fold path
    // performs the same check before appending; readers need it too because a
    // truncate-then-regrow can happen entirely between folds. EVERY segment's
    // boundary window is validated, not just the last — a same-size rewrite of
    // an earlier folded span would leave the final segment's tail intact.
    //
    // Scope, stated honestly: each boundary digest covers the trailing
    // BOUNDARY_DIGEST_BYTES of its segment, so a surgical same-size rewrite
    // strictly inside a segment's untailed span is not detected here. That is
    // the fold-time contract too (the sidecar trusts an append-only log); the
    // read-time check exists to catch the realistic failure — truncation,
    // rotation, regrowth — not an adversarial editor with byte-level care.
    //
    // Cost: the validation is memoized per raw-log revision (dev/ino/size/
    // mtime/ctime), so cached hot paths pay one fstat, not a re-hash of every
    // segment on every call.
    if (parsed.segments.length > 0) {
      const revisionKey = `${usageLogRevisionKey(currentUsageLogRevision())}|${parsed.snapshot.cutlineOffset}|${parsed.segments.length}`;
      if (boundaryValidationCache?.key === revisionKey) {
        if (!boundaryValidationCache.valid) return null;
      } else {
        let valid = false;
        let fd: number | undefined;
        try {
          fd = openSync(usageLogPath(), "r");
          const rawSize = Number(fstatSync(fd).size);
          valid = rawSize >= parsed.snapshot.cutlineOffset
            && parsed.segments.every(segment => boundaryMatches(fd!, segment));
        } catch {
          valid = false;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
        boundaryValidationCache = { key: revisionKey, valid };
        if (!valid) return null;
      }
    }
    return parsed.snapshot;
  } catch {
    return null;
  }
}

function cutoffDateKey(now: number): string {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - ROLLUP_MIN_AGE_DAYS);
  return localDateKey(cutoff.getTime());
}

async function eligibleCutline(fd: number, size: number, fromOffset: number, now: number): Promise<number> {
  const cutoff = cutoffDateKey(now);
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let pendingStart = fromOffset;
  let eligible = fromOffset;
  for (let position = fromOffset; position < size;) {
    const length = Math.min(READ_CHUNK_BYTES, size - position);
    const chunk = readExactly(fd, length, position);
    if (!chunk) break;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let cursor = 0;
    for (;;) {
      const newline = pending.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const line = pending.subarray(cursor, newline).toString("utf8").replace(/\r$/, "");
      if (line.trim()) {
        // A COMPLETE (newline-terminated) row that cannot carry usage data —
        // unparseable JSON, a non-object, no string requestId, or an unusable
        // timestamp — must not stall the cutline forever: the fold parse skips
        // it identically (parseUsageRange requires a string requestId), so
        // advancing past it loses nothing. Only a REAL usage row whose usable
        // timestamp is at or past the cutoff stops eligibility (still too recent).
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { parsed = null; }
        if (isObject(parsed) && typeof parsed.requestId === "string"
          && usableTimestamp(parsed.timestamp)
          && localDateKey(parsed.timestamp) >= cutoff) return pendingStart + cursor;
      }
      eligible = pendingStart + newline + 1;
      cursor = newline + 1;
      // Segment cap: one fold segment materializes at most this raw span.
      // The caller loops, so a large backlog still catches up — in bounded slices.
      if (eligible - fromOffset >= foldSegmentCapBytes) return eligible;
    }
    if (cursor > 0) {
      pending = pending.subarray(cursor);
      pendingStart += cursor;
    }
    position += length;
    // Yield between chunks so a first scan over a large existing log cannot
    // monopolize the event loop (review thread: yield while locating the cutline).
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return eligible;
}

async function parseUsageRange(fd: number, fromOffset: number, toOffset: number): Promise<PersistedUsageEntry[]> {
  const entries: PersistedUsageEntry[] = [];
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let parsedLines = 0;
  for (let position = fromOffset; position < toOffset;) {
    const length = Math.min(READ_CHUNK_BYTES, toOffset - position);
    const chunk = readExactly(fd, length, position);
    if (!chunk) break;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let cursor = 0;
    for (;;) {
      const newline = pending.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const line = pending.subarray(cursor, newline).toString("utf8").replace(/\r$/, "");
      cursor = newline + 1;
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as PersistedUsageEntry;
        if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") {
          entries.push(normalizeUsageEntry(parsed));
        }
      } catch { /* complete malformed rows are skipped like usage/log.ts */ }
      parsedLines += 1;
      if (parsedLines % 1_000 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (cursor > 0) pending = pending.subarray(cursor);
    position += length;
  }
  return entries;
}

function dayAccumulator(): DayAccumulator {
  return {
    statusCounts: blankStatuses(), attemptCount: 0, tokens: blankTokens(), estimatedCostUsd: 0,
    pricedRequests: 0, unpricedRequests: 0, unmeteredRequests: 0,
  };
}

function attributionAccumulator(resolvedModel?: string): AttributionAccumulator {
  return {
    ...(resolvedModel ? { firstResolvedModel: resolvedModel } : {}),
    attemptCount: 0, statusesByRequest: new Map(), inputTokens: 0, outputTokens: 0,
    totalTokens: 0, estimatedCostUsd: 0,
  };
}

function providerAccumulator(): ProviderAccumulator {
  return { attemptCount: 0, statusesByRequest: new Map(), totalTokens: 0, estimatedCostUsd: 0 };
}

function appendStatus(map: Map<string, UsageStatus[]>, requestId: string, status: UsageStatus): void {
  const statuses = map.get(requestId) ?? [];
  statuses.push(status);
  map.set(requestId, statuses);
}

function modelIdentity(attribution: UsageAttribution): { provider: string; model: string; resolvedModel?: string } {
  return {
    provider: baseProviderLabel(attribution.provider),
    model: attribution.model,
    ...(attribution.resolvedModel ? { resolvedModel: attribution.resolvedModel } : {}),
  };
}

function accumulateEntries(entries: PersistedUsageEntry[], seg: number, attemptId: string): {
  rows: RollupGroupRow[]; attributionSinceMs: number | null; oldestTimestampMs: number | null;
} {
  const days = new Map<string, DayAccumulator>();
  const models = new Map<string, AttributionAccumulator>();
  const providers = new Map<string, ProviderAccumulator>();
  const keys = new Map<string, KeyAccumulator>();
  let attributionSinceMs: number | null = null;
  let oldestTimestampMs: number | null = null;
  for (const entry of entries) {
    if (!usableTimestamp(entry.timestamp)) continue;
    oldestTimestampMs = oldestTimestampMs === null ? entry.timestamp : Math.min(oldestTimestampMs, entry.timestamp);
    const date = localDateKey(entry.timestamp);
    const surface = surfaceKey(entry);
    const dayKey = `${date}\0${surface}`;
    const day = days.get(dayKey) ?? dayAccumulator();
    bumpStatus(day.statusCounts, entry.usageStatus);
    day.attemptCount += entry.attempts?.length ?? 1;
    addTokenSums(day.tokens, entryTokenSums(entry));
    const tier = serviceTierContext(entry);
    const estimate = entry.attempts?.length
      ? estimateComboCost(entry.attempts, undefined, tier)
      : estimateRequestCost({ provider: entry.provider, model: entry.model, usage: entry.usage, usageStatus: entry.usageStatus, serviceTier: tier });
    if (entry.usageStatus === "unreported" || entry.usageStatus === "unsupported"
      || (!entry.usage && !entry.attempts?.length)) day.unmeteredRequests += 1;
    else if (!estimate) day.unpricedRequests += 1;
    else { day.pricedRequests += 1; day.estimatedCostUsd += estimate.cost.total; }
    days.set(dayKey, day);

    const attributions = usageAttributions(entry);
    for (const attribution of attributions) {
      const identity = modelIdentity(attribution);
      const modelKey = `${date}\0${surface}\0${identity.provider}\0${identity.model}`;
      const model = models.get(modelKey) ?? attributionAccumulator(identity.resolvedModel);
      model.attemptCount += 1;
      appendStatus(model.statusesByRequest, attribution.requestId, attribution.usageStatus);
      if (attribution.usage) {
        model.inputTokens += attribution.usage.inputTokens;
        model.outputTokens += attribution.usage.outputTokens;
        model.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
      }
      models.set(modelKey, model);

      const providerKey = `${date}\0${surface}\0${identity.provider}`;
      const provider = providers.get(providerKey) ?? providerAccumulator();
      provider.attemptCount += 1;
      appendStatus(provider.statusesByRequest, attribution.requestId, attribution.usageStatus);
      provider.totalTokens += usageDisplayTotalTokens(attribution.usage, attribution.totalTokens) ?? 0;
      providers.set(providerKey, provider);
    }
    if (estimate?.attempts) {
      for (const attemptEstimate of estimate.attempts) {
        const identity = usageModelIdentity(attemptEstimate.provider, attemptEstimate.model);
        const provider = baseProviderLabel(attemptEstimate.provider);
        const model = models.get(`${date}\0${surface}\0${provider}\0${identity.model}`);
        if (model) model.estimatedCostUsd += attemptEstimate.cost.total;
        const providerRow = providers.get(`${date}\0${surface}\0${provider}`);
        if (providerRow) providerRow.estimatedCostUsd += attemptEstimate.cost.total;
      }
    } else if (estimate) {
      const identity = usageModelIdentity(entry.provider, entry.model, entry.resolvedModel);
      const provider = baseProviderLabel(entry.provider);
      const model = models.get(`${date}\0${surface}\0${provider}\0${identity.model}`);
      if (model) model.estimatedCostUsd += estimate.cost.total;
      const providerRow = providers.get(`${date}\0${surface}\0${provider}`);
      if (providerRow) providerRow.estimatedCostUsd += estimate.cost.total;
    }

    if (entry.admissionKind) {
      attributionSinceMs = attributionSinceMs === null ? entry.timestamp : Math.min(attributionSinceMs, entry.timestamp);
      const key = `${date}\0${entry.admissionKind}\0${entry.apiKeyId ?? ""}`;
      const bucket = keys.get(key) ?? { requests: 0, requestsWithTimestamp: 0, lastUsedAtMs: null };
      bucket.requests += 1;
      bucket.requestsWithTimestamp += 1;
      bucket.lastUsedAtMs = bucket.lastUsedAtMs === null ? entry.timestamp : Math.max(bucket.lastUsedAtMs, entry.timestamp);
      keys.set(key, bucket);
    }
  }

  const rows: RollupGroupRow[] = [];
  for (const [key, value] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    const [date, surface] = key.split("\0") as [string, RollupSurfaceKey];
    rows.push({ kind: "day", seg, attemptId, date, surface, ...value });
  }
  for (const [key, value] of [...models].sort(([a], [b]) => a.localeCompare(b))) {
    const [date, surface, provider, model] = key.split("\0") as [string, RollupSurfaceKey, string, string];
    const foldedStatusCounts = blankStatuses();
    for (const statuses of value.statusesByRequest.values()) bumpStatus(foldedStatusCounts, foldAttributionStatuses(statuses));
    rows.push({
      kind: "model", seg, attemptId, date, surface, provider, model,
      ...(value.firstResolvedModel ? { resolvedModel: value.firstResolvedModel } : {}),
      requests: value.statusesByRequest.size, attemptCount: value.attemptCount, foldedStatusCounts,
      tokens: { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens },
      estimatedCostUsd: value.estimatedCostUsd,
    });
  }
  for (const [key, value] of [...providers].sort(([a], [b]) => a.localeCompare(b))) {
    const [date, surface, provider] = key.split("\0") as [string, RollupSurfaceKey, string];
    const foldedStatusCounts = blankStatuses();
    for (const statuses of value.statusesByRequest.values()) bumpStatus(foldedStatusCounts, foldAttributionStatuses(statuses));
    rows.push({
      kind: "provider", seg, attemptId, date, surface, provider,
      requests: value.statusesByRequest.size, attemptCount: value.attemptCount, foldedStatusCounts,
      totalTokens: value.totalTokens, estimatedCostUsd: value.estimatedCostUsd,
    });
  }
  for (const [key, value] of [...keys].sort(([a], [b]) => a.localeCompare(b))) {
    const [date, admissionKind, apiKeyId] = key.split("\0") as [string, RollupKeyRow["admissionKind"], string];
    rows.push({ kind: "key", seg, attemptId, date, admissionKind, ...(apiKeyId ? { apiKeyId } : {}), ...value });
  }
  return { rows, attributionSinceMs, oldestTimestampMs };
}

function ensureOwnedFiles(): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  recordOwnedConfigPath(dir, rollupPath());
  recordOwnedConfigPath(dir, rollupMetaPath());
  if (!existsSync(rollupPath())) writeFileSync(rollupPath(), "", { mode: 0o600 });
  try { chmodSync(rollupPath(), 0o600); } catch { /* best-effort */ }
}

function repairAppendBoundary(fd: number): void {
  const size = Number(fstatSync(fd).size);
  if (size === 0) return;
  const lastByte = readExactly(fd, 1, size - 1);
  if (lastByte?.[0] === 0x0a) return;
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - READ_CHUNK_BYTES);
    const chunk = readExactly(fd, end - start, start);
    const lastNewline = chunk?.lastIndexOf(0x0a) ?? -1;
    if (lastNewline >= 0) {
      ftruncateSync(fd, start + lastNewline + 1);
      return;
    }
    end = start;
  }
  ftruncateSync(fd, 0);
}

function boundaryDigest(fd: number, fromOffset: number, toOffset: number): string {
  const length = Math.min(BOUNDARY_DIGEST_BYTES, toOffset - fromOffset);
  const bytes = readExactly(fd, length, toOffset - length);
  if (!bytes) throw new Error("usage boundary became unreadable");
  return sha256(bytes);
}

function boundaryMatches(fd: number, segment: ParsedSegment): boolean {
  try {
    return boundaryDigest(fd, segment.commit.seg, segment.commit.toOffset) === segment.commit.boundaryDigest;
  } catch {
    return false;
  }
}

function removeDerivedFiles(): void {
  for (const path of [rollupPath(), rollupMetaPath()]) {
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function writeMeta(meta: RollupMeta): void {
  const path = rollupMetaPath();
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const bytes = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`);
    writeSync(fd, bytes, 0, bytes.length, null);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameAtomicFile(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    try {
      const dirFd = openSync(getConfigDir(), constants.O_RDONLY);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* directory fsync is unavailable on some platforms */ }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

export async function foldUsagePrefix(): Promise<void> {
  const now = Date.now();
  const currentLineage = lineageKey();
  if (!currentLineage) return;
  ensureOwnedFiles();
  const fingerprint = currentRollupPriceFingerprint();
  let meta = readMeta();
  if (!meta || meta.version !== 1 || meta.lineageKey !== currentLineage || meta.priceFingerprint !== fingerprint) {
    removeDerivedFiles();
    ensureOwnedFiles();
    meta = null;
  }
  let parsed = parseRollup(currentLineage);
  let rawFd: number | undefined;
  try {
    rawFd = openSync(usageLogPath(), "r");
    const rawSize = Number(fstatSync(rawFd).size);
    const lastSegment = parsed.segments.at(-1);
    if (rawSize < parsed.snapshot.cutlineOffset || (lastSegment && !boundaryMatches(rawFd, lastSegment))) {
      closeSync(rawFd);
      rawFd = undefined;
      removeDerivedFiles();
      ensureOwnedFiles();
      parsed = parseRollup(currentLineage);
      rawFd = openSync(usageLogPath(), "r");
    }
    const size = Number(fstatSync(rawFd).size);
    let fromOffset = parsed.snapshot.cutlineOffset;
    // Segment loop: each iteration folds at most `foldSegmentCapBytes` of raw
    // history (the cutline stops at the cap), so a large backlog catches up in
    // bounded-memory slices instead of one whole-prefix materialization.
    for (;;) {
      const toOffset = await eligibleCutline(rawFd, size, fromOffset, now);
      if (toOffset <= fromOffset) break;
      const entries = await parseUsageRange(rawFd, fromOffset, toOffset);
      const foldedAt = Date.now();
      const attemptId = `${foldedAt}-${randomBytes(8).toString("hex")}`;
      const aggregate = accumulateEntries(entries, fromOffset, attemptId);
      const payload = aggregate.rows.map(row => `${JSON.stringify(row)}\n`).join("");
      const commit: RollupCommitRow = {
        kind: "commit", lineageKey: currentLineage, seg: fromOffset, toOffset, attemptId,
        rowCount: aggregate.rows.length, payloadDigest: sha256(payload),
        boundaryDigest: boundaryDigest(rawFd, fromOffset, toOffset),
        attributionSinceMs: aggregate.attributionSinceMs,
        oldestTimestampMs: aggregate.oldestTimestampMs,
        foldedAt,
      };
      const rollupFd = openSync(rollupPath(), constants.O_RDWR | constants.O_CREAT, 0o600);
      try {
        repairAppendBoundary(rollupFd);
        const appendAt = Number(fstatSync(rollupFd).size);
        const bytes = Buffer.from(`${payload}${JSON.stringify(commit)}\n`);
        let written = 0;
        while (written < bytes.length) written += writeSync(rollupFd, bytes, written, bytes.length - written, appendAt + written);
        fsyncSync(rollupFd);
      } finally {
        closeSync(rollupFd);
      }
      fromOffset = toOffset;
    }
    writeMeta({
      version: 1,
      lineageKey: currentLineage,
      priceFingerprint: fingerprint,
      lastFoldAttemptAt: now,
      updatedAt: Date.now(),
    });
  } finally {
    if (rawFd !== undefined) closeSync(rawFd);
  }
}

export async function ensureRollupCurrent(): Promise<void> {
  if (rollupFlight) return rollupFlight;
  const task = (async () => {
    try {
      const meta = readMeta();
      const currentLineage = lineageKey();
      const fingerprint = currentRollupPriceFingerprint();
      if (meta && currentLineage && meta.version === 1 && meta.lineageKey === currentLineage
        && meta.priceFingerprint === fingerprint
        && Date.now() - meta.lastFoldAttemptAt < ROLLUP_ATTEMPT_THROTTLE_MS) return;
      await foldUsagePrefix();
    } catch {
      // The rollup is a derived cache; raw-tail-only service is always safe.
    }
  })();
  rollupFlight = task;
  try { await task; } finally { if (rollupFlight === task) rollupFlight = null; }
}

export function resetRollupForTests(): void {
  rollupFlight = null;
  boundaryValidationCache = null;
}
