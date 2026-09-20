/**
 * Management routes for the client-integration toggle.
 *
 * This module is an HTTP adapter and nothing more: every policy decision —
 * what counts as ownership, when a mutation is refused, what gets journaled —
 * belongs to src/integrations/writer.ts. Duplicating any of it here is how the
 * API and the writer would start disagreeing about what happened to a file.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/040_wp4_management_api.md.
 */
import { readFileSync } from "node:fs";
import { saveConfigPreservingClaudeCode } from "../../config";
import { listAsideProfileStates, type AsideProfilesInput } from "../../integrations/aside-profiles";
import {
  handleAsideProfileRoutes, asideJournalResponse, asideRestoreResponse,
  asideJournalDeleteResponse, type AsideProfileRouteOptions,
} from "./aside-profile-routes";
import type { IntegrationIO } from "../../integrations/config-io";
import { createClineIO } from "../../integrations/cline-io";
import { matchesOperationResult } from "../../integrations/journal";
import {
  INTEGRATION_CLIENT_IDS,
  isIntegrationClientId,
  type IntegrationClientId,
} from "../../integrations/registry";
import { detectRaycast, type RaycastInstall } from "../../integrations/raycast-detect";
import { readIntegrationState } from "../../integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../integrations/store";
import {
  applyIntegrationCoordinated,
  disableIntegrationCoordinated,
  overwriteIntegrationCoordinated,
  restoreIntegrationCoordinated,
  type CoordinatedIntegrationOptions,
  type IntegrationRestoreInput,
  type IntegrationWriteInput,
  type WriteRefused,
} from "../../integrations/writer";
import { IntegrationWriterLockBusyError, type IntegrationWriterLockSeams } from "../../integrations/writer-lock";
import {
  INTEGRATION_MUTATION_TERMINAL_MS,
  IntegrationMutationBusyError,
  runIntegrationMutationFlight,
  setIntegrationMutationFlightTestHook,
} from "../../integrations/mutation-flight";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { exportSnapshotIdentity, loadExportModels, previewExportSnapshot } from "./model-rows";
import {
  previewIntegration,
  type IntegrationMutationPlan,
  type IntegrationPlanOperation,
  type PreviewRequest,
} from "../../integrations/mutation-plan";


const INTEGRATION_ROUTE_PREFIX = "/api/client-integrations/";
const INTEGRATION_COLLECTION_PATH = "/api/client-integrations";
const INTEGRATION_HISTORY_PATHS = ["/api/client-integrations/journal", "/api/client-integrations/restore"];
export { INTEGRATION_MUTATION_TERMINAL_MS };

type IntegrationStateRecord = Awaited<ReturnType<typeof readIntegrationState>>;
type ApplyResult = Awaited<ReturnType<typeof applyIntegrationCoordinated>>;
type DisableResult = Awaited<ReturnType<typeof disableIntegrationCoordinated>>;
type RestoreResult = Awaited<ReturnType<typeof restoreIntegrationCoordinated>>;

export type IntegrationStateEnvelope = {
  clientId: IntegrationClientId;
  /**
   * Raycast only, and only on the single-client read. Custom Providers is a
   * Pro feature, so a file that is `current` can still be one Raycast ignores;
   * this is the fact that lets status and the GUI say so. It is not part of
   * the shared `IntegrationStatus`, which describes the file, not the app.
   */
  raycast?: RaycastInstall;
} & IntegrationStateRecord;

export interface IntegrationStateListEnvelope {
  clients: IntegrationStateEnvelope[];
}

export type IntegrationToggleEnvelope =
  | ({ clientId: IntegrationClientId } & ApplyResult)
  | ({ clientId: IntegrationClientId } & DisableResult);

export type IntegrationRestoreEnvelope = {
  clientId: IntegrationClientId;
} & RestoreResult;

export interface IntegrationJournalEnvelope {
  operations: IntegrationJournalRow[];
}

export interface IntegrationJournalRow {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore" | "overwrite";
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
  /**
   * May the operator retire this row?
   *
   * Computed HERE, not in the GUI, because the DELETE route enforces the same
   * rule and two copies of it would drift. False for a client newest row: it
   * is the undo entry point (`undoable` above keys off exactly this), and it
   * is what a user reaches for right after the mistake.
   */
  deletable: boolean;
  profileId?: number;
}

export interface IntegrationToggleBody {
  enabled: boolean;
  /**
   * Opt in to replacing a conflicted block with the one opencodex would write.
   *
   * Absent and `false` behave identically and are the only states a caller
   * reaches by accident, which is the point: the conflict refusal protects work
   * we did not author, so it can only be waived by asking for it by name.
   */
  overwriteConflict?: boolean;
}

export interface IntegrationRestoreBody {
  opId: string;
  confirmDrift?: boolean;
}

