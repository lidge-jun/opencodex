/**
 * Token Guardian — background proactive OAuth refresh.
 *
 * Keeps idle tokens from aging out server-side (the reported multi-account Codex-pool bug) by
 * refreshing them BEFORE a request needs them. It is a CALLER of the existing refresh machinery —
 * it adds no new refresh/locking logic:
 *   - single-account providers → getValidAccessToken() (in-memory dedup + persist)
 *   - multi-account Codex pool  → getValidCodexToken()  (file lock + generation CAS + grant fingerprint)
 *
 * Safety by construction: the guardian only touches a provider whose EFFECTIVE refreshPolicy is
 * "proactive", and the global switch (config.tokenGuardian.enabled) defaults OFF, so a default
 * install adds zero ToS-detection surface. See devlog 260703_oauth-multi-account-refresh-and-tos.
 */
import { loadConfig } from "../config";
import type { OcxConfig, OcxTokenGuardianConfig } from "../types";
import { listAccounts } from "./store";
import { getValidAccessTokenForAccount, listOAuthProviders, OAuthLoginRequiredError, resolveRefreshPolicy } from "./index";
import {
  getValidCodexToken,
  listCodexAccountIds,
  readCodexAccountRecord,
  TokenRefreshError,
} from "../codex/account-store";

export interface TokenGuardianHandle {
  stop(): void;
}

export interface GuardianSweepResult {
  enabled: boolean;
  refreshed: string[];
  failed: string[];
  skippedBackoff: string[];
}

const DEFAULTS = {
  tickSeconds: 21600, // 6h — matches codex-lb's guardian cadence
  jitterSeconds: 300,
  concurrency: 3,
  leadSeconds: 900,
  failureBackoffBaseSeconds: 300,
  failureBackoffMaxSeconds: 3600,
};

interface BackoffEntry {
  attempts: number;
  retryAfterMs: number;
}

// Module-scoped so backoff survives across sweeps within one process (keyed "oauth:<p>" / "codex:<id>").
const backoff = new Map<string, BackoffEntry>();

/** Test hook: clear backoff state between cases. */
export function __resetGuardianState(): void {
  backoff.clear();
}

