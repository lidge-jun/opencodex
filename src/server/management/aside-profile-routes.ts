import { redactSecretString } from "../../lib/redact";
import { ClientPathError } from "../../clients/config-export";
import { IntegrationMutationBusyError } from "../../integrations/mutation-flight";
import { IntegrationWriterLockBusyError } from "../../integrations/writer-lock";
import {
  getAsideProfileState, listAsideProfileStates, mutateAsideProfiles, previewAsideProfile, refreshAsideProfiles,
  type AsideProfilesInput, type AsideProfileWriteOutcome,
} from "../../integrations/aside-profiles";
import {
  listAsideOperations, findAsideOperation, restoreAsideProfile, deleteAsideOperation,
  asideOperationMatchesCurrent,
} from "../../integrations/aside-profile-journal";
import type { AsideOperation } from "../../integrations/aside-profile-journal";
import type { WriteRefused } from "../../integrations/writer";
import type { IntegrationWriteInput } from "../../integrations/writer";
import type { IntegrationMutationPlan, IntegrationPlanOperation } from "../../integrations/mutation-plan";
import { previewIntegration } from "../../integrations/mutation-plan";
import { exportSnapshotIdentity, previewExportSnapshot } from "./model-rows";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, readOptionalManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { jsonResponse } from "../auth-cors";

export interface AsideProfileRouteOptions {
  input: () => AsideProfilesInput;
  failure: (result: WriteRefused) => Response;
}

class ProfileQueryError extends Error { readonly status = 400; readonly code = "invalid_aside_profile"; }

/**
 * The confirmed plan carried with this request, or null when there is none.
 *
 * Both fields or neither, and the operation must be the one being requested. Dropping a supplied
 * binding would be the worst available behaviour: the caller believes their confirmation is being
 * checked while the mutation proceeds unchecked.
 */
function asideBinding(
  body: { operation?: unknown; planFingerprint?: unknown },
  expected: IntegrationPlanOperation,
): { operation: IntegrationPlanOperation; fingerprint: string } | null {
  const { operation, planFingerprint } = body;
  if (operation === undefined && planFingerprint === undefined) return null;
  if (operation === undefined || typeof planFingerprint !== "string" || planFingerprint.length === 0) {
    throw new ProfileQueryError("operation and planFingerprint must be sent together");
  }
  if (operation !== expected) throw new ProfileQueryError("operation does not match the requested change");
  return { operation: expected, fingerprint: planFingerprint };
}

/**
 * The guard a bound profile change runs before it writes anything.
 *
 * It re-plans the same profile scope and compares. The hooks that call it sit ahead of the
 * preference write and the journal import, which is the only placement that helps here: those two
 * happen before any writer lock is taken, so a check under that lock would fire after the thing it
 * was meant to prevent.
 */
/**
 * The check a bound Aside change runs, against the input that change is about to write from.
 *
 * It plans the prepared input it is given rather than building one of its own. Rebuilding meant
 * reading the live configuration a second time, so a configuration edited to something else and
 * back again while this action was in flight produced a check that agreed with a plan the write
 * never described.
 *
 * Exported so the check itself can be exercised with a real prepared input and a roster that
 * actually moved. The window it closes needs an ordinary load to complete while a mutation is
 * preparing, which no test seam reaches from outside; a copy of the guard would prove nothing
 * about the one the route installs. It takes only the configuration from the request context.
 */
