import { AnthropicTokenError } from "./anthropic";
import { parseCallbackInput } from "./callback-server";
import { retainedUtf8Bytes } from "../lib/admission";
import type { GenerationContext } from "../lib/state-store-sweeper";

/**
 * In-flight login flow state and the manual paste slot that feeds it.
 *
 * Split out of `index.ts` when that file crossed the repository file-size ratchet at 2009
 * lines. The cut follows a seam rather than a line count: everything here is bookkeeping for
 * a login that has started and not yet settled, and none of it reads or writes a stored
 * credential. `index.ts` re-exports the two public names, so existing importers are unaffected.
 *
 * Every map here is keyed by FLOW ID, not by provider. A code-display flow binds no socket, so
 * a hosted login host can have several in flight for one provider at once; each must have its
 * own paste slot and its own abort scope, or one user's paste settles another's login. The
 * provider-only public APIs (`getLoginStatus`, `submitManualLoginCode`, `cancelLoginFlow`)
 * resolve through `latestLoginFlowKey`, which is the one place that rule is written down.
 */
/** Human-facing continuation only: never retain credentials or provider response objects. */
export interface OAuthLoginHint {
  url: string;
  instructions?: string;
  deviceCode?: string;
}

/**
 * Machine-readable outcome of a code-display login, so a caller that only ever sees one HTTP
 * response can tell a bad paste from a dead flow from an unreachable provider. Never carries
 * any part of the code, verifier, state or token.
 */
export type LoginCodeError =
  | "state_mismatch"
  | "invalid_or_expired_code"
  | "no_pending_login"
  | "provider_unreachable"
  | "malformed_input"
  | "code_mode_unsupported";

export interface LoginFlowState {
  error?: string;
  done: boolean;
  hint?: OAuthLoginHint;
  /** Absent means the default localhost-callback flow; "code" is the code-display flow. */
  mode?: "callback" | "code";
  /**
   * Which provider this flow logs into, since the key no longer says. Absent on a row written
   * straight into this map by a caller that predates flow-id keying, where the key IS the
   * provider name — `loginFlowProvider` resolves both.
   */
  provider?: string;
  flowId?: string;
  /** Epoch ms after which a paste is refused as `no_pending_login`. */
  expiresAt?: number;
  errorCode?: LoginCodeError;
}

/** Keyed by flow id. */
export const loginState = new Map<string, LoginFlowState>();
/** Keyed by flow id; `provider` is what a provider-scoped caller is checked against. */
export const loginAbort = new Map<string, { controller: AbortController; provider?: string }>();
export const kiroLoginSettling = new Set<string>();

/** The provider a flow belongs to, or undefined when no such flow is recorded. */
export function loginFlowProvider(flowKey: string): string | undefined {
  const state = loginState.get(flowKey);
  return state === undefined ? undefined : state.provider ?? flowKey;
}

/** Flow ids recorded for a provider, oldest first (Map iteration is insertion order). */
export function loginFlowKeys(provider: string): string[] {
  // ponytail: linear scan over in-flight logins (bounded by MAX_LOGIN_FLOWS_PER_PROVIDER);
  // add a provider -> keys index if that bound ever grows.
  const keys: string[] = [];
  for (const [key, state] of loginState) if (state.provider ?? key === provider) keys.push(key);
  return keys;
}

/**
 * The flow that a provider-only API acts on: the NEWEST flow still in progress, or — when none
 * is — the newest flow overall, so a login that just settled still reports its outcome. With a
 * single flow (every callback login, and every GUI/CLI login) this is that flow, unchanged.
 */
export function latestLoginFlowKey(provider: string): string | undefined {
  const keys = loginFlowKeys(provider);
  return keys.findLast(key => loginState.get(key)?.done === false) ?? keys.at(-1);
}

/**
 * Rows kept per provider. Concurrent code flows mean an authenticated caller can start logins
 * nobody ever finishes, each holding a PKCE verifier, an AbortController and an open paste
 * promise. Expired flows are reaped first; this is the backstop that bounds the rest.
 */
const MAX_LOGIN_FLOWS_PER_PROVIDER = 64;

/** Abort a flow, drop its paste slot, and record a terminal outcome for anything awaiting it. */
export function abandonLoginFlow(flowKey: string, outcome: { error: string; errorCode: LoginCodeError }): void {
  loginAbort.get(flowKey)?.controller.abort("cancelled");
  loginAbort.delete(flowKey);
  clearManualCodeSlot(flowKey);
  settleLoginFlow(flowKey, outcome);
}

