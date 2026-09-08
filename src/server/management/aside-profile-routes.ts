import { redactSecretString } from "../../lib/redact";
import { ClientPathError } from "../../clients/config-export";
import { IntegrationMutationBusyError } from "../../integrations/mutation-flight";
import { IntegrationWriterLockBusyError } from "../../integrations/writer-lock";
import {
  getAsideProfileState, listAsideProfileStates, mutateAsideProfiles, refreshAsideProfiles,
  type AsideProfilesInput,
} from "../../integrations/aside-profiles";
import {
  listAsideOperations, findAsideOperation, restoreAsideProfile, deleteAsideOperation,
  asideOperationMatchesCurrent,
} from "../../integrations/aside-profile-journal";
import type { WriteRefused } from "../../integrations/writer";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, readOptionalManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { jsonResponse } from "../auth-cors";

export interface AsideProfileRouteOptions {
  input: () => AsideProfilesInput;
  failure: (result: WriteRefused) => Response;
}

class ProfileQueryError extends Error { readonly status = 400; readonly code = "invalid_aside_profile"; }

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
  if (parts.length > 2 || !parts[0] || (parts[1] !== undefined && !["journal", "restore"].includes(parts[1]))) {
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
    if (normalized.action === "restore") {
      if (req.method !== "POST") return null;
      const body = await readProfileBody(req);
      if (!isObject(body) || typeof body.opId !== "string" || !body.opId.trim()
        || (body.confirmDrift !== undefined && typeof body.confirmDrift !== "boolean")) throw new ProfileQueryError("Invalid Aside restore request");
      return asideRestoreResponse(ctx, { opId: body.opId.trim(), confirmDrift: body.confirmDrift === true }, options);
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
    const batch = await mutateAsideProfiles(options.input(), { enabled: body.enabled, profileId: id, overwriteConflict: body.overwriteConflict === true });
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
  ctx: ManagementContext, body: { opId: string; confirmDrift?: boolean }, options: AsideProfileRouteOptions,
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
    const result = await restoreAsideProfile(input, { ...body, profileId: operation.profileId });
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
