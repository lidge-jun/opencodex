/**
 * Phase 3 opt-in auto-cleanup policy (issue #42).
 *
 * Default OFF — never enabled implicitly. Selects oldest archived sessions via
 * Phase 2 helpers and runs `executeArchivedCleanup` in quarantine/permanent mode.
 * On `codex_busy`, defers (updates `nextRun`) without mutating archives.
 *
 * Privacy: logs never include host paths, digests of file contents, or secrets.
 */
import { resolveCodexHomeDir } from "../codex/home";
import { loadConfig, saveConfigPreservingClaudeCode } from "../config";
import type { StorageCleanupPolicy } from "../types";
import {
  computePreviewDigest,
  executeArchivedCleanup,
  filterCandidatesExcludingPinned,
  listArchivedCandidates,
  previewExactArchivedCleanup,
  selectOldestPercentSkippingPendingRestore,
  selectReduceToBytesSkippingPendingRestore,
  type CleanupMode,
  type CleanupResult,
  type ExecuteCleanupOptions,
} from "./cleanup";

export const DEFAULT_ARCHIVED_BYTES_OVER = 5 * 1024 ** 3; // 5 GiB
export const DEFAULT_REMOVE_OLDEST_PERCENT = 25;
export const BUSY_DEFER_MS = 15 * 60 * 1000;

/** Optional sink so background policy writes stay synced with the live server config. */
let livePolicySink: ((policy: StorageCleanupPolicy) => void) | undefined;

export function setStorageCleanupPolicyLiveSink(
  sink: ((policy: StorageCleanupPolicy) => void) | null,
): void {
  livePolicySink = sink ?? undefined;
}

export type PolicySchedule = StorageCleanupPolicy["schedule"];
export type PolicyRunReason = "startup" | "schedule" | "manual";

export type PolicySkipReason =
  | "disabled"
  | "not_due"
  | "under_threshold"
  | "nothing_selected";

export interface PolicyRunResult {
  ok: boolean;
  skipped?: PolicySkipReason;
  deferred?: "codex_busy";
  error?: CleanupResult["error"];
  mode?: CleanupMode;
  freedBytes?: number;
  removed?: number;
  trashDir?: string;
  policy: StorageCleanupPolicy;
}

export interface PolicyRunDeps {
  now?: number;
  reason: PolicyRunReason;
  codexHome?: string;
  /** Bypass due-window checks (tests / explicit force). Still respects enabled. */
  force?: boolean;
  loadPolicy?: () => StorageCleanupPolicy;
  savePolicy?: (policy: StorageCleanupPolicy) => void;
  execute?: (options: ExecuteCleanupOptions) => CleanupResult;
  busyTimeoutMs?: number;
  /**
   * Test-only: block after the start-of-job policy load so a concurrent PUT can
   * land before completion merges run metadata.
   */
  holdAfterLoadMs?: number;
}

/** Canonical defaults — enabled is always false. */
export function defaultStorageCleanupPolicy(): StorageCleanupPolicy {
  return {
    enabled: false,
    trigger: { archivedBytesOver: DEFAULT_ARCHIVED_BYTES_OVER },
    target: { removeOldestPercent: DEFAULT_REMOVE_OLDEST_PERCENT },
    schedule: "manual",
    mode: "quarantine",
  };
}

function isFiniteNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && Math.floor(n) === n;
}

function isFinitePositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && Math.floor(n) === n;
}

/** True when target has exactly one of reduceToBytes / removeOldestPercent. */
export function isValidPolicyTarget(target: StorageCleanupPolicy["target"]): boolean {
  if (!target || typeof target !== "object") return false;
  const reduce = (target as { reduceToBytes?: unknown }).reduceToBytes;
  const percent = (target as { removeOldestPercent?: unknown }).removeOldestPercent;
  const hasReduce = reduce !== undefined;
  const hasPercent = percent !== undefined;
  if (hasReduce === hasPercent) return false; // none or both
  if (hasReduce) return isFiniteNonNegInt(reduce);
  return typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100;
}