/**
 * Refuse a login that cannot safely share this process with what is already in flight, after
 * reaping dead rows. A code-display flow binds nothing, so several can run at once for one
 * provider — that is what lets a hosted login host serve more than one user. The callback flow
 * binds the fixed loopback port and genuinely cannot run twice, so any overlap involving one is
 * refused, as is anything past the per-provider row cap.
 */
export function admitLoginFlow(provider: string, codeMode: boolean): void {
  reapLoginFlows(provider);
  const inFlight = loginFlowKeys(provider)
    .map(key => loginState.get(key))
    .filter(state => state?.done === false);
  const overlapAllowed = codeMode && inFlight.every(state => state?.mode === "code");
  if ((inFlight.length > 0 && !overlapAllowed) || (provider === "kiro" && kiroLoginSettling.has(provider))) {
    throw new Error(`A login for ${provider} is already in progress`);
  }
  if (loginFlowKeys(provider).length >= MAX_LOGIN_FLOWS_PER_PROVIDER) {
    throw new Error(`Too many logins in progress for ${provider}`);
  }
}

/**
 * Drop a provider's dead rows: code flows past their paste window (they can never complete),
 * then the oldest settled rows once the cap is reached. Called when a flow starts, which is
 * the only moment the count can grow. Never evicts a flow still in progress.
 */
function reapLoginFlows(provider: string): void {
  const now = Date.now();
  for (const key of loginFlowKeys(provider)) {
    const state = loginState.get(key);
    if (state && !state.done && state.expiresAt !== undefined && now > state.expiresAt) {
      abandonLoginFlow(key, { error: "Login expired", errorCode: "no_pending_login" });
    }
  }
  const keys = loginFlowKeys(provider);
  // +1 leaves room for the flow about to be recorded.
  const excess = keys.length - MAX_LOGIN_FLOWS_PER_PROVIDER + 1;
  if (excess <= 0) return;
  for (const key of keys.filter(key => loginState.get(key)?.done === true).slice(0, excess)) {
    clearManualCodeSlot(key);
    dropLoginFlow(key);
  }
}

/** A code-display flow the user never completes must stop accepting pastes. */
export const CODE_LOGIN_TTL_MS = 10 * 60_000;

export class CodeLoginUnsupportedError extends Error {
  constructor(provider: string) {
    super(`${provider} has no code-display login`);
    this.name = "CodeLoginUnsupportedError";
  }
}

/**
 * Map a login failure onto the code a code-mode caller receives. The error itself is never
 * forwarded: a provider body can quote the submitted code back, and this response is the one
 * surface a hosted caller renders to a user.
 *
 * `AnthropicTokenError` is named because anthropic is the only provider with a code-display
 * redirect today; every other failure falls through the generic branches.
 */
export function classifyLoginCodeError(error: unknown): LoginCodeError {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("OAuth callback cancelled")) return "no_pending_login";
  if (error instanceof AnthropicTokenError) {
    return error.httpStatus !== undefined && error.httpStatus >= 500
      ? "provider_unreachable"
      : "invalid_or_expired_code";
  }
  const name = error instanceof Error ? error.name : "";
  // fetch() reports a dead network as TypeError and its own deadline as TimeoutError.
  if (name === "TimeoutError" || name === "AbortError" || error instanceof TypeError) {
    return "provider_unreachable";
  }
  return "invalid_or_expired_code";
}

/** Awaiting a terminal outcome for one flow (code mode answers its POST from this). */
const loginSettleWaiters = new Map<string, Set<() => void>>();

function wakeLoginWaiters(flowKey: string): void {
  const waiters = loginSettleWaiters.get(flowKey);
  if (!waiters) return;
  loginSettleWaiters.delete(flowKey);
  for (const wake of waiters) wake();
}

/**
 * Record a login's terminal outcome and wake anything awaiting it. Flow identity
 * (mode/flowId/expiresAt) is preserved so a settled flow still reports what it was. The hint is
 * dropped: `getLoginStatus` already hides it once done, and a settled flow has no next step.
 */
export function settleLoginFlow(
  flowKey: string,
  outcome: { error?: string; errorCode?: LoginCodeError } = {},
): void {
  const current = loginState.get(flowKey);
  // A flow already dropped (logout, reap) has nothing left to report; releasing its waiters is
  // still owed, and fabricating a row here would be a flow belonging to no provider.
  if (current) {
    loginState.set(flowKey, {
      ...current,
      done: true,
      hint: undefined,
      error: outcome.error,
      errorCode: outcome.errorCode,
    });
  }
  wakeLoginWaiters(flowKey);
}

