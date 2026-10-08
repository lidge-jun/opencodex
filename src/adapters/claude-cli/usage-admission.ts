import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectClaudeCodeToken } from "../../oauth/local-token-detect";
import { readAnthropicUsageQuota } from "../../providers/claude-cli-usage";
import type { ProviderQuota } from "../../providers/quota-types";

export type ClaudeAdmission = {
  state: "available" | "exhausted" | "unknown";
  checkedAt: number;
  resetAt?: number;
  message?: string;
};
type Snapshot = { identity: string; checkedAt: number; quota?: ProviderQuota; refusalUntil?: number };
type Identity = { key: string; access: string };
export type AdmissionDeps = {
  now?: () => number;
  identity?: () => Identity | null;
  probe?: (token: string) => Promise<ProviderQuota | null>;
  statePath?: string;
};
const CACHE_MS = 60_000;
const inflight = new Map<string, Promise<Snapshot>>();
const memory = new Map<string, Snapshot>();

function localIdentity(): Identity | null {
  const credential = detectClaudeCodeToken();
  if (!credential) return null;
  let account: string | undefined;
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
    const configFile = configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
    account = JSON.parse(readFileSync(configFile, "utf8"))?.oauthAccount?.accountUuid;
  } catch { /* Token fingerprint is the fallback when CLI has no account metadata. */ }
  const key = createHash("sha256").update(account || credential.refresh).digest("hex");
  return { key, access: credential.access };
}
function statePath(deps: AdmissionDeps): string {
  return deps.statePath ?? join(homedir(), ".opencodex", "claude-usage-admission.json");
}
function load(path: string): Snapshot | undefined {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (typeof saved.identity !== "string" || !Number.isFinite(saved.checkedAt)) return;
    if (saved.refusalUntil !== undefined && !finite(saved.refusalUntil)) return;
    if (saved.quota !== undefined) {
      const q = saved.quota;
      if (!q || typeof q !== "object" || !finite(q.updatedAt)) return;
      for (const field of ["fiveHourPercent", "fiveHourResetAt", "weeklyPercent", "weeklyResetAt"])
        if (q[field] !== undefined && !finite(q[field])) return;
      if (q.customWindows !== undefined && (!Array.isArray(q.customWindows) || !q.customWindows.every((w: unknown) => {
        if (!w || typeof w !== "object") return false;
        const row = w as Record<string, unknown>;
        return typeof row.label === "string" && finite(row.percent) && (row.resetAt === undefined || finite(row.resetAt));
      }))) return;
    }
    return saved;
  } catch { /* Missing or malformed cache is unknown, never proof of capacity. */ }
  return undefined;
}
function save(path: string, snapshot: Snapshot): void {
  memory.set(path, snapshot);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot) + "\n", { mode: 0o600 });
    renameSync(temp, path);
  } catch { /* Memory still suppresses launches; no secrets or upstream text are persisted. */ }
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
/** Windows that gate this model: the plan windows plus custom windows in scope for its family. */
function applicableWindows(quota: ProviderQuota | undefined, model: string): { percent?: number; resetAt?: number }[] {
  const family = /opus|sonnet|fable|haiku/i.exec(model)?.[0]?.toLowerCase();
  return [
    { percent: quota?.fiveHourPercent, resetAt: quota?.fiveHourResetAt },
    { percent: quota?.weeklyPercent, resetAt: quota?.weeklyResetAt },
    ...(quota?.customWindows ?? []).filter(w => w.scope !== "model" || !family || w.label.toLowerCase() === family),
  ];
}
/** A reset time in the proxy host's own time zone (or the given one), with the zone named. */
export function formatClaudeReset(resetAt: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}), month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(resetAt);
}
function full(w: { percent?: number }): boolean { return finite(w.percent) && w.percent >= 100; }
function admission(snapshot: Snapshot, model: string, now: number): ClaudeAdmission {
  const quota = snapshot.quota;
  const exhausted = applicableWindows(quota, model).filter(w => full(w) && (!finite(w.resetAt) || w.resetAt > now));
  if (finite(snapshot.refusalUntil) && snapshot.refusalUntil > now) exhausted.push({ percent: 100, resetAt: snapshot.refusalUntil });
  if (exhausted.length) {
    const resets = exhausted.map(w => w.resetAt).filter(finite);
    // Unknown reset windows require another read after the short cache, not an invented reset date.
    const resetAt = resets.length === exhausted.length ? Math.max(...resets) : Math.max(snapshot.checkedAt + CACHE_MS, ...resets);
    return { state: "exhausted", checkedAt: snapshot.checkedAt, resetAt, message: `Claude subscription limits are exhausted. Claude launches are paused until ${formatClaudeReset(resetAt)}, then usage will be checked again.` };
  }
  return { state: quota ? "available" : "unknown", checkedAt: snapshot.checkedAt };
}

