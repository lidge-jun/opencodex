import type { OcxConfig } from "../types";
import { jsonResponse } from "../server/auth-cors";
import { acquireNativeMainProfileDrain, getNativeMainProfileRequestCount } from "../server/lifecycle";
import {
  managementBodyTooLargeResponse,
  readManagementJsonBody,
  rethrowManagementBodyTooLarge,
} from "../server/management/body";
import { NativeProfileManager } from "./native-profile-manager";
import { NativeProfileError } from "./native-profile-types";
import {
  blockNativeMainRecovery,
  completeNativeMainRecovery,
  nativeMainStartupGateSnapshot,
} from "./native-profile-startup";
import { probeNativeProfileRecoveryState } from "./native-profile-store";
import { nativeMainOwnerSnapshot, withNativeMainOwnerOperation } from "./native-main-owner";
import { withNativeMainExclusiveClaim, withNativeMainSharedClaim } from "./native-main-claim";

export interface NativeProfileApiDeps {
  manager?: NativeProfileManager;
  drainTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  probeRecoveryState?: typeof probeNativeProfileRecoveryState;
  blockRecovery?: typeof blockNativeMainRecovery;
  completeRecovery?: typeof completeNativeMainRecovery;
}

type NativeMainApiClaim =
  | { mode: "none" }
  | { mode: "shared" }
  | { mode: "exclusive"; waitMs: number };

async function withNativeMainApiOperation<T>(
  manager: NativeProfileManager,
  operation: () => Promise<T>,
  claim: NativeMainApiClaim = { mode: "none" },
): Promise<T> {
  // Direct handler unit tests and library callers may inject a partial manager.
  // A live server always constructs a real manager and registers an owner entry
  // before listen, so only that path needs the additional cross-process claim.
  const context = (manager as Partial<NativeProfileManager>).context;
  if (!context) return operation();
  return withNativeMainOwnerOperation(context, () => {
    if (!nativeMainOwnerSnapshot(context) || claim.mode === "none") return operation();
    if (claim.mode === "shared") return withNativeMainSharedClaim(context, operation);
    return withNativeMainExclusiveClaim(context, operation, { waitMs: claim.waitMs });
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await readManagementJsonBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body");
    return parsed as Record<string, unknown>;
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    throw new NativeProfileError("INVALID_REQUEST", "A JSON object body is required.", 400);
  }
}

async function withMainRequestDrain<T>(deps: NativeProfileApiDeps, operation: () => Promise<T>): Promise<T> {
  const drainLease = acquireNativeMainProfileDrain("native-main-profile");
  if (!drainLease) throw new NativeProfileError("MAIN_REQUESTS_ACTIVE", "The proxy is already draining requests.", 503, true);
  try {
    const deadline = Date.now() + (deps.drainTimeoutMs ?? 10_000);
    while (getNativeMainProfileRequestCount() > 0 && Date.now() < deadline) await (deps.sleep ?? Bun.sleep)(50);
    if (getNativeMainProfileRequestCount() > 0) {
      throw new NativeProfileError("MAIN_REQUESTS_ACTIVE", "In-flight requests did not finish before the native-login switch deadline.", 409, true);
    }
    return await operation();
  } finally {
    drainLease.release();
  }
}

async function withRecoveryGateTransition<T>(
  manager: NativeProfileManager,
  deps: NativeProfileApiDeps,
  operation: () => Promise<T>,
): Promise<T> {
  const context = manager.context;
  if (!context) return operation();
  const probe = deps.probeRecoveryState ?? probeNativeProfileRecoveryState;
  const block = deps.blockRecovery ?? blockNativeMainRecovery;
  let before: ReturnType<typeof probeNativeProfileRecoveryState>;
  try {
    before = probe(context);
  } catch (error) {
    try { block(context.homeId); } catch { /* preserve the probe failure */ }
    throw error;
  }
  let operationFailed = false;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    let after: ReturnType<typeof probeNativeProfileRecoveryState> = "none";
    let afterProbed = false;
    let transitionError: unknown;
    try {
      after = probe(context);
      afterProbed = true;
    } catch (error) {
      transitionError = error;
      try { block(context.homeId); } catch { /* preserve the operation/probe failure */ }
    }
    if (!afterProbed) {
      if (!operationFailed) throw transitionError;
    } else if (after !== "none") {
      try {
        block(context.homeId, after);
      } catch (error) {
        if (!operationFailed) throw error;
      }
    } else {
      const gate = nativeMainStartupGateSnapshot();
      const matchingGateCanComplete = gate.status === "blocked"
        && gate.homeId === context.homeId
        && (gate.reason === "recovery-pending" || gate.reason === "manual-recovery")
        && (before !== "none" || !operationFailed);
      if (matchingGateCanComplete) {
        try {
          (deps.completeRecovery ?? completeNativeMainRecovery)(context.homeId);
        } catch (transitionError) {
          // Preserve the operation's typed/public error. A post-operation probe or
          // completion failure must not replace it; the gate remains fail closed.
          if (!operationFailed) throw transitionError;
        }
      }
    }
  }
}

