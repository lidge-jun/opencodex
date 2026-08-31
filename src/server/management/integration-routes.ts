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
import type { IntegrationIO } from "../../integrations/config-io";
import { matchesOperationResult } from "../../integrations/journal";
import {
  INTEGRATION_CLIENT_IDS,
  isIntegrationClientId,
  type IntegrationClientId,
} from "../../integrations/registry";
import { readIntegrationState } from "../../integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../integrations/store";
import {
  applyIntegrationCoordinated,
  disableIntegrationCoordinated,
  overwriteIntegrationCoordinated,
  restoreIntegrationCoordinated,
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
import { loadExportModels } from "./model-rows";


const INTEGRATION_ROUTE_PREFIX = "/api/client-integrations/";
export { INTEGRATION_MUTATION_TERMINAL_MS };

type IntegrationStateRecord = Awaited<ReturnType<typeof readIntegrationState>>;
type ApplyResult = Awaited<ReturnType<typeof applyIntegrationCoordinated>>;
type DisableResult = Awaited<ReturnType<typeof disableIntegrationCoordinated>>;
type RestoreResult = Awaited<ReturnType<typeof restoreIntegrationCoordinated>>;

export type IntegrationStateEnvelope = {
  clientId: IntegrationClientId;
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
  if (hooks === null) integrationPathTestHooks = null;
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

export async function handleIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

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
      const clients = INTEGRATION_CLIENT_IDS.map(clientId =>
        readIntegrationState({ clientId, models, config: ctx.config, port, store, ...pathOverrides() }));
      return jsonResponse({ clients } satisfies IntegrationStateListEnvelope, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/client-integrations/journal") {
    if (req.method !== "GET") return null;
    const requestedClient = url.searchParams.get("client");
    if (requestedClient !== null && !isIntegrationClientId(requestedClient)) {
      return invalidClientResponse(ctx);
    }
    try {
      const store = integrationStore();
      const storedOperations = store.listOperations(requestedClient ?? undefined);
      const newestByClient = new Map<IntegrationClientId, string>();
      for (const operation of storedOperations) {
        if (!newestByClient.has(operation.clientId)) {
          newestByClient.set(operation.clientId, operation.opId);
        }
      }
      const operations: IntegrationJournalRow[] = storedOperations.map(operation => {
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
            const current = currentConfigText(operation.configPath);
            return current === undefined ? false : matchesOperationResult(operation, current);
          })(),
        };
      });
      return jsonResponse({ operations } satisfies IntegrationJournalEnvelope, 200, req, ctx.config);
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

      const writeInput = await buildIntegrationWriteInput(operation.clientId, ctx, store);
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
        }),
      );
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

  if (req.method === "GET") {
    try {
      const input = await buildIntegrationWriteInput(requestedClient, ctx, integrationStore());
      const state = readIntegrationState(input);
      return jsonResponse(state satisfies IntegrationStateEnvelope, 200, req, ctx.config);
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

  try {
    const input = await buildIntegrationWriteInput(requestedClient, ctx, integrationStore());
    const result = await runIntegrationMutationFlight(
      requestedClient,
      parsed.enabled ? (parsed.overwriteConflict === true ? "overwrite" : "apply") : "disable",
      input.io?.now ?? Date.now,
      () => {
        const options = { lockSeams: integrationMutationTestHooks?.lockSeams };
        if (!parsed.enabled) return disableIntegrationCoordinated(input, options);
        return parsed.overwriteConflict === true
          ? overwriteIntegrationCoordinated(input, options)
          : applyIntegrationCoordinated(input, options);
      },
    );
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