/**
 * Normalize a partial/unknown policy into a complete StorageCleanupPolicy.
 * Never flips enabled to true unless the input explicitly sets enabled: true.
 */
export function normalizeStorageCleanupPolicy(raw: unknown): StorageCleanupPolicy {
  const base = defaultStorageCleanupPolicy();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;

  // only explicit true enables — and never when a present target is malformed
  let enabled = o.enabled === true;

  let archivedBytesOver = base.trigger.archivedBytesOver;
  if (o.trigger && typeof o.trigger === "object" && !Array.isArray(o.trigger)) {
    const t = (o.trigger as { archivedBytesOver?: unknown }).archivedBytesOver;
    if (isFiniteNonNegInt(t)) archivedBytesOver = t;
  }

  let target: StorageCleanupPolicy["target"] = base.target;
  if (Object.prototype.hasOwnProperty.call(o, "target")) {
    if (o.target && typeof o.target === "object" && !Array.isArray(o.target)) {
      const candidate = o.target as StorageCleanupPolicy["target"];
      if (isValidPolicyTarget(candidate)) {
        const reduce = (candidate as { reduceToBytes?: number }).reduceToBytes;
        const percent = (candidate as { removeOldestPercent?: number }).removeOldestPercent;
        target = reduce !== undefined
          ? { reduceToBytes: reduce }
          : { removeOldestPercent: Math.min(100, Math.max(1, Math.floor(percent!))) };
      } else {
        // Fail closed: malformed persisted target must not become delete-oldest 25%.
        enabled = false;
      }
    } else {
      enabled = false;
    }
  }

  const schedule: PolicySchedule =
    o.schedule === "startup" || o.schedule === "daily" || o.schedule === "weekly" || o.schedule === "manual"
      ? o.schedule
      : base.schedule;

  const mode: CleanupMode = o.mode === "permanent" ? "permanent" : "quarantine";

  let lastRun: StorageCleanupPolicy["lastRun"];
  if (o.lastRun && typeof o.lastRun === "object" && !Array.isArray(o.lastRun)) {
    const lr = o.lastRun as Record<string, unknown>;
    if (
      isFinitePositiveInt(lr.at)
      && isFiniteNonNegInt(lr.freedBytes)
      && isFiniteNonNegInt(lr.removed)
    ) {
      lastRun = { at: lr.at, freedBytes: lr.freedBytes, removed: lr.removed };
    }
  }

  let nextRun: number | undefined;
  if (o.nextRun === undefined || o.nextRun === null) {
    nextRun = undefined;
  } else if (isFinitePositiveInt(o.nextRun)) {
    nextRun = o.nextRun;
  }

  return {
    enabled,
    trigger: { archivedBytesOver },
    target,
    schedule,
    mode,
    ...(lastRun ? { lastRun } : {}),
    ...(nextRun !== undefined ? { nextRun } : {}),
  };
}

/**
 * Validate a PUT body. Returns a normalized policy or an error string.
 * Does not invent enabled=true.
 */
