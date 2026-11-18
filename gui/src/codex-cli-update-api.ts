/**
 * Dashboard client for the Codex CLI update workflow (#2811). The server owns every decision:
 * the read-only plan, the planId it binds, admission, the install and its readback
 * (src/server/management/codex-cli-update-routes.ts). This module only reads those DTOs and
 * posts the one confirmed request; it never regenerates a plan or retries an ambiguous result.
 */

export type CodexCliProvenance = "npm-global" | "app-bundle" | "version-manager" | "standalone-unverified" | "unknown";
export type CodexCliSessionState = "none" | "active" | "unknown" | "not-evaluated";
export type CodexCliJobStatus = "queued" | "running" | "applied" | "not_applied" | "refused" | "ambiguous";

export interface CodexCliUpdatePlanView {
  applicable: boolean;
  refusal: string | null;
  planId: string | null;
  provenance: CodexCliProvenance;
  managed: boolean;
  installedVersion: string | null;
  targetVersion: string | null;
  location: string | null;
  session: { state: CodexCliSessionState; matches: number | null };
  command: readonly string[] | null;
}

export interface CodexCliUpdateJobView {
  jobId: string;
  status: CodexCliJobStatus;
  ownerState: "active" | "unknown" | "finished";
  planId: string;
  reason: string | null;
}

/** A refused or failed request. `retryable` is true only where the same requestId may be sent again. */
export class CodexCliUpdateError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, status: number, retryable: boolean) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const PROVENANCE = new Set(["npm-global", "app-bundle", "version-manager", "standalone-unverified", "unknown"]);
const SESSION = new Set(["none", "active", "unknown", "not-evaluated"]);
const STATUS = new Set(["queued", "running", "applied", "not_applied", "refused", "ambiguous"]);
const OWNER = new Set(["active", "unknown", "finished"]);
/** Failures after which resending the same request is idempotent: the server returns the job it already admitted, if any, and never admits a second. */
const RETRYABLE_APPLY = new Set(["job_store_busy", "admission_failed", "network"]);

const str = (value: unknown): string | null => typeof value === "string" ? value : null;

export function readPlan(value: unknown): CodexCliUpdatePlanView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const session = row.session as Record<string, unknown> | undefined;
  if (typeof row.applicable !== "boolean" || typeof row.managed !== "boolean"
    || !PROVENANCE.has(row.provenance as string) || !session || !SESSION.has(session.state as string)) return null;
  const command = Array.isArray(row.command) && row.command.every(part => typeof part === "string") ? row.command as string[] : null;
  return {
    applicable: row.applicable, refusal: str(row.refusal), planId: str(row.planId),
    provenance: row.provenance as CodexCliProvenance, managed: row.managed,
    installedVersion: str(row.installedVersion), targetVersion: str(row.targetVersion), location: str(row.location),
    session: { state: session.state as CodexCliSessionState, matches: typeof session.matches === "number" ? session.matches : null },
    command,
  };
}

export function readJob(value: unknown): CodexCliUpdateJobView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.jobId !== "string" || !STATUS.has(row.status as string) || !OWNER.has(row.ownerState as string)
    || typeof row.planId !== "string") return null;
  return { jobId: row.jobId, status: row.status as CodexCliJobStatus, ownerState: row.ownerState as CodexCliUpdateJobView["ownerState"],
    planId: row.planId, reason: str(row.reason) };
}

/** Apply is offered only for an applicable plan with a bound id, after the operator confirmed it. */
export function canApply(plan: CodexCliUpdatePlanView | null, confirmed: boolean): boolean {
  return !!plan && plan.applicable && plan.refusal === null && plan.planId !== null && confirmed;
}

/** A job is settled once its status is final and no owner is still writing it. */
export function isTerminalJob(job: CodexCliUpdateJobView): boolean {
  return job.status !== "queued" && job.status !== "running" && job.ownerState !== "active";
}

async function errorCode(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json() as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch { return fallback; }
}

export async function fetchCodexCliUpdatePlan(apiBase: string, signal: AbortSignal): Promise<CodexCliUpdatePlanView> {
  const res = await fetch(`${apiBase}/api/codex/cli-update/plan`, { signal, cache: "no-store" });
  if (!res.ok) throw new CodexCliUpdateError(await errorCode(res, "plan_unavailable"), res.status, false);
  const plan = readPlan(await res.json());
  if (!plan) throw new CodexCliUpdateError("plan_unavailable", res.status, false);
  return plan;
}

export async function applyCodexCliUpdate(apiBase: string, request: { requestId: string; planId: string }, signal: AbortSignal): Promise<CodexCliUpdateJobView> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/codex/cli-update/apply`, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: request.requestId, planId: request.planId, confirmed: true }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new CodexCliUpdateError("network", 0, true);
  }
  if (!res.ok) {
    const code = await errorCode(res, "admission_failed");
    throw new CodexCliUpdateError(code, res.status, RETRYABLE_APPLY.has(code));
  }
  const job = readJob(((await res.json()) as { job?: unknown }).job);
  if (!job) throw new CodexCliUpdateError("job_result_unknown", res.status, false);
  return job;
}

export async function fetchCodexCliUpdateJob(apiBase: string, jobId: string, signal: AbortSignal): Promise<CodexCliUpdateJobView> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/codex/cli-update/jobs/${encodeURIComponent(jobId)}`, { signal, cache: "no-store" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new CodexCliUpdateError("network", 0, true);
  }
  if (!res.ok) {
    const code = await errorCode(res, "job_state_unavailable");
    throw new CodexCliUpdateError(code, res.status, code !== "job_not_found");
  }
  const job = readJob(await res.json());
  if (!job) throw new CodexCliUpdateError("job_state_unavailable", res.status, true);
  return job;
}

/** The terminal equivalents the panel offers when the dashboard cannot apply or read a job. */
export function codexCliApplyCommand(planId: string | null): string {
  return planId ? `ocx system codex-cli-update apply --plan-id ${planId} --yes` : "ocx system codex-cli-update plan";
}

export function codexCliStatusCommand(jobId: string): string {
  return `ocx system codex-cli-update status ${jobId} --json`;
}

/**
 * A fresh request id. `crypto.randomUUID` exists only in secure contexts; `getRandomValues`
 * does not need one. Null means no id could be made, and the caller must not send.
 */
export function newCodexCliRequestId(): string | null {
  const api = globalThis.crypto;
  try {
    if (api && typeof api.randomUUID === "function") return api.randomUUID();
  } catch { /* not a secure context: fall through */ }
  if (api && typeof api.getRandomValues === "function") {
    const bytes = api.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }
  return null;
}
