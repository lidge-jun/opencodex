/** Value-free wire boundary. Canonical DTO imports erase at runtime; no GUI or writer dependency. */
import type {
  IntegrationMutationPlan, IntegrationPlanOperation, IntegrationPlanChangeKind,
  IntegrationPlanForeignEdit, IntegrationPlanChange, RefusalReason as IntegrationRefusalReason,
} from "../integrations/mutation-plan";
import type { IntegrationClientId as FileIntegrationClientId } from "../integrations/registry";
import type { IntegrationState } from "../integrations/state";

export const FILE_INTEGRATION_CLIENTS = [
  "opencode",
  "pi",
  "omp",
  "hermes",
  "openclaw",
  "kimi",
  "gajae",
  "dsh",
  "mcode",
  "zcode",
  "prime",
  "aside",
  "raycast",
  "omo",
  "cline",
  "kilo",
  "droid",
] as const;

export const INTEGRATION_REFUSAL_REASONS: ReadonlySet<string> = new Set<IntegrationRefusalReason>([
  "not_installed",
  "conflict",
  "unsafe",
  "non_loopback",
  "superseded_store",
  "drift_requires_confirm",
  "snapshot_expired",
  "write_failed",
]);
export const INTEGRATION_STATES: ReadonlySet<string> = new Set<IntegrationState>([
  "absent",
  "current",
  "stale",
  "conflict",
  "unsafe",
]);
const PLAN_OPERATIONS: readonly IntegrationPlanOperation[] = ["apply", "overwrite", "disable", "restore"];
const PLAN_CHANGE_KINDS: readonly IntegrationPlanChangeKind[] = ["add", "replace", "remove", "snapshot", "ownership", "journal"];
const PLAN_FOREIGN_EDITS: readonly IntegrationPlanForeignEdit[] = ["none", "unowned", "foreign-edit", "drift"];
const PLAN_KEYS = new Set(["version", "clientId", "operation", "state", "foreignEdit", "changes", "fingerprint", "canApply", "willChange", "refusalReason", "profileId"]);
const PLAN_CHANGE_KEYS = new Set(["kind", "path"]);
const PLAN_PSEUDO_PATHS = new Set(["$snapshot", "$ownership", "$journal"]);
const PLAN_SCHEMA_PATHS = new Set([
  "provider.opencodex",
  "providers.opencodex",
  "models.providers.opencodex",
  "models.*",
  "llm-pi-ai.providers.opencodex",
  "custom_provider.opencodex",
  "providers.[id=opencodex]",
  "settings.providers.opencodex",
  "catalog.providers.opencodex",
  "customModels.*",
  // ZCode reads its providers from a second file; a plan for it publishes that
  // file's templates, and a path missing here is rejected as an invalid preview.
  "config.providerConfigRules.providerRules.[providerId=opencodex]",
  "config.modelConfigRules.providerModelRules.*",
]);
const PLAN_CHANGE_LIMIT = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function isSafePlanPath(path: string): boolean {
  return PLAN_PSEUDO_PATHS.has(path) || PLAN_SCHEMA_PATHS.has(path);
}

function invalidPreviewResponse(): Error {
  return new Error("Invalid integration preview response");
}

export function decodeIntegrationPlan(value: unknown): IntegrationMutationPlan {
  if (!isRecord(value) || !hasOnlyKeys(value, PLAN_KEYS)
    || value.version !== 1
    || !FILE_INTEGRATION_CLIENTS.includes(value.clientId as FileIntegrationClientId)
    || !PLAN_OPERATIONS.includes(value.operation as IntegrationPlanOperation)
    || (typeof value.state !== "string" || !INTEGRATION_STATES.has(value.state))
    || !PLAN_FOREIGN_EDITS.includes(value.foreignEdit as IntegrationPlanForeignEdit)
    /*
     * The version is matched as a version, not as `p1`. The server calls this
     * token opaque and bumps its prefix whenever the inputs it binds change; a
     * literal here made that bump a silent client-side rejection of every
     * preview, which is a worse failure than the drift it was meant to catch.
     */
    || typeof value.fingerprint !== "string" || !/^p[0-9]+:(?:[0-9a-f]{32}|unbound)$/.test(value.fingerprint)
    || typeof value.canApply !== "boolean" || typeof value.willChange !== "boolean"
    || !Array.isArray(value.changes) || value.changes.length > PLAN_CHANGE_LIMIT
    || (value.profileId !== undefined && (typeof value.profileId !== "number" || !Number.isSafeInteger(value.profileId) || value.profileId < 0))
    || (value.profileId !== undefined && value.clientId !== "aside")
    || (value.refusalReason !== undefined && (typeof value.refusalReason !== "string" || !INTEGRATION_REFUSAL_REASONS.has(value.refusalReason)))) {
    throw invalidPreviewResponse();
  }
  const changes: IntegrationPlanChange[] = [];
  let previousOrder = -1;
  let previousPath = "";
  const seenByKind = new Map<IntegrationPlanChangeKind, Set<string>>();
  for (const item of value.changes) {
    if (!isRecord(item) || !hasOnlyKeys(item, PLAN_CHANGE_KEYS)
      || !PLAN_CHANGE_KINDS.includes(item.kind as IntegrationPlanChangeKind)
      || typeof item.path !== "string" || !isSafePlanPath(item.path)) throw invalidPreviewResponse();
    const order = PLAN_CHANGE_KINDS.indexOf(item.kind as IntegrationPlanChangeKind);
    if (order < previousOrder || (order === previousOrder && item.path <= previousPath)) throw invalidPreviewResponse();
    const kind = item.kind as IntegrationPlanChangeKind;
    const paths = seenByKind.get(kind) ?? new Set<string>();
    if (paths.has(item.path)) throw invalidPreviewResponse();
    paths.add(item.path);
    seenByKind.set(kind, paths);
    previousOrder = order;
    previousPath = item.path;
    changes.push({ kind, path: item.path });
  }
  if ((value.willChange && (!value.canApply || changes.length === 0))
    || (!value.willChange && changes.length !== 0)
    || ((value.fingerprint as string).endsWith(":unbound") && value.canApply)
    || (value.canApply === (value.refusalReason !== undefined))) throw invalidPreviewResponse();
  return {
    version: 1,
    clientId: value.clientId as FileIntegrationClientId,
    operation: value.operation as IntegrationPlanOperation,
    state: value.state as IntegrationState,
    foreignEdit: value.foreignEdit as IntegrationPlanForeignEdit,
    changes,
    fingerprint: value.fingerprint,
    canApply: value.canApply,
    willChange: value.willChange,
    ...(value.refusalReason === undefined ? {} : { refusalReason: value.refusalReason as IntegrationRefusalReason }),
    ...(value.profileId === undefined ? {} : { profileId: Number(value.profileId) }),
  };
}