/** Drop one flow's state entirely; waiters are released rather than left hanging. */
export function dropLoginFlow(flowKey: string): void {
  loginState.delete(flowKey);
  wakeLoginWaiters(flowKey);
}

/**
 * Resolve true once the login is terminal, false if `timeoutMs` elapses first. `flowId` picks
 * one of several concurrent flows; without it the provider's newest flow is used.
 */
export function waitForLoginSettled(provider: string, timeoutMs: number, flowId?: string): Promise<boolean> {
  const flowKey = flowId ?? latestLoginFlowKey(provider);
  const current = flowKey === undefined ? undefined : loginState.get(flowKey);
  if (!current || current.done || loginFlowProvider(flowKey!) !== provider) return Promise.resolve(true);
  return new Promise<boolean>(resolve => {
    let waiters = loginSettleWaiters.get(flowKey!);
    if (!waiters) {
      waiters = new Set();
      loginSettleWaiters.set(flowKey!, waiters);
    }
    let timer: ReturnType<typeof setTimeout>;
    const wake = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      waiters.delete(wake);
      resolve(false);
    }, timeoutMs);
    waiters.add(wake);
  });
}

/**
 * Forget every login flow for a provider (logout): it invalidates all of them, not just the
 * newest. Any code-mode POST awaiting one is released rather than left to time out.
 */
export function clearLoginState(provider: string): void {
  for (const flowKey of loginFlowKeys(provider)) {
    loginAbort.get(flowKey)?.controller.abort("cleared");
    loginAbort.delete(flowKey);
    clearManualCodeSlot(flowKey);
    dropLoginFlow(flowKey);
  }
}

/**
 * Cancel one login. `flowId` names it exactly; without one the provider's newest in-flight flow
 * is cancelled, which is every single-flow caller (GUI, CLI) unchanged. A flow id belonging to a
 * different provider is refused rather than cancelled.
 */
export function cancelLoginFlow(provider: string, flowId?: string): boolean {
  const flowKey = flowId ?? latestLoginFlowKey(provider);
  if (flowKey === undefined) return false;
  const active = loginAbort.get(flowKey);
  const existing = loginState.get(flowKey);
  if ((active?.provider ?? loginFlowProvider(flowKey)) !== provider) return false;
  if (!active && (!existing || existing.done)) return false;
  abandonLoginFlow(flowKey, { error: "Login cancelled", errorCode: "no_pending_login" });
  return true;
}

/** Pending paste for a login in progress: either a waiter or a stashed early submission. */
export interface ManualCodeSlot {
  pendingInput?: string;
  resolve?: (value: string) => void;
  /** Registered by the callback flow so submits can validate state synchronously. */
  expectedState?: string;
}
const loginManual = new Map<string, ManualCodeSlot>();
const OAUTH_PENDING_CODE_MAX_BYTES = 4 * 1024;
let lastOAuthFlowReconciledGeneration = 0;

export function reconcileOAuthFlowState(context: GenerationContext): number {
  if (context.generation <= lastOAuthFlowReconciledGeneration) return 0;
  let removed = 0;
  for (const [flowKey, state] of loginState) {
    const provider = state.provider ?? flowKey!;
    if (context.providerNames.has(provider) || !state.done || loginAbort.has(flowKey)) continue;
    if (loginState.delete(flowKey)) removed += 1;
    if (loginManual.delete(flowKey)) removed += 1;
    if (loginAbort.delete(flowKey)) removed += 1;
  }
  lastOAuthFlowReconciledGeneration = context.generation;
  return removed;
}

/** Test-only counterpart to `resetOAuthReauthStateForTests`, for the same leak. */
export function resetOAuthFlowReconcileStateForTests(): void {
  lastOAuthFlowReconciledGeneration = 0;
}

export function clearManualCodeSlot(flowKey: string): void {
  loginManual.delete(flowKey);
}

export function ensureManualCodeSlot(flowKey: string): ManualCodeSlot {
  let slot = loginManual.get(flowKey);
  if (!slot) {
    slot = {};
    loginManual.set(flowKey, slot);
  }
  return slot;
}

/** Wait for a GUI/CLI paste of the OAuth redirect URL or code (or return a stashed early submit). */
export function waitForManualLoginCode(flowKey: string, signal: AbortSignal, expectedState?: string): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
  }
  const slot = ensureManualCodeSlot(flowKey);
  if (expectedState !== undefined) slot.expectedState = expectedState;
  if (slot.pendingInput !== undefined) {
    const value = slot.pendingInput;
    slot.pendingInput = undefined;
    return Promise.resolve(value);
  }
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      if (slot.resolve === resolve) slot.resolve = undefined;
      reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    slot.resolve = (value: string) => {
      signal.removeEventListener("abort", onAbort);
      if (slot.resolve === resolve) slot.resolve = undefined;
      resolve(value);
    };
  });
}