let integrationMutationTestHooks: {
  io?: IntegrationIO;
  lockSeams?: IntegrationWriterLockSeams;
  /**
   * Bind every read and write in the request to one store. Without this a
   * route test could isolate the writer but not the journal listing or the
   * restore preflight (A-gate round 12).
   */
  store?: IntegrationStateStore;
  run?: (operation: () => Promise<unknown>) => Promise<unknown>;
} | null = null;

/**
 * Home and environment overrides for tests.
 *
 * Bun's `os.homedir()` snapshots the real home at startup and ignores a later
 * `process.env.HOME` assignment, so a test that only rewrites `HOME` still
 * resolves the DEVELOPER'S client configs — which is exactly how a route test
 * wrote a real `~/.hermes/config.yaml` during this work package. The writer
 * and the state reader both already take `env`/`home` explicitly; the route
 * simply had no way to pass them. It does now, and production leaves it unset.
 */
let integrationPathTestHooks: { env?: NodeJS.ProcessEnv; home?: string } | null = null;

export function setIntegrationPathTestHooks(hooks: { env?: NodeJS.ProcessEnv; home?: string } | null): void {
  integrationPathTestHooks = hooks;
}

/**
 * Raycast detection override for tests. The real detector spawns `defaults` and
 * reads the developer's own subscription state, which is exactly the kind of
 * host fact a route test must not depend on.
 */
let raycastDetectTestHook: (() => RaycastInstall) | null = null;

export function setRaycastDetectTestHook(hook: (() => RaycastInstall) | null): void {
  raycastDetectTestHook = hook;
}