/** Read-only quota preflight. One shared file serves Codex, Pi and the delegation check. */
export async function checkClaudeUsageAdmission(model = "", deps: AdmissionDeps = {}): Promise<ClaudeAdmission> {
  const now = (deps.now ?? Date.now)();
  const identity = (deps.identity ?? localIdentity)();
  if (!identity) return { state: "unknown", checkedAt: now };
  const path = statePath(deps);
  const disk = load(path);
  const local = memory.get(path);
  const cached = [disk, local].filter((s): s is Snapshot => s?.identity === identity.key).sort((a, b) => b.checkedAt - a.checkedAt || (b.refusalUntil ?? 0) - (a.refusalUntil ?? 0))[0];
  if (cached?.identity === identity.key) {
    const status = admission(cached, model, now);
    if (status.state === "exhausted" && status.resetAt! > now) return status;
    // Same windows and threshold as admission(): only a full window in scope for this model forces a re-read.
    const expiredReset = [cached.refusalUntil, ...applicableWindows(cached.quota, model).filter(full).map(w => w.resetAt)]
      .some(reset => finite(reset) && reset <= now);
    if (!expiredReset && now >= cached.checkedAt && now - cached.checkedAt < CACHE_MS) return status;
  }
  const requestKey = `${path}:${identity.key}`;
  let probe = inflight.get(requestKey);
  if (!probe) {
    probe = (async () => {
      let quota: ProviderQuota | null = null;
      try { quota = await (deps.probe ?? readAnthropicUsageQuota)(identity.access); } catch { /* Unavailable is unknown. */ }
      const prior = load(path);
      const refusalUntil = prior?.identity === identity.key && finite(prior.refusalUntil) && prior.refusalUntil > (deps.now ?? Date.now)()
        ? prior.refusalUntil : undefined;
      const snapshot: Snapshot = { identity: identity.key, checkedAt: (deps.now ?? Date.now)(), ...(quota ? { quota } : {}), ...(refusalUntil ? { refusalUntil } : {}) };
      // Don't persist an old account's response after login changes during a probe.
      if ((deps.identity ?? localIdentity)()?.key === identity.key) save(path, snapshot);
      return snapshot;
    })().finally(() => inflight.delete(requestKey));
    inflight.set(requestKey, probe);
  }
  return admission(await probe, model, (deps.now ?? Date.now)());
}

/** Parse Claude's explicit next-clock reset, including its IANA timezone. */
let preflightOverride: ((model: string) => Promise<ClaudeAdmission>) | undefined;
/** Test seam for the pre-dispatch check in the Responses executor; call with no argument to restore. */
export function setClaudeUsagePreflightForTests(fn?: (model: string) => Promise<ClaudeAdmission>): void { preflightOverride = fn; }
/** The pre-dispatch check the Responses executor runs before a claude-cli turn. */
export function claudeUsagePreflight(model: string): Promise<ClaudeAdmission> {
  return (preflightOverride ?? checkClaudeUsageAdmission)(model);
}

export function parseClaudeReset(message: string, now = Date.now()): number | undefined {
  if (!/hit.*limit|usage limit|rate limit/i.test(message)) return;
  const match = /resets?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if (!match) return;
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return;
  const hours = hour % 12 + (match[3]!.toLowerCase() === "pm" ? 12 : 0);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: match[4], year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const parts = (time: number) => Object.fromEntries(formatter.formatToParts(time).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
    const date = parts(now);
    for (let day = 0; day < 2; day++) {
      const target = Date.UTC(date.year!, date.month! - 1, date.day! + day, hours, minute);
      let epoch = target;
      for (let i = 0; i < 3; i++) {
        const p = parts(epoch);
        epoch += target - Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
      }
      if (epoch > now && epoch - now <= 26 * 60 * 60_000) return epoch;
    }
  } catch { /* An invalid or unsupported timezone never establishes a cooldown. */ }
}

export function recordClaudeUsageRefusal(message: string, deps: AdmissionDeps = {}): void {
  const now = (deps.now ?? Date.now)();
  const until = parseClaudeReset(message, now);
  const identity = (deps.identity ?? localIdentity)();
  if (!until || !identity) return;
  const path = statePath(deps);
  const old = load(path);
  const same = old?.identity === identity.key ? old : undefined;
  save(path, { identity: identity.key, checkedAt: now, ...(same?.quota ? { quota: same.quota } : {}), refusalUntil: Math.max(until, same?.refusalUntil ?? 0) });
}

if (import.meta.main) {
  const status = await checkClaudeUsageAdmission(process.argv[2] ?? "");
  console.log(JSON.stringify(status));
  // Unknown is not approval to fan out. Direct manual use can still let Claude refresh auth.
  process.exitCode = status.state === "available" ? 0 : status.state === "exhausted" ? 2 : 3;
}