export async function handleNativeProfileAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
  deps: NativeProfileApiDeps = {},
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/native-main-profiles")) return null;
  try {
    const manager = deps.manager ?? new NativeProfileManager();
    if (url.pathname === "/api/native-main-profiles" && req.method === "GET") {
      return jsonResponse(await manager.list(), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/doctor" && req.method === "GET") {
      return jsonResponse(await withNativeMainApiOperation(manager, () => manager.doctor(), { mode: "shared" }), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/register" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.label !== "string") throw new NativeProfileError("INVALID_REQUEST", "A profile label is required.", 400);
      return jsonResponse(await withNativeMainApiOperation(
        manager,
        () => manager.register(input.label as string),
        { mode: "shared" },
      ), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/stage" && req.method === "POST") {
      return jsonResponse(await withNativeMainApiOperation(
        manager,
        () => manager.prepareStage(),
        { mode: "shared" },
      ), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/stage/heartbeat" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.stageId !== "string" || typeof input.writerToken !== "string") {
        throw new NativeProfileError("INVALID_REQUEST", "A staging identifier and writer token are required.", 400);
      }
      return jsonResponse(await withNativeMainApiOperation(
        manager,
        () => manager.heartbeatStage(input.stageId as string, input.writerToken as string),
      ), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/stage/finish" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.stageId !== "string" || typeof input.writerToken !== "string" || typeof input.label !== "string") {
        throw new NativeProfileError("INVALID_REQUEST", "A staging identifier, writer token, and profile label are required.", 400);
      }
      return jsonResponse(await withNativeMainApiOperation(
        manager,
        () => manager.finishStage(input.stageId as string, input.writerToken as string, input.label as string),
        { mode: "shared" },
      ), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/stage/cancel" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.stageId !== "string" || typeof input.writerToken !== "string") {
        throw new NativeProfileError("INVALID_REQUEST", "A staging identifier and writer token are required.", 400);
      }
      const cleanup = await withNativeMainApiOperation(
        manager,
        () => manager.cancelStage(input.stageId as string, input.writerToken as string),
      );
      return jsonResponse({ ok: true, ...cleanup }, 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/switch" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.target !== "string") throw new NativeProfileError("INVALID_REQUEST", "A target profile is required.", 400);
      const switched = await withMainRequestDrain(deps, () => withRecoveryGateTransition(
        manager,
        deps,
        () => withNativeMainApiOperation(
          manager,
          () => manager.switch(input.target as string, input.confirmedStopped === true),
          { mode: "exclusive", waitMs: deps.drainTimeoutMs ?? 10_000 },
        ),
      ));
      return jsonResponse(
        switched,
        200,
        req,
        config,
      );
    }
    if (url.pathname === "/api/native-main-profiles/recover" && req.method === "POST") {
      const input = await body(req);
      const recovered = await withMainRequestDrain(deps, () => withRecoveryGateTransition(
        manager,
        deps,
        () => withNativeMainApiOperation(
          manager,
          () => manager.recover(input.rollback === true, input.confirmedStopped === true),
          { mode: "exclusive", waitMs: deps.drainTimeoutMs ?? 10_000 },
        ),
      ));
      return jsonResponse(recovered, 200, req, config);
    }
    return jsonResponse({ error: "Unknown native-profile operation", code: "INVALID_REQUEST" }, 404, req, config);
  } catch (error) {
    const tooLarge = managementBodyTooLargeResponse(error, req, config);
    if (tooLarge) return tooLarge;
    if (error instanceof NativeProfileError) {
      return jsonResponse({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
        ...(error.cleanupRequired === true ? { cleanupRequired: true } : {}),
        ...(typeof error.plaintextMayRemain === "boolean" ? { plaintextMayRemain: error.plaintextMayRemain } : {}),
      }, error.status, req, config);
    }
    return jsonResponse({ error: "Native-profile operation failed.", code: "INTERNAL_ERROR" }, 500, req, config);
  }
}