export function parseStorageCleanupPolicyInput(
  raw: unknown,
  previous?: StorageCleanupPolicy,
): { ok: true; policy: StorageCleanupPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const prev = previous ?? defaultStorageCleanupPolicy();

  if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (o.mode !== undefined && o.mode !== "quarantine" && o.mode !== "permanent") {
    return { ok: false, error: "mode must be quarantine or permanent" };
  }
  if (
    o.schedule !== undefined
    && o.schedule !== "startup"
    && o.schedule !== "daily"
    && o.schedule !== "weekly"
    && o.schedule !== "manual"
  ) {
    return { ok: false, error: "schedule must be startup, daily, weekly, or manual" };
  }

  const merged: Record<string, unknown> = {
    ...prev,
    ...o,
    trigger: o.trigger !== undefined ? o.trigger : prev.trigger,
    target: o.target !== undefined ? o.target : prev.target,
    // Preserve run metadata unless the client explicitly sends replacements.
    lastRun: o.lastRun !== undefined ? o.lastRun : prev.lastRun,
    nextRun: o.nextRun !== undefined ? o.nextRun : prev.nextRun,
  };

  if (o.trigger !== undefined) {
    if (!o.trigger || typeof o.trigger !== "object" || Array.isArray(o.trigger)) {
      return { ok: false, error: "trigger must be an object" };
    }
    const bytes = (o.trigger as { archivedBytesOver?: unknown }).archivedBytesOver;
    if (!isFiniteNonNegInt(bytes)) {
      return { ok: false, error: "trigger.archivedBytesOver must be a non-negative integer" };
    }
  }

  if (o.target !== undefined) {
    if (!isValidPolicyTarget(o.target as StorageCleanupPolicy["target"])) {
      return {
        ok: false,
        error: "target must set exactly one of reduceToBytes (non-negative int) or removeOldestPercent (1-100)",
      };
    }
  }

  // Clients must not clear lastRun/nextRun via null unless intentional — accept omit only.
  const policy = normalizeStorageCleanupPolicy(merged);
  // Recompute nextRun only when schedule newly becomes timed, or no valid nextRun exists.
  // Do not reset nextRun on every PUT that merely re-sends an unchanged schedule.
  if (
    (policy.schedule === "daily" || policy.schedule === "weekly")
    && o.nextRun === undefined
    && (policy.nextRun === undefined || (o.schedule !== undefined && o.schedule !== prev.schedule))
  ) {
    policy.nextRun = computeNextRun(policy.schedule, Date.now());
  }
  if (policy.schedule === "manual" || policy.schedule === "startup") {
    if (o.nextRun === undefined) delete policy.nextRun;
  }

  return { ok: true, policy };
}

export function readStorageCleanupPolicyFromConfig(): StorageCleanupPolicy {
  return normalizeStorageCleanupPolicy(loadConfig().storageCleanupPolicy);
}

export function writeStorageCleanupPolicyToConfig(policy: StorageCleanupPolicy): StorageCleanupPolicy {
  const normalized = normalizeStorageCleanupPolicy(policy);
  const config = loadConfig();
  config.storageCleanupPolicy = normalized;
  saveConfigPreservingClaudeCode(config);
  livePolicySink?.(normalized);
  return normalized;
}

/** Wall-clock next run for daily/weekly. Startup/manual → undefined. */
export function computeNextRun(schedule: PolicySchedule, now: number): number | undefined {
  if (schedule === "daily") return now + 24 * 60 * 60 * 1000;
  if (schedule === "weekly") return now + 7 * 24 * 60 * 60 * 1000;
  return undefined;
}

export function isPolicyDue(
  policy: StorageCleanupPolicy,
  now: number,
  reason: PolicyRunReason,
): boolean {
  if (!policy.enabled) return false;
  if (reason === "manual") return true;
  if (policy.schedule === "manual") return false;
  if (policy.schedule === "startup") {
    if (reason === "startup") return true;
    // Honor deferred nextRun (e.g. codex_busy at launch) on later scheduler ticks.
    return reason === "schedule"
      && policy.nextRun !== undefined
      && now >= policy.nextRun;
  }
  // daily / weekly: due when nextRun unset or elapsed
  if (policy.nextRun === undefined) return true;
  return now >= policy.nextRun;
}

/** Oldest-first until archived total would drop to `reduceToBytes`. */
export function selectReduceToBytes(
  candidates: ReturnType<typeof listArchivedCandidates>,
  reduceToBytes: number,
): ReturnType<typeof listArchivedCandidates> {
  if (!Number.isFinite(reduceToBytes) || reduceToBytes < 0) return [];
  const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
  if (total <= reduceToBytes) return [];
  const need = total - reduceToBytes;
  const out: typeof candidates = [];
  let freed = 0;
  for (const c of candidates) {
    out.push(c);
    freed += c.bytes;
    if (freed >= need) break;
  }
  return out;
}

