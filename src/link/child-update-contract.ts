import { parseStrictSemver } from "../lib/strict-semver";

/**
 * The Home's own copy of the Child's update.orchestrated/1 contract (src/update/orchestrated-plan.ts,
 * orchestrated-outcome.mjs, orchestrated-admission.mjs, orchestrated-entry.ts). Pure and strict: a document with another
 * schema, another key set or an out-of-range field never parses, so remote text never becomes a verdict by accident.
 */
export const UPDATE_PLAN_SCHEMA = "ocx.update.plan/1";
export const UPDATE_RESULT_SCHEMA = "ocx.update.result/1";
export const UPDATE_OUTPUT_MAX_BYTES = 65_536;
export type PlanInstaller = "npm" | "pnpm" | "bun" | "mise" | "desktop-app" | "source" | "unknown";
export type PlanRuntimeOwner = "service" | "desktop-app" | "unmanaged" | "none" | "unknown";
export type PlanReason = "desktop-app-owned" | "source-checkout" | "mise-managed" | "installer-unknown" | "plan-unavailable"
  | "serving-install-unknown" | "cli-not-serving-install" | "runtime-ownership-refused" | "target-unresolved" | "downgrade-refused" | "up-to-date";
export interface ChildUpdatePlan {
  schema: typeof UPDATE_PLAN_SCHEMA; currentVersion: string; targetVersion: string | null; installer: PlanInstaller;
  runtimeOwner: PlanRuntimeOwner; servingPath: string | null; cliPath: string; canApply: boolean; reason?: PlanReason;
  restartRequired: boolean; planToken: string; updateInFlight: boolean; mutationBoundMs: number;
}
export interface ChildUpdateResult {
  schema: typeof UPDATE_RESULT_SCHEMA; applied: boolean; fromVersion: string; toVersion: string | null; installer: PlanInstaller;
  restarted: boolean; healthy: boolean; rolledBack: boolean; error?: string;
}
export type ContractParse<T> = { ok: true; value: T } | { ok: false; reason: "contract-unknown" | "contract-output-invalid" | "contract-output-too-large" };
export type InstallKind = "npm" | "pnpm" | "bun" | "source" | "mise" | "desktop-app" | "goat" | "standalone" | "ocx-child" | "unknown";
export type UpdateRoute = "orchestrated" | "desktop-request" | "owner-action" | "replant" | "none";
export interface PlanClassification {
  installKind: InstallKind; updateRoute: UpdateRoute; updateReason: string | null; installedVersion: string | null;
  targetVersion: string | null; runtimeOwner: PlanRuntimeOwner; planToken: string | null; updateInFlight: boolean; mutationBoundMs: number;
}
export type ApplyState = "succeeded" | "up-to-date" | "busy" | "refused" | "failed" | "uncertain" | "owner-action" | "unsupported";
export interface UpdateApplyVerdict { state: ApplyState; reason: string | null; fromVersion?: string; toVersion?: string; suppressTarget: boolean; reobserve: boolean }

export const PLAN_INSTALLERS: ReadonlySet<string> = new Set<PlanInstaller>(["npm", "pnpm", "bun", "mise", "desktop-app", "source", "unknown"]);
export const PLAN_RUNTIME_OWNERS: ReadonlySet<string> = new Set<PlanRuntimeOwner>(["service", "desktop-app", "unmanaged", "none", "unknown"]);
const PLAN_REASONS: ReadonlySet<string> = new Set<PlanReason>(["desktop-app-owned", "source-checkout", "mise-managed", "installer-unknown",
  "plan-unavailable", "serving-install-unknown", "cli-not-serving-install", "runtime-ownership-refused", "target-unresolved", "downgrade-refused", "up-to-date"]);
const PLAN_KEYS = ["schema", "currentVersion", "targetVersion", "installer", "runtimeOwner", "servingPath", "cliPath", "canApply",
  "restartRequired", "planToken", "updateInFlight", "mutationBoundMs"] as const;
const RESULT_KEYS = ["schema", "applied", "fromVersion", "toVersion", "installer", "restarted", "healthy", "rolledBack"] as const;
const APPLYING_INSTALLERS: ReadonlySet<string> = new Set(["npm", "pnpm", "bun"]);
export const PLAN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ERROR_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_MUTATION_BOUND_MS = 3_600_000;