function num(value: number | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function resolved(g: OcxTokenGuardianConfig | undefined) {
  return {
    tickSeconds: num(g?.tickSeconds, DEFAULTS.tickSeconds, 60),
    jitterSeconds: num(g?.jitterSeconds, DEFAULTS.jitterSeconds, 0),
    concurrency: Math.max(1, Math.floor(num(g?.concurrency, DEFAULTS.concurrency, 1))),
    leadSeconds: num(g?.leadSeconds, DEFAULTS.leadSeconds, 0),
    backoffBaseSeconds: num(g?.failureBackoffBaseSeconds, DEFAULTS.failureBackoffBaseSeconds, 0),
    backoffMaxSeconds: num(g?.failureBackoffMaxSeconds, DEFAULTS.failureBackoffMaxSeconds, 0),
  };
}

function inBackoff(key: string, nowMs: number): boolean {
  const entry = backoff.get(key);
  return entry !== undefined && entry.retryAfterMs > nowMs;
}

function recordFailure(key: string, nowMs: number, baseSeconds: number, maxSeconds: number, permanent: boolean): void {
  const prev = backoff.get(key);
  const attempts = (prev?.attempts ?? 0) + 1;
  // Permanent failures (revoked/expired refresh token) wait the full ceiling — nothing but a
  // re-login fixes them, so there is no point retrying sooner.
  const delaySeconds = permanent
    ? maxSeconds
    : Math.min(maxSeconds, baseSeconds * 2 ** (attempts - 1));
  backoff.set(key, { attempts, retryAfterMs: nowMs + delaySeconds * 1000 });
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

/**
 * One refresh sweep. Reads live config + stores; refreshes every proactive-policy credential that
 * will expire before the next sweep (tick + lead horizon). Never throws — per-credential failures
 * are captured into backoff and the result. Returns a redacted summary (provider names / account
 * ids only, never tokens).
 */
export async function guardianSweep(nowMs: number = Date.now()): Promise<GuardianSweepResult> {
  const config: OcxConfig = loadConfig();
  const g = config.tokenGuardian;
  const result: GuardianSweepResult = { enabled: !!g?.enabled, refreshed: [], failed: [], skippedBackoff: [] };
  if (!g?.enabled) return result;

  const opts = resolved(g);
  const horizonMs = (opts.tickSeconds + opts.leadSeconds) * 1000;
  const tasks: Array<() => Promise<void>> = [];

  // A) OAuth providers — every account in each provider's set (multiauth keep-alive),
  // skipping accounts already marked needsReauth (terminal; only a re-login fixes them).
  for (const provider of listOAuthProviders()) {
    if (resolveRefreshPolicy(provider, config) !== "proactive") continue;
    for (const account of listAccounts(provider)) {
      if (account.needsReauth) continue;
      if (account.credential.expires > nowMs + horizonMs) continue;
      const key = `oauth:${provider}:${account.id}`;
      if (inBackoff(key, nowMs)) { result.skippedBackoff.push(key); continue; }
      tasks.push(async () => {
        try {
          await getValidAccessTokenForAccount(provider, account.id);
          backoff.delete(key);
          result.refreshed.push(key);
        } catch (err) {
          // Terminal grant failures surface as OAuthLoginRequiredError (account marked
          // needsReauth by the resolver) — back off at the ceiling; transient errors backoff exponentially.
          const permanent = err instanceof OAuthLoginRequiredError;
          recordFailure(key, nowMs, opts.backoffBaseSeconds, opts.backoffMaxSeconds, permanent);
          result.failed.push(key);
        }
      });
    }
  }

  // B) multi-account Codex pool (gated on the chatgpt provider's policy)
  if (resolveRefreshPolicy("chatgpt", config) === "proactive") {
    for (const id of listCodexAccountIds()) {
      const record = readCodexAccountRecord(id);
      const cred = record?.deletedAt == null ? record?.credential : undefined;
      if (!cred) continue;
      if (cred.expiresAt > nowMs + horizonMs) continue;
      const key = `codex:${id}`;
      if (inBackoff(key, nowMs)) { result.skippedBackoff.push(key); continue; }
      tasks.push(async () => {
        try {
          await getValidCodexToken(id);
          backoff.delete(key);
          result.refreshed.push(key);
        } catch (err) {
          const permanent = err instanceof TokenRefreshError && (err.reason === "revoked" || err.reason === "expired");
          recordFailure(key, nowMs, opts.backoffBaseSeconds, opts.backoffMaxSeconds, permanent);
          result.failed.push(key);
        }
      });
    }
  }

  await runWithConcurrency(tasks, opts.concurrency);
  return result;
}

/**
 * Start the background sweep loop. Returns a handle whose stop() clears the pending timer (in-flight
 * refreshes settle on their own). Schedules recursively so each interval gets fresh jitter. The loop
 * runs even when the guardian is disabled (each sweep is a cheap no-op) so toggling `enabled` in
 * config takes effect on the next tick without a restart.
 */
export function startTokenGuardian(): TokenGuardianHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = () => {
    if (stopped) return;
    const opts = resolved(loadConfig().tokenGuardian);
    const delayMs = (opts.tickSeconds + Math.random() * opts.jitterSeconds) * 1000;
    timer = setTimeout(runSweep, delayMs);
    if (typeof timer.unref === "function") timer.unref(); // never keep the process alive for a sweep
  };

  const runSweep = () => {
    void guardianSweep()
      .then(r => {
        if (r.enabled && (r.refreshed.length || r.failed.length)) {
          console.log(`🛡️  token-guardian: refreshed ${r.refreshed.length}, failed ${r.failed.length}`);
        }
      })
      .catch(err => console.log(`token-guardian sweep error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(scheduleNext);
  };

  scheduleNext();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