/**
 * Minimal percent in 1..100 such that `selectOldestPercent` returns at least `n` of `m`.
 * Returns 0 when n<=0, 100 when n>=m.
 */
export function percentForAtLeastCount(totalCount: number, selectedCount: number): number {
  if (selectedCount <= 0 || totalCount <= 0) return 0;
  if (selectedCount >= totalCount) return 100;
  for (let pct = 1; pct <= 100; pct++) {
    const got = Math.max(1, Math.floor((totalCount * pct) / 100));
    if (got >= selectedCount) return pct;
  }
  return 100;
}

export interface PolicySelection {
  archivedBytes: number;
  percent: number;
  count: number;
  bytes: number;
  digest: string;
  /** Present when selection is an exact candidate list (reduceToBytes). */
  candidateRelPaths?: string[];
}

/** Build a Phase-2-compatible preview for the active policy target. */
export function selectPolicyPreview(
  policy: StorageCleanupPolicy,
  codexHome: string = resolveCodexHomeDir(),
): PolicySelection {
  const all = listArchivedCandidates(codexHome);
  const archivedBytes = all.reduce((sum, c) => sum + c.bytes, 0);

  const reduceTo = (policy.target as { reduceToBytes?: number }).reduceToBytes;
  const removePct = (policy.target as { removeOldestPercent?: number }).removeOldestPercent;

  if (reduceTo !== undefined) {
    // Exact candidate set — do not approximate via percent (would over-delete).
    const desired = selectReduceToBytesSkippingPendingRestore(all, reduceTo, codexHome);
    const preview = previewExactArchivedCleanup(desired, codexHome);
    return {
      archivedBytes,
      percent: 0,
      count: preview.count,
      bytes: preview.bytes,
      digest: preview.digest,
      candidateRelPaths: preview.candidates.map(c => c.relPath),
    };
  }

  // Reuse the already-listed candidates — avoid a second archive directory walk.
  const percent = Math.min(100, Math.max(0, Math.floor(removePct ?? 0)));
  const selected = selectOldestPercentSkippingPendingRestore(
    filterCandidatesExcludingPinned(all, codexHome),
    percent,
    codexHome,
  );
  return {
    archivedBytes,
    percent,
    count: selected.length,
    bytes: selected.reduce((sum, c) => sum + c.bytes, 0),
    digest: computePreviewDigest(selected, percent),
  };
}

function advanceNextRun(policy: StorageCleanupPolicy, now: number): StorageCleanupPolicy {
  const next = { ...policy };
  const nextRun = computeNextRun(policy.schedule, now);
  if (nextRun === undefined) delete next.nextRun;
  else next.nextRun = nextRun;
  return next;
}

function deferBusy(policy: StorageCleanupPolicy, now: number): StorageCleanupPolicy {
  return { ...policy, nextRun: now + BUSY_DEFER_MS };
}

export type PolicyRunMetadataPatch = {
  now: number;
  /** Advance nextRun from the *latest* schedule, or defer on codex_busy. */
  nextRun: "advance" | "defer_busy";
  lastRun?: StorageCleanupPolicy["lastRun"];
};

/**
 * Reload the latest persisted policy and write only run-owned metadata
 * (`lastRun` / `nextRun`). Preserves concurrent edits to enabled, trigger,
 * target, schedule, and mode that landed while a long run was in flight.
 */
export function commitPolicyRunMetadata(
  load: () => StorageCleanupPolicy,
  save: (policy: StorageCleanupPolicy) => void,
  patch: PolicyRunMetadataPatch,
): StorageCleanupPolicy {
  const latest = normalizeStorageCleanupPolicy(load());
  let next =
    patch.nextRun === "defer_busy"
      ? deferBusy(latest, patch.now)
      : advanceNextRun(latest, patch.now);
  if (patch.lastRun) {
    next = { ...next, lastRun: patch.lastRun };
  }
  save(next);
  return next;
}