type Invalid = { ok: false; reason: "contract-output-invalid" };
const invalid: Invalid = { ok: false, reason: "contract-output-invalid" };
const isVersion = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && parseStrictSemver(value) !== null;
const isPath = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 4096 && !value.includes("\0");
const hasExactKeys = (raw: Record<string, unknown>, required: readonly string[], optional: string): boolean => {
  const keys = Object.keys(raw);
  const expected = required.length + (Object.hasOwn(raw, optional) ? 1 : 0);
  return keys.length === expected && required.every(key => Object.hasOwn(raw, key));
};

type Refusal = Extract<ContractParse<never>, { ok: false }>;
/** Size, single line, one JSON object, then the schema; returns the object or the refusal. */
function readDocument(payload: string, schema: string): { raw: Record<string, unknown> } | Refusal {
  if (Buffer.byteLength(payload, "utf8") > UPDATE_OUTPUT_MAX_BYTES) return { ok: false, reason: "contract-output-too-large" };
  const text = payload.trim();
  if (text.length === 0 || /[\r\n]/.test(text)) return invalid;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const raw = value as Record<string, unknown>;
  if (typeof raw.schema === "string" && raw.schema !== schema) return { ok: false, reason: "contract-unknown" };
  if (raw.schema !== schema) return invalid;
  return { raw };
}

export function parseChildUpdatePlan(payload: string): ContractParse<ChildUpdatePlan> {
  const document = readDocument(payload, UPDATE_PLAN_SCHEMA);
  if (!("raw" in document)) return document;
  const { raw } = document;
  if (!hasExactKeys(raw, PLAN_KEYS, "reason")) return invalid;
  const current = raw.currentVersion;
  if (!(current === "unknown" || isVersion(current))) return invalid;
  if (!(raw.targetVersion === null || isVersion(raw.targetVersion))) return invalid;
  if (typeof raw.installer !== "string" || !PLAN_INSTALLERS.has(raw.installer)) return invalid;
  if (typeof raw.runtimeOwner !== "string" || !PLAN_RUNTIME_OWNERS.has(raw.runtimeOwner)) return invalid;
  if (!(raw.servingPath === null || isPath(raw.servingPath)) || !isPath(raw.cliPath)) return invalid;
  if (typeof raw.canApply !== "boolean" || typeof raw.restartRequired !== "boolean" || typeof raw.updateInFlight !== "boolean") return invalid;
  if (raw.reason !== undefined && (typeof raw.reason !== "string" || !PLAN_REASONS.has(raw.reason))) return invalid;
  if (typeof raw.planToken !== "string" || !PLAN_TOKEN_PATTERN.test(raw.planToken)) return invalid;
  const bound = raw.mutationBoundMs;
  if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 1 || bound > MAX_MUTATION_BOUND_MS) return invalid;
  if (raw.canApply !== (raw.reason === undefined)) return invalid;
  if (raw.canApply && (!APPLYING_INSTALLERS.has(raw.installer) || raw.targetVersion === null)) return invalid;
  return { ok: true, value: {
    schema: UPDATE_PLAN_SCHEMA, currentVersion: current as string, targetVersion: raw.targetVersion as string | null,
    installer: raw.installer as PlanInstaller, runtimeOwner: raw.runtimeOwner as PlanRuntimeOwner, servingPath: raw.servingPath as string | null,
    cliPath: raw.cliPath as string, canApply: raw.canApply, ...(raw.reason === undefined ? {} : { reason: raw.reason as PlanReason }),
    restartRequired: raw.restartRequired, planToken: raw.planToken, updateInFlight: raw.updateInFlight, mutationBoundMs: bound,
  } };
}

export function parseChildUpdateResult(payload: string): ContractParse<ChildUpdateResult> {
  const document = readDocument(payload, UPDATE_RESULT_SCHEMA);
  if (!("raw" in document)) return document;
  const { raw } = document;
  if (!hasExactKeys(raw, RESULT_KEYS, "error")) return invalid;
  // fromVersion is the plan's currentVersion, which is "unknown" when the Child could not read its own version.
  if (!(raw.fromVersion === "unknown" || isVersion(raw.fromVersion))) return invalid;
  if (!(raw.toVersion === null || isVersion(raw.toVersion))) return invalid;
  if (typeof raw.installer !== "string" || !PLAN_INSTALLERS.has(raw.installer)) return invalid;
  if (typeof raw.applied !== "boolean" || typeof raw.restarted !== "boolean" || typeof raw.healthy !== "boolean" || typeof raw.rolledBack !== "boolean") return invalid;
  if (raw.error !== undefined && (typeof raw.error !== "string" || !ERROR_TOKEN.test(raw.error))) return invalid;
  return { ok: true, value: {
    schema: UPDATE_RESULT_SCHEMA, applied: raw.applied, fromVersion: raw.fromVersion as string, toVersion: raw.toVersion as string | null,
    installer: raw.installer as PlanInstaller, restarted: raw.restarted, healthy: raw.healthy, rolledBack: raw.rolledBack,
    ...(raw.error === undefined ? {} : { error: raw.error }),
  } };
}