/** The `env`/`home` overrides, spread into every registry-resolving call. */
function pathOverrides(): { env?: NodeJS.ProcessEnv; home?: string } {
  return {
    ...(integrationPathTestHooks?.env ? { env: integrationPathTestHooks.env } : {}),
    ...(integrationPathTestHooks?.home ? { home: integrationPathTestHooks.home } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeClientPath(pathname: string): string | null {
  if (!pathname.startsWith(INTEGRATION_ROUTE_PREFIX)) return null;
  const encoded = pathname.slice(INTEGRATION_ROUTE_PREFIX.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function setIntegrationMutationFlightTestHooks(
  hooks: {
    io?: IntegrationIO;
    lockSeams?: IntegrationWriterLockSeams;
    /** Binds the WHOLE request — reads, writes and journal — to one store. */
    store?: IntegrationStateStore;
    run?: (operation: () => Promise<unknown>) => Promise<unknown>;
  } | null,
): void {
  integrationMutationTestHooks = hooks;
  setIntegrationMutationFlightTestHook(hooks?.run ?? null);
  // Path overrides are part of the same isolation contract: clearing flights
  // while leaving a temp home bound would let the next suite write real files.
  if (hooks === null) {
    integrationPathTestHooks = null;
    raycastDetectTestHook = null;
  }
}

/**
 * ONE store per request, used by every read and every write in that request.
 * The route previously called module-level `listOperations`/`readSnapshot`
 * while handing the writer a separate default store, so a test could not bind
 * the whole operation to a temp root (A-gate round 12).
 */
function integrationStore(): IntegrationStateStore {
  return integrationMutationTestHooks?.store ?? createIntegrationStateStore();
}

function asideOptions(ctx: ManagementContext): AsideProfileRouteOptions {
  let input: AsideProfilesInput | undefined;
  return {
    input: () => input ??= {
      config: ctx.config,
      port: Number(ctx.url.port) || ctx.config.port,
      models: () => loadExportModels(ctx.config),
      store: integrationStore(),
      ...pathOverrides(),
      io: integrationMutationTestHooks?.io,
      lockSeams: integrationMutationTestHooks?.lockSeams,
      persistConfig: ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode,
    },
    failure: result => writerFailureResponse("aside", result, ctx),
  };
}

async function buildIntegrationWriteInput(
  clientId: IntegrationClientId,
  ctx: ManagementContext,
  store: IntegrationStateStore,
): Promise<IntegrationWriteInput> {
  return {
    clientId,
    models: await loadExportModels(ctx.config),
    config: ctx.config,
    port: Number(ctx.url.port) || ctx.config.port,
    store,
    io: integrationMutationTestHooks?.io,
    ...pathOverrides(),
  };
}

/**
 * The same input a mutation would build, from the read-only roster.
 *
 * It differs from the mutation's in exactly one way, and the difference is deliberate: the roster
 * comes from `previewExportModels`, which gathers without running the initial-selection finalizer
 * that persists configuration. Everything else is shared, so a preview and the commit that follows
 * it cannot disagree for any reason except the state genuinely moving.
 */
async function buildIntegrationPreviewInput(
  clientId: IntegrationClientId,
  ctx: ManagementContext,
  store: IntegrationStateStore,
): Promise<{ input: IntegrationWriteInput; identity: string } | null> {
  const snapshot = previewExportSnapshot(ctx.config);
  // No cached roster means no honest snapshot to plan against. Gathering one here would make a
  // read refresh credentials and write the provider cache, which is the thing preview must not do.
  if (snapshot === null) return null;
  return {
    identity: snapshot.identity,
    input: {
      clientId,
      models: snapshot.models,
      config: ctx.config,
      port: Number(ctx.url.port) || ctx.config.port,
      store,
      io: integrationMutationTestHooks?.io,
      ...pathOverrides(),
    },
  };
}

/**
 * The file's current bytes, or `null` when it is missing.
 *
 * `null` is NOT the same as `""`: an absent file and an empty one are
 * different states, and collapsing them is what made this route disagree with
 * the writer about whether an absence-result operation had drifted.
 * `undefined` means we could not read it at all, which is neither.
 */
function currentConfigText(configPath: string): string | null | undefined {
  try {
    return readFileSync(configPath, "utf8");
  } catch (error) {
    if (isPlainRecord(error) && error.code === "ENOENT") return null;
    return undefined;
  }
}

function invalidClientResponse(ctx: ManagementContext): Response {
  return jsonResponse({
    error: "invalid integration client",
    code: "invalid_integration_client",
    validClients: INTEGRATION_CLIENT_IDS,
  }, 400, ctx.req, ctx.config);
}

/**
 * No cached model roster, so there is nothing honest to plan against.
 *
 * Answered as a bounded refusal rather than by gathering one: discovery refreshes credentials and
 * writes the provider cache, and a preview that did either would be a write wearing a read's name.
 * The caller opens the models view or performs the mutation directly.
 */
function previewUnavailableResponse(ctx: ManagementContext): Response {
  return jsonResponse({
    error: "no model roster is cached yet, so this change cannot be planned",
    code: "integration_preview_unavailable",
  }, 409, ctx.req, ctx.config);
}

/**
 * A confirmed plan, or a reason the request cannot carry one.
 *
 * Both fields or neither. A half-bound request is rejected rather than quietly treated as
 * unbound, because dropping one half would answer 200 to a caller who believed their
 * confirmation was being checked.
 */
function planBindingOf(
  body: Record<string, unknown>,
): { operation: IntegrationPlanOperation; fingerprint: string } | "none" | "half" | "unknown-operation" {
  const { operation, planFingerprint } = body;
  if (operation === undefined && planFingerprint === undefined) return "none";
  if (operation === undefined || typeof planFingerprint !== "string" || planFingerprint.length === 0) return "half";
  if (operation !== "apply" && operation !== "overwrite" && operation !== "disable" && operation !== "restore") {
    return "unknown-operation";
  }
  return { operation, fingerprint: planFingerprint };
}

function halfBoundResponse(ctx: ManagementContext): Response {
  return jsonResponse({
    error: "operation and planFingerprint must be sent together",
    code: "invalid_preview_binding",
  }, 400, ctx.req, ctx.config);
}

/**
 * Re-plan and compare before the mutation runs.
 *
 * The fingerprint is an optimistic token, never authorization: management authentication and
 * every ownership rule still apply. What it adds is that a confirmation stops meaning anything
 * the moment the state it described moved, and the refusal carries a fresh plan so the operator
 * decides again against what is true now.
 */
function stalePlanGuard(
  clientId: IntegrationClientId,
  ctx: ManagementContext,
  store: IntegrationStateStore,
  request: PreviewRequest,
  fingerprint: string,
  capturedIdentity: string | null,
): {
  revalidate: NonNullable<CoordinatedIntegrationOptions["revalidate"]>;
  response: () => Response | null;
} {
  let stale: IntegrationMutationPlan | "unavailable" | null = null;
  return {
    revalidate: async frozen => {
      /*
       * Plan the coordinator's OWN frozen input, never a freshly built one. Rebuilding here let
       * the check validate against one roster while the mutation wrote from another, because an
       * ordinary load can replace the snapshot at any time and nothing serialises that against
       * this lock. The captured identity is verified separately, so a replacement is detected
       * without ever swapping the roster this mutation is about to use.
       */
      if (exportSnapshotIdentity(ctx.config) !== capturedIdentity) {
        const refreshed = await buildIntegrationPreviewInput(clientId, ctx, store);
        stale = refreshed === null ? "unavailable" : previewIntegration(refreshed.input, request);
        return { ok: false, reason: "conflict", state: "conflict", clientId, message: "the model roster changed while confirming" };
      }
      const plan = previewIntegration(frozen, request);
      if (plan.canApply && plan.fingerprint === fingerprint) return null;
      stale = plan;
      return { ok: false, reason: "conflict", state: plan.state, clientId, message: "that confirmation no longer describes this file" };
    },
    response: () => {
      if (stale === null) return null;
      if (stale === "unavailable") return previewUnavailableResponse(ctx);
      return jsonResponse({
        error: "integration preview is stale",
        code: "integration_preview_stale",
        plan: stale,
      }, 409, ctx.req, ctx.config);
    },
  };
}

function internalErrorResponse(error: unknown, ctx: ManagementContext): Response {
  return jsonResponse({
    error: error instanceof Error ? error.message : String(error),
    code: "integration_internal_error",
  }, 500, ctx.req, ctx.config);
}

async function readJsonBody(ctx: ManagementContext): Promise<unknown | Response> {
  try {
    return await readManagementJsonBody(ctx.req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({
      error: "invalid JSON body",
      code: "invalid_json_body",
    }, 400, ctx.req, ctx.config);
  }
}

function writerFailureResponse(
  clientId: IntegrationClientId,
  /*
   * The writer's own refusal type, not a structural echo of it.
   *
   * A local shape with an optional `message` accepted a refusal that had lost
   * its message on the way here, which is exactly how the drift branch shipped
   * without one. `WriteRefused` requires it, so the compiler now objects.
   */
  result: WriteRefused,
  ctx: ManagementContext,
): Response {
  /*
   * Routed by `reason`, never by `state` (006 §5). A `write_failed` that
   * happens to occur while the file is in a `conflict` state is still a write
   * failure, and mapping on state first silently dropped its message,
   * snapshotPath, and residual — the recovery information the flag exists to
   * carry (A-gate round 5, blocker 3).
   */
  const recovery = {
    message: result.message,
    ...(result.snapshotPath ? { snapshotPath: result.snapshotPath } : {}),
    ...(result.residual ? { residual: true } : {}),
  };

  if (result.reason === "unsafe") {
    return jsonResponse({
      error: "integration config is unsafe",
      code: "integration_unsafe",
      clientId, state: result.state, reason: result.reason, ...recovery,
    }, 409, ctx.req, ctx.config);
  }
  if (result.reason === "conflict") {
    return jsonResponse({
      error: "integration config conflicts with ownership record",
      code: "integration_conflict",
      clientId, state: result.state, reason: result.reason, ...recovery,
    }, 409, ctx.req, ctx.config);
  }
  if (result.reason === "drift_requires_confirm") {
    return jsonResponse({
      error: "restore requires drift confirmation",
      code: "integration_drift_confirmation_required",
      clientId, state: result.state, reason: result.reason, ...recovery,
    }, 409, ctx.req, ctx.config);
  }
  if (result.reason === "snapshot_expired") {
    return jsonResponse({
      error: "integration snapshot expired",
      code: "integration_snapshot_expired",
      clientId, state: result.state, reason: result.reason, ...recovery,
    }, 410, ctx.req, ctx.config);
  }
  // not_installed, non_loopback, write_failed — always carry recovery fields.
  return jsonResponse({
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId, state: result.state, reason: result.reason, ...recovery,
  }, 500, ctx.req, ctx.config);
}

/**
 * Who asked for this deletion, as an audit value that is safe to persist.
 *
 * The tombstone lives in an append-only log the user can read, so this must be
 * a principal NAME and nothing else -- never the admin token, a session id, or
 * a filesystem path. `principal` is undefined only in direct-dispatch tests,
 * which the auth gate documents as the untrusted admin-token case.
 */
function journalDeletePrincipal(ctx: ManagementContext): string {
  return ctx.principal ?? "admin-token";
}

/**
 * Retire one journal row at the operator request.
 *
 * The opId travels in the QUERY STRING, matching DELETE
 * /api/codex-auth/accounts?id= -- the repository other DELETE-by-identifier. A
 * body on DELETE is legal but unevenly handled by intermediaries, and there is
 * nothing here a query cannot carry.
 */
async function handleJournalDelete(ctx: ManagementContext): Promise<Response> {
  const { req, url } = ctx;
  const opId = url.searchParams.get("opId")?.trim();
  if (!opId) {
    return jsonResponse({
      error: "opId must be a non-empty string",
      code: "invalid_op_id",
    }, 400, req, ctx.config);
  }
  const aside = await asideJournalDeleteResponse(ctx, opId, asideOptions(ctx));
  if (aside) return aside;
  try {
    const store = integrationStore();
    const operation = store.findOperation(opId);
    if (!operation) {
      // Already retired, or never existed. Both are 404: the tombstone hides
      // the row from findOperation, so a double-click is idempotent here
      // rather than a second deletion of something.
      return jsonResponse({
        error: "integration operation not found",
        code: "integration_operation_not_found",
        opId,
      }, 404, req, ctx.config);
    }
    /*
     * The newest row per client is refused, and refused by the SERVER even
     * though the GUI already hides its button. The button is a courtesy; this
     * is the rule. An admin-token caller has no GUI at all.
     *
     * Re-read immediately before the write: a restore that landed while the
     * dialog was open appends a new row and changes which opId is newest.
     */
    const newest = store.listOperations(operation.clientId, 1)[0];
    if (newest?.opId === opId) {
      return jsonResponse({
        error: "the newest operation for a client cannot be deleted",
        code: "integration_journal_newest_protected",
        clientId: operation.clientId,
        opId,
      }, 409, req, ctx.config);
    }

    store.retireOperation({
      tombstone: opId,
      at: new Date().toISOString(),
      by: journalDeletePrincipal(ctx),
    });

    /*
     * Snapshot bytes go too, and go AFTER the tombstone -- the same post-commit
     * ordering appendOperation uses (journal.ts rule 1). If this fails, the row
     * is still retired and retentionDegraded discloses the leftover file; the
     * reverse order would delete a user backup for a deletion that then failed
     * to record.
     */
    const pruned = store.pruneSnapshots(operation.clientId);
    if (pruned.ok) store.clearPruneFailure(operation.clientId);
    else store.markPruneFailure(operation.clientId, pruned.error);

    return jsonResponse({
      ok: true,
      opId,
      clientId: operation.clientId,
      snapshotRemoved: pruned.ok,
    }, 200, req, ctx.config);
  } catch (error) {
    return internalErrorResponse(error, ctx);
  }
}

export async function handleIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  const profileOptions = asideOptions(ctx);
  const aside = await handleAsideProfileRoutes(ctx, profileOptions);
  if (aside) return aside;
  if (url.searchParams.has("profile")
    && (url.pathname === INTEGRATION_COLLECTION_PATH || url.pathname.startsWith(INTEGRATION_ROUTE_PREFIX))
    && !INTEGRATION_HISTORY_PATHS.includes(url.pathname)) {
    return jsonResponse({ error: "profile applies only to Aside", code: "invalid_aside_profile" }, 400, req, ctx.config);
  }

  if (url.pathname === "/api/client-integrations" && req.method === "GET") {
    try {
      const models = await loadExportModels(ctx.config);
      const port = Number(url.port) || ctx.config.port;
      // One store for the whole collection read: without it this route retried
      // maintenance and counted snapshots in the default store even when the
      // caller had bound everything else to a temp root (A-gate round 13).
      const store = integrationStore();
      /*
       * The envelope carries `clientId`, but it is not restated here: WP2 and
       * WP3 both echo `input.clientId` back in their result, and `input`
       * IS this route's client. Writing it twice made the compiler pick the
       * later one silently — a duplicate that could only ever hide a
       * disagreement, never surface it.
       */
      const clients = await Promise.all(INTEGRATION_CLIENT_IDS.map(async clientId => {
        if (clientId === "aside") {
          try { return await listAsideProfileStates({ ...profileOptions.input(), models }); }
          catch { /* Existing status projection retains a safe unresolved-path diagnostic. */ }
        }
        return readIntegrationState({ clientId, models, config: ctx.config, port, store, ...pathOverrides() });
      }));
      return jsonResponse({ clients } satisfies IntegrationStateListEnvelope, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/client-integrations/journal" && req.method === "DELETE") {
    return handleJournalDelete(ctx);
  }

  if (url.pathname === "/api/client-integrations/journal") {
    if (req.method !== "GET") return null;
    const requestedClient = url.searchParams.get("client");
    if (requestedClient !== null && !isIntegrationClientId(requestedClient)) {
      return invalidClientResponse(ctx);
    }
    const asideJournal = await asideJournalResponse(ctx, requestedClient, profileOptions);
    if (asideJournal) return asideJournal;
    try {
      const store = integrationStore();
      const storedOperations = store.listOperations(requestedClient ?? undefined);
      const newestByClient = new Map<IntegrationClientId, string>();
      for (const operation of storedOperations) {
        if (!newestByClient.has(operation.clientId)) {
          newestByClient.set(operation.clientId, operation.opId);
        }
      }
      let operations: IntegrationJournalRow[] = storedOperations.map(operation => {
        /*
         * Resolved against the DISK, not read off the row.
         *
         * Retention deletes snapshot files and deliberately leaves the row's
         * persisted tag saying `stored`, so copying that tag advertised undo
         * for bytes that no longer exist — the GUI would offer the button and
         * the restore route would answer 410. `readSnapshot` is the same
         * resolver that preflight uses, which is what keeps the two agreeing.
         */
        const snapshot = store.readSnapshot(operation).kind;
        return {
          opId: operation.opId,
          clientId: operation.clientId,
          kind: operation.kind,
          at: operation.at,
          configPath: operation.configPath,
          snapshot,
          /*
           * The SAME resolution decides `undoable`. Reporting the tag honestly
           * and then offering undo anyway is the identical defect one field
           * over: restore would answer 410 for a row the GUI drew a button on.
           * `none` stays undoable — restoring an op that created a file means
           * deleting it, and that needs no snapshot bytes.
           */
          /*
           * Eligibility goes through the SAME matcher restore uses. This route
           * used to represent a missing file as `""` and call that a match,
           * while restore hashed `""` into a real digest — so the row was
           * offered as Undo and then refused as drift.
           */
          undoable: (() => {
            if (snapshot === "expired") return false;
            if (newestByClient.get(operation.clientId) !== operation.opId) return false;
            const current = operation.clientId === "cline" ? (() => {
              const io = createClineIO(integrationMutationTestHooks?.io ?? store.io(), operation.configPath, store);
              const read = io.readText(operation.configPath);
              return read.kind === "text" ? read.text : read.kind === "missing" ? null : undefined;
            })() : currentConfigText(operation.configPath);
            return current === undefined ? false : matchesOperationResult(operation, current);
          })(),
          /*
           * Deliberately NOT an `undoable` derivative. The two axes are
           * independent: an expired row is undoable-false and deletable-true,
           * which is the pairing this route exists to produce -- a row whose
           * bytes are gone previously carried no action at all.
           */
          deletable: newestByClient.get(operation.clientId) !== operation.opId,
        };
      });
      if (requestedClient === null) {
        const profiles = await asideJournalResponse(ctx, "aside", profileOptions);
        if (profiles?.ok) {
          const body = await profiles.json() as IntegrationJournalEnvelope;
          operations = [...operations.filter(row => row.clientId !== "aside"), ...body.operations]
            .sort((a, b) => b.at.localeCompare(a.at));
        }
      }
      return jsonResponse({ operations } satisfies IntegrationJournalEnvelope, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/client-integrations/preview") {
    if (req.method !== "POST") return null;
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed)) {
      return jsonResponse({ error: "preview body must be an object", code: "invalid_preview_body" }, 400, req, ctx.config);
    }
    const previewClient = parsed.clientId;
    if (typeof previewClient !== "string"
      || !(INTEGRATION_CLIENT_IDS as readonly string[]).includes(previewClient)) {
      return invalidClientResponse(ctx);
    }
    /*
     * Aside is a set of profiles, not one file, and every mutation it has requires a profile. A
     * plan built here would describe the legacy single-account location and no bound mutation
     * would accept it, so an operator could confirm something nothing can carry out. The canonical
     * per-profile preview answers this question properly, and the mutation routes already refuse
     * the unscoped spelling the same way.
     */
    if (previewClient === "aside") {
      return jsonResponse({ error: "Use the canonical Aside profile path", code: "invalid_aside_profile_path" }, 400, req, ctx.config);
    }
    const operation = parsed.operation;
    if (operation !== "apply" && operation !== "overwrite" && operation !== "disable") {
      return jsonResponse({
        error: "operation must be apply, overwrite or disable",
        code: "invalid_preview_operation",
      }, 400, req, ctx.config);
    }
    try {
      const captured = await buildIntegrationPreviewInput(previewClient as IntegrationClientId, ctx, integrationStore());
      if (!captured) return previewUnavailableResponse(ctx);
      return jsonResponse(previewIntegration(captured.input, { operation }), 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/client-integrations/restore/preview") {
    if (req.method !== "POST") return null;
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed) || typeof parsed.opId !== "string" || parsed.opId.trim().length === 0) {
      return jsonResponse({ error: "opId must be a non-empty string", code: "invalid_op_id" }, 400, req, ctx.config);
    }
    if (parsed.confirmDrift !== undefined && typeof parsed.confirmDrift !== "boolean") {
      return jsonResponse({ error: "confirmDrift must be a boolean", code: "invalid_confirm_drift" }, 400, req, ctx.config);
    }
    const opId = parsed.opId.trim();
    try {
      const store = integrationStore();
      const operation = store.findOperation(opId);
      /*
       * Answered as "not found" rather than by reading the row back to the caller. A preview is
       * reached before any confirmation, so it is the cheapest place to probe journal contents,
       * and it declines to be one.
       */
      if (!operation) {
        return jsonResponse({
          error: "integration operation not found",
          code: "integration_operation_not_found",
          opId,
        }, 404, req, ctx.config);
      }
      // Same rule, decided after the row is found so an unscoped undo of an Aside operation is
      // refused for what it is rather than answered as a missing operation.
      if (operation.clientId === "aside") {
        return jsonResponse({ error: "Use the canonical Aside profile path", code: "invalid_aside_profile_path" }, 400, req, ctx.config);
      }
      const captured = await buildIntegrationPreviewInput(operation.clientId, ctx, store);
      if (!captured) return previewUnavailableResponse(ctx);
      const plan = previewIntegration(captured.input, {
        operation: "restore",
        opId,
        confirmDrift: parsed.confirmDrift ?? false,
      });
      return jsonResponse(plan, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/client-integrations/restore") {
    if (req.method !== "POST") return null;
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed) || typeof parsed.opId !== "string" || parsed.opId.trim().length === 0) {
      return jsonResponse({
        error: "opId must be a non-empty string",
        code: "invalid_op_id",
      }, 400, req, ctx.config);
    }
    if (parsed.confirmDrift !== undefined && typeof parsed.confirmDrift !== "boolean") {
      return jsonResponse({
        error: "confirmDrift must be a boolean",
        code: "invalid_confirm_drift",
      }, 400, req, ctx.config);
    }

    const opId = parsed.opId.trim();
    const confirmDrift = parsed.confirmDrift ?? false;
    const restoreBinding = planBindingOf(parsed);
    if (restoreBinding === "half") return halfBoundResponse(ctx);
    if (restoreBinding === "unknown-operation" || (restoreBinding !== "none" && restoreBinding.operation !== "restore")) {
      return jsonResponse({
        error: "operation does not match the requested change",
        code: "invalid_preview_operation",
      }, 400, req, ctx.config);
    }
    // The binding travels with the request. Dropping it here routed a bound Aside restore into
    // the unbound path, which executed the mutation while its confirmation went unexamined.
    const asideRestore = await asideRestoreResponse(ctx, {
      opId,
      confirmDrift,
      ...(parsed.operation === undefined ? {} : { operation: parsed.operation }),
      ...(parsed.planFingerprint === undefined ? {} : { planFingerprint: parsed.planFingerprint }),
    }, profileOptions);
    if (asideRestore) return asideRestore;
    let restoreClientId: IntegrationClientId | undefined;
    try {
      const store = integrationStore();
      const operation = store.findOperation(opId);
      if (!operation) {
        return jsonResponse({
          error: "integration operation not found",
          code: "integration_operation_not_found",
          opId,
        }, 404, req, ctx.config);
      }
      restoreClientId = operation.clientId;
      const snapshot = store.readSnapshot(operation);
      if (snapshot.kind === "expired") {
        return jsonResponse({
          error: "integration snapshot expired",
          code: "integration_snapshot_expired",
          opId,
        }, 410, req, ctx.config);
      }

      const boundRestore = restoreBinding === "none"
        ? null
        : await buildIntegrationPreviewInput(operation.clientId, ctx, store);
      if (restoreBinding !== "none" && boundRestore === null) return previewUnavailableResponse(ctx);
      const writeInput = boundRestore
        ? boundRestore.input
        : await buildIntegrationWriteInput(operation.clientId, ctx, store);
      const restoreGuard = restoreBinding === "none" ? null : stalePlanGuard(
        operation.clientId,
        ctx,
        store,
      { operation: "restore", opId, confirmDrift },
      restoreBinding.fingerprint,
        boundRestore === null ? null : boundRestore.identity,
    );
      const restoreInput: IntegrationRestoreInput = {
        ...writeInput,
        opId,
        confirmDrift,
      };
      const result = await runIntegrationMutationFlight(
        operation.clientId,
        `restore:${opId}:${confirmDrift}`,
        writeInput.io?.now ?? Date.now,
        () => restoreIntegrationCoordinated(restoreInput, {
          lockSeams: integrationMutationTestHooks?.lockSeams,
          ...(restoreGuard ? { revalidate: restoreGuard.revalidate } : {}),
        }),
      );
      const restoreStale = restoreGuard?.response();
      if (restoreStale) return restoreStale;
      if (!result.ok) {
        /*
         * Drift is NOT special-cased here.
         *
         * It used to be, and the hand-written branch dropped the writer's
         * `message` — which is the only thing that tells the user WHICH file
         * drifted and where its backup went. Every refusal leaves through the
         * one serializer, so a refusal cannot lose its recovery fields by
         * being routed through a shorter path.
         */
        return writerFailureResponse(operation.clientId, result, ctx);
      }
      return jsonResponse(result satisfies IntegrationRestoreEnvelope, 200, req, ctx.config);
    } catch (error) {
      if (error instanceof IntegrationMutationBusyError || error instanceof IntegrationWriterLockBusyError) {
        return jsonResponse({
          error: "integration mutation busy",
          code: "integration_mutation_busy",
          clientId: restoreClientId ?? (error instanceof IntegrationMutationBusyError ? error.clientId : undefined),
        }, 409, req, ctx.config);
      }
      return internalErrorResponse(error, ctx);
    }
  }

  if (req.method !== "GET" && req.method !== "PUT") return null;
  const requestedClient = decodeClientPath(url.pathname);
  if (requestedClient === null) return null;
  if (!isIntegrationClientId(requestedClient)) return invalidClientResponse(ctx);
  // Canonical Aside paths are owned above. Never decode an alternate spelling
  // into the legacy single-account writer or bypass profile policy/guards.
  if (requestedClient === "aside") {
    return jsonResponse({ error: "Use the canonical Aside profile path", code: "invalid_aside_profile_path" }, 400, req, ctx.config);
  }

  if (req.method === "GET") {
    try {
      const input = await buildIntegrationWriteInput(requestedClient, ctx, integrationStore());
      const state = readIntegrationState(input);
      // Detection runs only for the client that needs it: `defaults` is a
      // process spawn, and no other client's read should pay for it.
      const envelope: IntegrationStateEnvelope = requestedClient === "raycast"
        ? { ...state, raycast: (raycastDetectTestHook ?? detectRaycast)() }
        : state;
      return jsonResponse(envelope, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  const parsed = await readJsonBody(ctx);
  if (parsed instanceof Response) return parsed;
  if (!isPlainRecord(parsed) || typeof parsed.enabled !== "boolean") {
    return jsonResponse({
      error: "enabled must be a boolean",
      code: "invalid_enabled",
    }, 400, req, ctx.config);
  }
  if (parsed.overwriteConflict !== undefined && typeof parsed.overwriteConflict !== "boolean") {
    return jsonResponse({
      error: "overwriteConflict must be a boolean",
      code: "invalid_overwrite_conflict",
    }, 400, req, ctx.config);
  }
  /*
   * Rejected rather than ignored. Disabling a block we do not own is precisely
   * the deletion this subsystem exists to prevent, so a caller sending this
   * combination has misunderstood the field, and silently dropping it would
   * answer 200 for a request whose intent we refused.
   */
  if (parsed.overwriteConflict === true && parsed.enabled === false) {
    return jsonResponse({
      error: "overwriteConflict applies only to enabling an integration",
      code: "invalid_overwrite_conflict",
    }, 400, req, ctx.config);
  }

  const requestedOperation: IntegrationPlanOperation = parsed.enabled
    ? (parsed.overwriteConflict === true ? "overwrite" : "apply")
    : "disable";
  const binding = planBindingOf(parsed);
  if (binding === "half") return halfBoundResponse(ctx);
  if (binding === "unknown-operation" || (binding !== "none" && binding.operation !== requestedOperation)) {
    // A confirmation that names a different operation than the request performs is not a
    // confirmation of this request.
    return jsonResponse({
      error: "operation does not match the requested change",
      code: "invalid_preview_operation",
    }, 400, req, ctx.config);
  }

  try {
    /*
     * A bound request is built from the same passive roster the guard re-plans against, and an
     * unbound one keeps its existing refreshing path. Building the refreshing input first would
     * have had the mutation and its own confirmation check disagree about the roster by
     * construction, which is the disagreement this binding exists to detect.
     */
    const boundToggle = binding === "none"
      ? null
      : await buildIntegrationPreviewInput(requestedClient, ctx, integrationStore());
    if (binding !== "none" && boundToggle === null) return previewUnavailableResponse(ctx);
    const input = boundToggle
      ? boundToggle.input
      : await buildIntegrationWriteInput(requestedClient, ctx, integrationStore());
    const guard = binding === "none" ? null : stalePlanGuard(
      requestedClient,
      ctx,
      integrationStore(),
      { operation: binding.operation },
      binding.fingerprint,
      boundToggle === null ? null : boundToggle.identity,
    );
    const result = await runIntegrationMutationFlight(
      requestedClient,
      parsed.enabled ? (parsed.overwriteConflict === true ? "overwrite" : "apply") : "disable",
      input.io?.now ?? Date.now,
      () => {
        const options = {
          lockSeams: integrationMutationTestHooks?.lockSeams,
          ...(guard ? { revalidate: guard.revalidate } : {}),
        };
        if (!parsed.enabled) return disableIntegrationCoordinated(input, options);
        return parsed.overwriteConflict === true
          ? overwriteIntegrationCoordinated(input, options)
          : applyIntegrationCoordinated(input, options);
      },
    );
    const stale = guard?.response();
    if (stale) return stale;
    if (!result.ok) return writerFailureResponse(requestedClient, result, ctx);
    return jsonResponse(result satisfies IntegrationToggleEnvelope, 200, req, ctx.config);
  } catch (error) {
    if (error instanceof IntegrationMutationBusyError || error instanceof IntegrationWriterLockBusyError) {
      return jsonResponse({
        error: "integration mutation busy",
        code: "integration_mutation_busy",
        clientId: requestedClient,
      }, 409, req, ctx.config);
    }
    return internalErrorResponse(error, ctx);
  }
}