function logPolicyEvent(message: string): void {
  console.log(`[storage-policy] ${message}`);
}

/**
 * Evaluate and optionally execute the storage cleanup policy.
 * Disabled / under-threshold / not-due paths never call execute.
 */
export function runStorageCleanupPolicy(deps: PolicyRunDeps): PolicyRunResult {
  const now = deps.now ?? Date.now();
  const load = deps.loadPolicy ?? readStorageCleanupPolicyFromConfig;
  const save = deps.savePolicy ?? writeStorageCleanupPolicyToConfig;
  const execute = deps.execute ?? executeArchivedCleanup;

  const policy = normalizeStorageCleanupPolicy(load());

  if (typeof deps.holdAfterLoadMs === "number" && Number.isFinite(deps.holdAfterLoadMs) && deps.holdAfterLoadMs > 0) {
    Bun.sleepSync(Math.floor(deps.holdAfterLoadMs));
  }

  if (!policy.enabled) {
    return { ok: true, skipped: "disabled", policy };
  }

  if (!deps.force && !isPolicyDue(policy, now, deps.reason)) {
    return { ok: true, skipped: "not_due", policy };
  }

  const selection = selectPolicyPreview(policy, deps.codexHome);
  if (selection.archivedBytes <= policy.trigger.archivedBytesOver) {
    const saved = commitPolicyRunMetadata(load, save, { now, nextRun: "advance" });
    logPolicyEvent("skip under_threshold");
    return { ok: true, skipped: "under_threshold", policy: saved };
  }

  if (selection.count === 0) {
    const saved = commitPolicyRunMetadata(load, save, { now, nextRun: "advance" });
    logPolicyEvent("skip nothing_selected");
    return { ok: true, skipped: "nothing_selected", policy: saved };
  }

  const result = execute({
    percent: selection.percent,
    mode: policy.mode,
    digest: selection.digest,
    ...(selection.candidateRelPaths ? { candidateRelPaths: selection.candidateRelPaths } : {}),
    ...(deps.codexHome ? { codexHome: deps.codexHome } : {}),
    ...(deps.busyTimeoutMs !== undefined ? { busyTimeoutMs: deps.busyTimeoutMs } : {}),
    now,
  });

  if (!result.ok && result.error === "codex_busy") {
    const saved = commitPolicyRunMetadata(load, save, { now, nextRun: "defer_busy" });
    logPolicyEvent("defer codex_busy");
    return { ok: false, deferred: "codex_busy", error: "codex_busy", policy: saved };
  }

  if (!result.ok) {
    // Non-busy failure: still advance schedule so we do not tight-loop.
    const saved = commitPolicyRunMetadata(load, save, { now, nextRun: "advance" });
    logPolicyEvent(`fail ${result.error ?? "cleanup_failed"}`);
    return {
      ok: false,
      error: result.error,
      mode: result.mode,
      ...(result.trashDir ? { trashDir: result.trashDir } : {}),
      policy: saved,
    };
  }

  const saved = commitPolicyRunMetadata(load, save, {
    now,
    nextRun: "advance",
    lastRun: {
      at: now,
      freedBytes: result.bytes,
      removed: result.count,
    },
  });
  logPolicyEvent(
    `ok mode=${result.mode} removed=${result.count} freedBytes=${result.bytes}`,
  );
  return {
    ok: true,
    mode: result.mode,
    freedBytes: result.bytes,
    removed: result.count,
    ...(result.trashDir ? { trashDir: result.trashDir } : {}),
    policy: saved,
  };
}

/** Startup / schedule tick entry — swallows unexpected errors. */
export function maybeRunDueStorageCleanupPolicy(
  reason: PolicyRunReason,
  deps?: Omit<PolicyRunDeps, "reason">,
): PolicyRunResult | null {
  try {
    return runStorageCleanupPolicy({ ...deps, reason });
  } catch {
    logPolicyEvent("error evaluation_failed");
    return null;
  }
}
