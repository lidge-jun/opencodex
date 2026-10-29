import { getConfigDir } from "../../config/paths";
import { didRunDrainStartHooks, didRunOptionalShutdownHooks, registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import type { AdapterEvent, OcxUsage } from "../../types";
import { buildStepCliArgs } from "./profiles";

/**
 * How long a conversation's process survives without traffic.
 *
 * Long enough that a Codex thread's pauses between turns do not tear the conversation down, short
 * enough that an abandoned thread does not leave a StepCode process running.
 */
export const STEP_CLI_IDLE_TIMEOUT_MS = 10 * 60_000;
import {
  resolveStepCliBinaryPath,
  stepCliProcessEnvironment,
  StepSessionError,
  type StepSessionDeps,
  type StepSessionEvent,
} from "./session";
import {
  StepSessionPool,
  type StepConversationHost,
  type StepConversationRef,
  type StepConversationSession,
} from "./session-pool";

/**
 * Process- and turn-lifetime state that outlives a request.
 *
 * `createStepCliAdapter` runs once per request, so anything that must survive a request boundary
 * cannot live in its closure: a reverse request arriving during request N+1 would be routed to an
 * instance that no longer exists and the conversation would silently restart. `devin/trajectory.ts`
 * keeps its conversation map at module scope for the same reason.
 */

/**
 * Per-request turn state, keyed by the process that owns it.
 *
 * `createStepCliAdapter` runs once per request, so nothing that has to survive a request boundary can
 * live in its closure: a reverse request arriving during request N+1 would be routed to an instance
 * that no longer exists, and the conversation would silently restart. `devin/trajectory.ts` keeps its
 * conversation map at module scope for the same reason.
 */
export interface StepTurnRuntime {
  ref: StepConversationRef;
  pool: StepConversationHost;
  emit: (event: AdapterEvent) => void;
  settle: () => void;
  emittedNames: Map<string, string>;
  catalogKey: string;
  queryId?: string;
}

export const turnRuntimes = new WeakMap<StepConversationSession, StepTurnRuntime>();

export const lastAssistantUsage = new WeakMap<StepConversationSession, OcxUsage>();

/** Query currently owned by each session, so an abandoned turn can interrupt exactly that one. */
export const lastQueryId = new WeakMap<StepConversationSession, string>();

/* ------------------------------------------------------------------------- *
 * Turn runtime accessors.
 *
 * `events` and `adapter` go through these instead of touching the maps, so the storage shape can
 * change without every caller changing with it — and so "who owns this session's turn" is answered in
 * one place rather than by whoever happens to remember the variable name.
 * ------------------------------------------------------------------------- */

/** Attach a turn to the session that owns it, replacing any turn left behind. */
export function beginTurn(session: StepConversationSession, turn: StepTurnRuntime): void {
  lastAssistantUsage.delete(session);
  turnRuntimes.set(session, turn);
}

/** The turn currently owning this session, if any. */
export function currentTurn(session: StepConversationSession): StepTurnRuntime | undefined {
  return turnRuntimes.get(session);
}

/** Detach a session's turn. Returns true when one was actually attached. */
export function endTurn(session: StepConversationSession): boolean {
  return turnRuntimes.delete(session);
}

/** Record the usage the CLI reported for this session's assistant turn. */
export function recordAssistantUsage(session: StepConversationSession, usage: OcxUsage): void {
  lastAssistantUsage.set(session, usage);
}

/** The usage recorded for this session's assistant turn, if any. */
export function assistantUsage(session: StepConversationSession): OcxUsage | undefined {
  return lastAssistantUsage.get(session);
}

/** Remember which query this session is running, so an abandoned turn interrupts exactly that one. */
export function rememberQuery(session: StepConversationSession, queryId: string): void {
  lastQueryId.set(session, queryId);
  const turn = currentTurn(session);
  if (turn) turn.queryId = queryId;
}

/** The query this session is running, if any. */
export function currentQuery(session: StepConversationSession): string | undefined {
  return lastQueryId.get(session);
}

/** Forget the session's query, e.g. once its input stream has been closed. */
export function forgetQuery(session: StepConversationSession): void {
  lastQueryId.delete(session);
}

/** One pool per OpenCodex home, so two homes in one process never share a StepCode session. */
export const pools = new Map<string, StepSessionPool>();

const STEP_CLI_SHUTDOWN_KEY = "step-cli-sessions";
let shutdownHookInstalled = false;

/**
 * Close every live StepCode process when the proxy stops.
 *
 * The sibling CLI routes spawn a child per request and kill it in a `finally`, so they cannot outlive a
 * turn. This route deliberately keeps a process alive for a whole conversation, which means nothing
 * kills it on shutdown: measured, a stopped proxy left an orphaned `step` behind holding the user's
 * subscription session. Closing them here is the only thing standing between a restart and a leak.
 */

/**
 * Close every live StepCode process when the proxy stops.
 *
 * The sibling CLI routes spawn a child per request and kill it in a `finally`, so they cannot outlive a
 * turn. This route deliberately keeps a process alive for a whole conversation, which means nothing
 * kills it on shutdown: measured, a stopped proxy left an orphaned `step` behind holding the user's
 * subscription session. Closing them here is the only thing standing between a restart and a leak.
 */
export function ensureShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  registerOptionalShutdownHook(STEP_CLI_SHUTDOWN_KEY, () => {
    // This core hook is synchronous/best-effort. The explicit async clear retains failed
    // ownership and reports its rejection; the hook must observe that same failure too.
    void clearStepCliSessions().catch(() => {
      console.warn("[step-cli] Process cleanup failed; conversation pools remain quarantined.");
    });
  });
}