const GOAT_PATHS = ["/.local/share/goat/opencodex/", "\\.local\\share\\goat\\opencodex\\"];

/**
 * First matching row wins (010 "classifyChildUpdatePlan"). launcher (A4) is the plan probe's report of a Node that can
 * run the package launcher; absent or null means no report. Only an npm or pnpm plan read through a census pair uses it.
 */
export function classifyChildUpdatePlan(plan: ChildUpdatePlan, ctx: { homeVersion: string; desktopUpdateRequest: boolean; entry: "pair" | "binary" | null;
  launcher?: "available" | "unavailable" | null }): PlanClassification {
  const row = (installKind: InstallKind, updateRoute: UpdateRoute, updateReason: string | null): PlanClassification => ({
    installKind, updateRoute, updateReason, installedVersion: plan.currentVersion === "unknown" ? null : plan.currentVersion,
    targetVersion: plan.targetVersion, runtimeOwner: plan.runtimeOwner, planToken: plan.planToken, updateInFlight: plan.updateInFlight,
    mutationBoundMs: plan.mutationBoundMs,
  });
  const installer: InstallKind = plan.installer;
  const path = plan.cliPath ?? plan.servingPath ?? "";
  if (plan.installer === "unknown" && GOAT_PATHS.some(marker => path.includes(marker))) return row("goat", "owner-action", "goat");
  if (plan.reason === "up-to-date") return row(installer, "none", "up-to-date");
  if (plan.canApply && plan.targetVersion !== ctx.homeVersion) return row(installer, "none", "target-mismatch");
  if (plan.canApply && (plan.installer === "npm" || plan.installer === "pnpm") && ctx.entry === "pair") {
    // A4: the apply goes through <node> <root>/bin/ocx.mjs, so it needs the Node the plan probe found.
    if (ctx.launcher === "available") return row(installer, "orchestrated", null);
    if (ctx.launcher === "unavailable") return row(installer, "owner-action", "launcher-node-missing");
    return row(installer, "owner-action", "launcher-bypassed");
  }
  if (plan.canApply) return row(installer, "orchestrated", null);
  if (plan.reason === "desktop-app-owned") return row("desktop-app", ctx.desktopUpdateRequest ? "desktop-request" : "owner-action", "desktop-app-owned");
  if (plan.reason === "mise-managed") return row("mise", "owner-action", "mise-managed");
  if (plan.reason === "source-checkout") return row("source", "owner-action", "source-checkout");
  if (plan.reason === "installer-unknown") return row("unknown", "owner-action", "installer-unknown");
  return row(installer, "none", `refused:${plan.reason ?? "plan-unavailable"}`);
}

const verdict = (state: ApplyState, reason: string | null, extra: Partial<UpdateApplyVerdict> = {}): UpdateApplyVerdict =>
  ({ state, reason, ...extra, suppressTarget: extra.suppressTarget ?? false, reobserve: extra.reobserve ?? false });

/** D12 step 5: map the apply exit and its ocx.update.result/1 document to a closed verdict. */
export function mapUpdateApplyExit(code: number, payload: string): UpdateApplyVerdict {
  const parsed = parseChildUpdateResult(payload);
  const result = parsed.ok ? parsed.value : null;
  switch (code) {
    case 0:
      if (result?.applied && result.healthy) return verdict("succeeded", null, { fromVersion: result.fromVersion, ...(result.toVersion === null ? {} : { toVersion: result.toVersion }) });
      if (result && !result.applied && result.error === undefined) return verdict("up-to-date", null, { fromVersion: result.fromVersion, ...(result.toVersion === null ? {} : { toVersion: result.toVersion }) });
      return verdict("uncertain", "contract-output-invalid", { reobserve: true });
    case 10:
      if (!result) return verdict("refused", "contract-output-invalid");
      if (result.error === "update-in-flight") return verdict("busy", "update-in-flight");
      return verdict("refused", result.error ?? "contract-output-invalid");
    case 11:
      return verdict("failed", result?.rolledBack ? "rolled-back" : "update-failed", { suppressTarget: true });
    case 12:
      return verdict("uncertain", result?.error ?? "outcome-unverified", { reobserve: true });
    case 64:
      return verdict("refused", "contract-usage");
    default:
      // An apply may have started: never assume it did not.
      return verdict("uncertain", "unexpected-exit", { reobserve: true });
  }
}