/**
 * Feed a pasted redirect URL or authorization code into an in-progress GUI login. Provider-only,
 * so it feeds the provider's newest in-flight flow — see `latestLoginFlowKey`.
 * Returns ok:false when no login is waiting (or input is empty). Invalid pastes are accepted
 * here and re-prompted by the OAuth callback loop if they cannot be parsed / fail state checks.
 */
export function submitManualLoginCode(provider: string, input: string): { ok: true } | { ok: false; error: string } {
  const result = submitLoginCode(provider, input);
  // The machine-readable code is dropped here on purpose: this return shape is the
  // long-standing contract of the callback flow's paste route. Code mode calls
  // submitLoginCode directly because it must answer with the code.
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Same validation as `submitManualLoginCode`, with the machine-readable reason attached, and
 * the id of the flow the paste was applied to so the caller can await THAT flow rather than
 * whichever one is newest by the time it looks.
 *
 * `expectedFlowId` pins the submission to one flow: a paste from a superseded attempt, or one
 * aimed at another concurrent login, is refused rather than fed to whatever is running now.
 */
export function submitLoginCode(
  provider: string,
  input: string,
  expectedFlowId?: string,
): { ok: true; flowId: string } | { ok: false; error: string; code: LoginCodeError } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "empty code", code: "malformed_input" };
  if (retainedUtf8Bytes(trimmed) > OAUTH_PENDING_CODE_MAX_BYTES) {
    return { ok: false, error: "code too large", code: "malformed_input" };
  }
  // The flow id IS the key, so an id belonging to another provider's flow (or to no flow at
  // all) resolves to nothing here rather than reaching a login it does not own.
  const flowKey = expectedFlowId ?? latestLoginFlowKey(provider);
  const st = flowKey === undefined ? undefined : loginState.get(flowKey);
  if (!st || st.done || loginFlowProvider(flowKey!) !== provider) {
    return { ok: false, error: "no login in progress", code: "no_pending_login" };
  }
  if (st.expiresAt !== undefined && Date.now() > st.expiresAt) {
    return { ok: false, error: "login expired", code: "no_pending_login" };
  }
  const slot = ensureManualCodeSlot(flowKey!);
  // Synchronous validation (validated request/ack): reject un-parseable input and
  // authorization responses (url/query kind) whose state is missing or mismatched
  // once the flow has registered its expected state. Raw codes stay in-session-PKCE
  // protected — but a raw paste carrying an explicit #state suffix is state-bearing
  // and checked too. Early posts (flow not yet waiting, no expectedState) are
  // stashed and re-validated by the callback loop.
  const parsed = parseCallbackInput(trimmed);
  // Command Code's manual fallback accepts a pasted JSON callback payload
  // (`{ apiKey, state, ... }`). Keep that opaque to the generic raw parser so
  // hashes in JSON strings do not become a fake state suffix; its provider parser validates state.
  const isCommandCodeJson = provider === "command-code" && trimmed.startsWith("{");
  if (!parsed.code && !isCommandCodeJson) {
    return { ok: false, error: "no authorization code found in input", code: "malformed_input" };
  }
  // A raw paste carrying an explicit code#state suffix is state-bearing too: it
  // must match the expected state rather than bypass validation.
  const stateBearing = !isCommandCodeJson && (parsed.kind !== "raw" || parsed.state !== undefined);
  if (stateBearing && slot.expectedState !== undefined) {
    if (parsed.state === undefined) {
      return { ok: false, error: "redirect URL is missing the state parameter", code: "state_mismatch" };
    }
    if (parsed.state !== slot.expectedState) {
      return {
        ok: false,
        code: "state_mismatch",
        error: parsed.kind === "raw"
          ? "state mismatch — paste the bare code, or the correct code#state from THIS login attempt"
          : "state mismatch — paste the redirect URL from THIS login attempt",
      };
    }
  }
  if (slot.resolve) {
    const resolve = slot.resolve;
    slot.resolve = undefined;
    resolve(trimmed);
  } else {
    // Race: GUI may POST before the flow reaches onManualCodeInput — stash for the waiter.
    slot.pendingInput = trimmed;
  }
  return { ok: true, flowId: flowKey! };
}