/** Drop every live session. Used by tests and available to a config reload. */

/** Drop every live session. Used by tests and available to a config reload. */
export async function clearStepCliSessions(): Promise<void> {
  const closed = await Promise.allSettled([...pools].map(async ([home, pool]) => {
    await pool.closeAll();
    if (pools.get(home) === pool) pools.delete(home);
  }));
  const failure = closed.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export function poolFor(
  home: string,
  deps: StepSessionDeps,
  handlers: { onEvent(event: StepSessionEvent): void },
): StepSessionPool {
  if (didRunDrainStartHooks() || didRunOptionalShutdownHooks()) throw new StepSessionError("StepCode cannot open sessions while the proxy is shutting down.");
  ensureShutdownHook();
  const existing = pools.get(home);
  if (existing) return existing;
  const { env, cwd } = stepCliProcessEnvironment(home);
  const pool = new StepSessionPool(
    {
      openCodexHome: home,
      idleTimeoutMs: STEP_CLI_IDLE_TIMEOUT_MS,
      buildOptions: () => ({
        binary: resolveStepCliBinaryPath(deps.which),
        args: buildStepCliArgs(undefined, undefined),
        env,
        cwd,
        handshakeTimeoutMs: 30_000,
        requestTimeoutMs: 120_000,
        // StepCode's own tool window is 120s and answering later produces a `permission_denied`
        // message inside the model's context, so the hold is bounded shorter and fails the turn.
        reverseRequestHoldMs: 110_000,
        idleTimeoutMs: STEP_CLI_IDLE_TIMEOUT_MS,
        killGraceMs: 2_000,
      }),
    },
    handlers,
    deps,
  );
  pools.set(home, pool);
  return pool;
}

/**
 * A reverse request the CLI is waiting on this peer to answer.
 *
 * `permission.request` is allowed immediately because the approval already happened upstream of this
 * adapter. A `sdk_tool.invoke` is deliberately NOT answered here: its result only exists once the
 * client has executed the tool and sent its next request, and answering it is how that result reaches
 * the model inside the query the model is already running.
 */
/**
 * Exported for its regression tests: every reverse request must be ANSWERED, and the tests drive this
 * exact function rather than a mirror of it.
 */