export function asideGuardFor(
  ctx: Pick<ManagementContext, "config">,
  capturedIdentity: string,
  profileIdValue: number,
  binding: { operation: IntegrationPlanOperation; fingerprint: string },
  request: { opId?: string; confirmDrift?: boolean; resolved?: AsideOperation },
  capture: { plan: IntegrationMutationPlan | null },
): (prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null> {
  return async prepared => {
    const plan = planFor(prepared, profileIdValue, binding, request);
    /*
     * The roster this confirmation was planned against has to still be the retained one. Only its
     * rows were carried into the mutation, so an ordinary load completing while this action
     * prepared could have replaced or retired the snapshot, and fingerprinting the carried rows
     * would then accept a confirmation for a roster the operator no longer has. The non-Aside
     * guard verifies the same identity; this one verifies it before the preference write, which is
     * the last moment that still precedes every effect this action has.
     */
    const rosterMoved = exportSnapshotIdentity(ctx.config) !== capturedIdentity;
    if (!rosterMoved && plan.canApply && plan.fingerprint === binding.fingerprint) return null;
    capture.plan = plan;
    return {
      ok: false,
      reason: "conflict",
      state: plan.state,
      clientId: "aside",
      message: rosterMoved
        ? "the model roster changed while confirming"
        : "that confirmation no longer describes this profile",
      profileId: profileIdValue,
    };
  };
}

/**
 * The same comparison, run again immediately before the document is written.
 *
 * Aside takes no writer lock, and its preference write and journal import sit between the first
 * check and the write that check authorizes. A target edited in that window is read fresh by the
 * writer, which then compares it against itself and finds nothing to object to, so a confirmation
 * about the earlier file would still overwrite the later one.
 *
 * The roster is deliberately not re-examined here. This action has just written the operator's
 * preference into the configuration, which retires the retained roster by design, so asking that
 * question at this point would refuse every confirmation on principle. What is asked is the one
 * thing this moment can answer: does the plan the operator confirmed still describe this file.
 */
export function asideLateGuardFor(
  profileIdValue: number,
  binding: { operation: IntegrationPlanOperation; fingerprint: string },
  request: { opId?: string; confirmDrift?: boolean; resolved?: AsideOperation },
  capture: { plan: IntegrationMutationPlan | null },
): (prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null> {
  return async prepared => {
    const plan = planFor(prepared, profileIdValue, binding, request);
    if (plan.canApply && plan.fingerprint === binding.fingerprint) return null;
    capture.plan = plan;
    return {
      ok: false,
      reason: "conflict",
      state: plan.state,
      clientId: "aside",
      message: "that confirmation no longer describes this profile",
      profileId: profileIdValue,
    };
  };
}

function planFor(
  prepared: IntegrationWriteInput,
  profileIdValue: number,
  binding: { operation: IntegrationPlanOperation; fingerprint: string },
  request: { opId?: string; confirmDrift?: boolean; resolved?: AsideOperation },
): IntegrationMutationPlan {
  return previewIntegration(prepared, {
    profileId: profileIdValue,
    operation: binding.operation,
    ...(request.opId === undefined ? {} : { opId: request.opId }),
    ...(request.confirmDrift === undefined ? {} : { confirmDrift: request.confirmDrift }),
    // The row the route selected, so the guard and the mutation mean the same operation even
    // when more than one valid copy exists.
    ...(request.resolved === undefined
      ? {}
      : { resolved: { entry: request.resolved.entry, store: request.resolved.store } }),
  });
}

function stalePlanResponse(ctx: ManagementContext, plan: IntegrationMutationPlan): Response {
  return jsonResponse({
    error: "integration preview is stale",
    code: "integration_preview_stale",
    plan,
  }, 409, ctx.req, ctx.config);
}

const ASIDE_INTEGRATION_PATH = "/api/client-integrations/aside";
const ASIDE_PROFILES_PATH = "/api/client-integrations/aside/profiles";

function profileId(ctx: ManagementContext): number | undefined {
  const raw = ctx.url.searchParams.get("profile");
  if (raw === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ProfileQueryError("profile must be a nonnegative integer account ID");
  }
  return Number(raw);
}

function errorResponse(error: unknown, ctx: ManagementContext): Response {
  rethrowManagementBodyTooLarge(error);
  const detail = error as { status?: unknown; code?: unknown } | null;
  const busy = error instanceof IntegrationMutationBusyError || error instanceof IntegrationWriterLockBusyError;
  const status = busy ? 409 : typeof detail?.status === "number" && [400,404,409,410,500].includes(detail.status)
    ? detail.status : error instanceof ClientPathError ? 409 : 500;
  const code = busy ? "integration_mutation_busy"
    : typeof detail?.code === "string" ? detail.code : "aside_profile_error";
  return jsonResponse({
    error: redactSecretString(error instanceof Error ? error.message : "Aside profile operation failed"),
    code, clientId: "aside",
  }, status, ctx.req, ctx.config);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readProfileBody(req: Request, optional = false): Promise<unknown> {
  try { return await (optional ? readOptionalManagementJsonBody(req) : readManagementJsonBody(req)); }
  catch (error) { rethrowManagementBodyTooLarge(error); throw new ProfileQueryError("invalid JSON body"); }
}

function validateClientSelector(ctx: ManagementContext): void {
  const client = ctx.url.searchParams.get("client");
  if (client !== null && client !== "aside") throw new ProfileQueryError("client/profile selectors must identify Aside");
}

/** Dedicated scoped paths fail closed even when a newer client reaches an older server. */
function nestedProfileContext(ctx: ManagementContext): { ctx: ManagementContext; action?: string } {
  const prefix = "/api/client-integrations/aside/profiles/";
  if (!ctx.url.pathname.startsWith(prefix)) return { ctx };
  validateClientSelector(ctx);
  const parts = ctx.url.pathname.slice(prefix.length).split("/");
  const url = new URL(ctx.url);
  if (parts.length === 1 && parts[0] === "journal") {
    if (url.searchParams.has("profile")) throw new ProfileQueryError("Use a profile-specific journal path");
    url.pathname = "/api/client-integrations/journal";
    url.searchParams.set("client", "aside");
    return { ctx: { ...ctx, url }, action: "journal" };
  }
  if (parts.length > 2 || !parts[0] || (parts[1] !== undefined && !["journal", "restore", "preview"].includes(parts[1]))) {
    throw new ProfileQueryError("Invalid Aside profile path");
  }
  const prior = url.searchParams.get("profile");
  if (prior !== null && prior !== parts[0]) throw new ProfileQueryError("Conflicting Aside profile selectors");
  url.searchParams.set("profile", parts[0]);
  url.searchParams.set("client", "aside");
  url.pathname = parts[1] ? `/api/client-integrations/${parts[1]}` : "/api/client-integrations/aside";
  return { ctx: { ...ctx, url }, action: parts[1] };
}

/** Own only Aside status/toggle paths; other clients keep the existing adapter. */
export async function handleAsideProfileRoutes(
  ctx: ManagementContext, options: AsideProfileRouteOptions,
): Promise<Response | null> {
  if (ctx.url.pathname !== ASIDE_INTEGRATION_PATH
    && !ctx.url.pathname.startsWith(`${ASIDE_INTEGRATION_PATH}/`)) return null;
  try {
    const normalized = nestedProfileContext(ctx);
    ctx = normalized.ctx;
    const { req, url } = ctx;
    validateClientSelector(ctx);
    const id = profileId(ctx);
    if (normalized.action === "journal") {
      if (req.method === "GET") return asideJournalResponse(ctx, "aside", options);
      if (req.method === "DELETE") {
        const opId = url.searchParams.get("opId")?.trim();
        if (!opId) throw new ProfileQueryError("opId is required");
        return asideJournalDeleteResponse(ctx, opId, options);
      }
      return null;
    }
    if (normalized.action === "preview") {
      if (req.method !== "POST") return null;
      // A plan describes one profile, so an unscoped preview has nothing to describe.
      if (id === undefined) throw new ProfileQueryError("a plan applies to one profile");
      const body = await readProfileBody(req);
      if (!isObject(body)) throw new ProfileQueryError("preview body must be an object");
      const operation = body.operation;
      if (operation !== "apply" && operation !== "overwrite" && operation !== "disable" && operation !== "restore") {
        throw new ProfileQueryError("operation must be apply, overwrite, disable or restore");
      }
      if (operation === "restore" && (typeof body.opId !== "string" || !body.opId.trim())) {
        throw new ProfileQueryError("opId must be a non-empty string");
      }
      // The preview resolves the row the same way the mutation will, once, here.
      const selected = operation === "restore"
        ? findAsideOperation(options.input(), String(body.opId).trim(), id)
        : null;
      if (operation === "restore" && selected === null) {
        return jsonResponse({
          error: "integration operation not found",
          code: "integration_operation_not_found",
        }, 404, req, ctx.config);
      }
      const roster = previewExportSnapshot(ctx.config);
      if (roster === null) {
        return jsonResponse({
          error: "no model roster is cached yet, so this change cannot be planned",
          code: "integration_preview_unavailable",
        }, 409, req, ctx.config);
      }
      const plan = await previewAsideProfile({ ...options.input(), models: roster.models }, {
        profileId: id,
        operation,
        ...(operation === "restore"
          ? {
            opId: String(body.opId).trim(),
            confirmDrift: body.confirmDrift === true,
            ...(selected === null ? {} : { resolved: { entry: selected.entry, store: selected.store } }),
          }
          : {}),
      });
      return jsonResponse(plan, 200, req, ctx.config);
    }
    if (normalized.action === "restore") {
      if (req.method !== "POST") return null;
      const body = await readProfileBody(req);
      if (!isObject(body) || typeof body.opId !== "string" || !body.opId.trim()
        || (body.confirmDrift !== undefined && typeof body.confirmDrift !== "boolean")) throw new ProfileQueryError("Invalid Aside restore request");
      // Rebuilding the body here previously dropped any binding, so a bound nested restore
      // reached the writer with its confirmation unexamined. Forward the fields as sent.
      return asideRestoreResponse(ctx, {
        opId: body.opId.trim(),
        confirmDrift: body.confirmDrift === true,
        ...(body.operation === undefined ? {} : { operation: body.operation }),
        ...(body.planFingerprint === undefined ? {} : { planFingerprint: body.planFingerprint }),
      }, options);
    }
    if (url.pathname === "/api/client-integrations/aside/sync") {
      if (req.method !== "POST") return null;
      if (id !== undefined) throw new ProfileQueryError("Aside sync uses the server's selected profiles");
      const body = await readProfileBody(req, true);
      if (!isObject(body) || Object.keys(body).length !== 0) throw new ProfileQueryError("Aside sync expects an empty object");
      const results = await refreshAsideProfiles(options.input());
      const ok = results.every(result => result.ok);
      return jsonResponse({ ok, clientId: "aside", results }, ok ? 200 : 207, req, ctx.config);
    }
    if (url.pathname !== ASIDE_INTEGRATION_PATH && url.pathname !== ASIDE_PROFILES_PATH) return null;
    if (req.method !== "GET" && req.method !== "PUT") return null;
    if (url.pathname.endsWith("/profiles") && id !== undefined) throw new ProfileQueryError("Use a profile-specific path");
    if (req.method === "GET") {
      const state = id === undefined ? await listAsideProfileStates(options.input()) : await getAsideProfileState(options.input(), id);
      return jsonResponse(state, 200, req, ctx.config);
    }
    const body = await readProfileBody(req);
    if (!isObject(body) || typeof body.enabled !== "boolean") throw new ProfileQueryError("enabled must be a boolean");
    if (body.overwriteConflict !== undefined && typeof body.overwriteConflict !== "boolean") throw new ProfileQueryError("overwriteConflict must be a boolean");
    if (body.overwriteConflict === true && !body.enabled) throw new ProfileQueryError("overwriteConflict applies only to enabling an integration");
    // An exact profile is required before a binding could ever mean anything: one fingerprint
    // cannot honestly describe several independently changing files.
    const expected: IntegrationPlanOperation = body.enabled
      ? (body.overwriteConflict === true ? "overwrite" : "apply")
      : "disable";
    if ((body.operation !== undefined || body.planFingerprint !== undefined) && id === undefined) {
      throw new ProfileQueryError("a confirmed plan applies to one profile");
    }
    const binding = asideBinding(body, expected);
    const capture: { plan: IntegrationMutationPlan | null } = { plan: null };
    let mutationInput = options.input();
    let revalidate: ((prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null>) | undefined;
    let revalidateBeforeWrite: ((prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null>) | undefined;
    if (binding !== null && id !== undefined) {
      const roster = previewExportSnapshot(ctx.config);
      if (roster === null) {
        return jsonResponse({
          error: "no model roster is cached yet, so this change cannot be planned",
          code: "integration_preview_unavailable",
        }, 409, req, ctx.config);
      }
      // One roster for the guard and the mutation, so they cannot disagree by construction.
      mutationInput = { ...mutationInput, models: roster.models };
      revalidate = asideGuardFor(ctx, roster.identity, id, binding, {}, capture);
      revalidateBeforeWrite = asideLateGuardFor(id, binding, {}, capture);
    }
    const batch = await mutateAsideProfiles(
      mutationInput,
      { enabled: body.enabled, profileId: id, overwriteConflict: body.overwriteConflict === true },
      revalidate ? { revalidate, ...(revalidateBeforeWrite ? { revalidateBeforeWrite } : {}) } : undefined,
    );
    if (capture.plan) return stalePlanResponse(ctx, capture.plan);
    if (id !== undefined) {
      const result = batch.results[0];
      if (!result) throw new Error("Aside profile mutation returned no result");
      return result.ok ? jsonResponse(result, 200, req, ctx.config) : options.failure(result);
    }
    return jsonResponse(batch, batch.ok ? 200 : 207, req, ctx.config);
  } catch (error) { return errorResponse(error, ctx); }
}

/** Profile-qualified history, including source-store provenance for imported legacy entries. */
export async function asideJournalResponse(
  ctx: ManagementContext, requestedClient: string | null, options: AsideProfileRouteOptions,
): Promise<Response | null> {
  if (requestedClient === null && !ctx.url.searchParams.has("profile")) return null;
  if (requestedClient !== null && requestedClient !== "aside") {
    return ctx.url.searchParams.has("profile") ? errorResponse(new ProfileQueryError("profile applies only to Aside"), ctx) : null;
  }
  try {
    const id = profileId(ctx);
    if (id !== undefined && requestedClient !== "aside") throw new ProfileQueryError("profile requires client=aside");
    const input = options.input();
    const aside = await listAsideOperations(input, id);
    const rows = [...aside].sort((a, b) => b.entry.at.localeCompare(a.entry.at));
    const newest = new Map<string, string>();
    const ownerKey = (row: typeof rows[number]) => `${row.entry.clientId}:${row.profileId ?? row.entry.configPath}`;
    for (const row of rows) if (!newest.has(ownerKey(row))) newest.set(ownerKey(row), row.entry.opId);
    const operations = rows.map(row => {
      const { entry, store } = row;
      const snapshot = store.readSnapshot(entry).kind;
      const latest = newest.get(ownerKey(row)) === entry.opId;
      return {
        opId: entry.opId, clientId: entry.clientId, kind: entry.kind, at: entry.at,
        configPath: entry.configPath, snapshot,
        ...(row.profileId !== undefined ? { profileId: row.profileId } : {}),
        undoable: snapshot !== "expired" && latest && row.profileId !== undefined && asideOperationMatchesCurrent(input, row),
        deletable: !latest,
      };
    });
    return jsonResponse({ operations }, 200, ctx.req, ctx.config);
  } catch (error) {
    return requestedClient === null && !ctx.url.searchParams.has("profile") ? null : errorResponse(error, ctx);
  }
}

export async function asideRestoreResponse(
  ctx: ManagementContext,
  body: { opId: string; confirmDrift?: boolean; operation?: unknown; planFingerprint?: unknown },
  options: AsideProfileRouteOptions,
): Promise<Response | null> {
  try {
    validateClientSelector(ctx);
    const id = profileId(ctx);
    const input = options.input();
    const rootEntry = input.store?.findOperation(body.opId);
    if (rootEntry && rootEntry.clientId !== "aside") {
      if (id !== undefined || ctx.url.searchParams.has("client")) throw new ProfileQueryError("client/profile selectors do not match the operation");
      return null;
    }
    const operation = await findAsideOperation(input, body.opId, id);
    if (!operation) {
      if (id === undefined) return null;
      return jsonResponse({ error: "integration operation not found", code: "integration_operation_not_found", opId: body.opId }, 404, ctx.req, ctx.config);
    }
    if ((body.operation !== undefined || body.planFingerprint !== undefined) && id === undefined) {
      throw new ProfileQueryError("a confirmed plan applies to one profile");
    }
    const restoreBinding = asideBinding(body, "restore");
    const capture: { plan: IntegrationMutationPlan | null } = { plan: null };
    let restoreInput = input;
    let revalidate: ((prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null>) | undefined;
    let revalidateBeforeWrite: ((prepared: IntegrationWriteInput) => Promise<AsideProfileWriteOutcome | null>) | undefined;
    if (restoreBinding !== null) {
      const roster = previewExportSnapshot(ctx.config);
      if (roster === null) {
        return jsonResponse({
          error: "no model roster is cached yet, so this change cannot be planned",
          code: "integration_preview_unavailable",
        }, 409, ctx.req, ctx.config);
      }
      restoreInput = { ...restoreInput, models: roster.models };
      revalidate = asideGuardFor(ctx, roster.identity, operation.profileId, restoreBinding, {
        opId: body.opId,
        confirmDrift: body.confirmDrift === true,
        resolved: operation,
      }, capture);
      revalidateBeforeWrite = asideLateGuardFor(operation.profileId, restoreBinding, {
        opId: body.opId,
        confirmDrift: body.confirmDrift === true,
        resolved: operation,
      }, capture);
    }
    const result = await restoreAsideProfile(
      restoreInput,
      // The same row the preview and guard used. Letting the mutation resolve its own copy is how
      // a confirmation ends up bound to an operation other than the one that runs.
      { ...body, profileId: operation.profileId, selectedOperation: operation },
      revalidate ? { revalidate, ...(revalidateBeforeWrite ? { revalidateBeforeWrite } : {}) } : undefined,
    );
    if (capture.plan) return stalePlanResponse(ctx, capture.plan);
    return result.ok ? jsonResponse(result, 200, ctx.req, ctx.config) : options.failure(result);
  } catch (error) {
    if (error instanceof ClientPathError && !ctx.url.searchParams.has("profile")
      && options.input().store?.findOperation(body.opId)?.clientId !== "aside") return null;
    return errorResponse(error, ctx);
  }
}

export async function asideJournalDeleteResponse(
  ctx: ManagementContext, opId: string, options: AsideProfileRouteOptions,
): Promise<Response | null> {
  try {
    validateClientSelector(ctx);
    const id = profileId(ctx);
    const input = options.input();
    const rootEntry = input.store?.findOperation(opId);
    if (rootEntry && rootEntry.clientId !== "aside") {
      if (id !== undefined || ctx.url.searchParams.has("client")) throw new ProfileQueryError("client/profile selectors do not match the operation");
      return null;
    }
    const operation = await findAsideOperation(input, opId, id);
    if (!operation) {
      if (id === undefined) return null;
      return jsonResponse({ error: "integration operation not found", code: "integration_operation_not_found", opId }, 404, ctx.req, ctx.config);
    }
    return jsonResponse(await deleteAsideOperation(input, { opId, profileId: operation.profileId, principal: ctx.principal ?? "admin-token" }), 200, ctx.req, ctx.config);
  } catch (error) {
    if (error instanceof ClientPathError && !ctx.url.searchParams.has("profile")
      && options.input().store?.findOperation(opId)?.clientId !== "aside") return null;
    return errorResponse(error, ctx);
  }
}
