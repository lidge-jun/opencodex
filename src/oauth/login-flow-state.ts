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
  flowId?: string;
  /** Epoch ms after which a paste is refused as `no_pending_login`. */
  expiresAt?: number;
  errorCode?: LoginCodeError;
}

export const loginState = new Map<string, LoginFlowState>();
export const loginAbort = new Map<string, { controller: AbortController; flowId?: string }>();
export const kiroLoginSettling = new Set<string>();

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

/** Awaiting a terminal outcome for a provider's login (code mode answers its POST from this). */
const loginSettleWaiters = new Map<string, Set<() => void>>();

function wakeLoginWaiters(provider: string): void {
  const waiters = loginSettleWaiters.get(provider);
  if (!waiters) return;
  loginSettleWaiters.delete(provider);
  for (const wake of waiters) wake();
}

/**
 * Record a login's terminal outcome and wake anything awaiting it. Flow identity
 * (mode/flowId/expiresAt) is preserved so a settled flow still reports what it was. The hint is
 * dropped: `getLoginStatus` already hides it once done, and a settled flow has no next step.
 */
export function settleLoginFlow(
  provider: string,
  outcome: { error?: string; errorCode?: LoginCodeError } = {},
): void {
  const current = loginState.get(provider);
  loginState.set(provider, {
    ...current,
    done: true,
    hint: undefined,
    error: outcome.error,
    errorCode: outcome.errorCode,
  });
  wakeLoginWaiters(provider);
}

/** Drop a provider's flow state entirely; waiters are released rather than left hanging. */
export function dropLoginFlow(provider: string): void {
  loginState.delete(provider);
  wakeLoginWaiters(provider);
}

/** Resolve true once the provider's login is terminal, false if `timeoutMs` elapses first. */
export function waitForLoginSettled(provider: string, timeoutMs: number): Promise<boolean> {
  const current = loginState.get(provider);
  if (!current || current.done) return Promise.resolve(true);
  return new Promise<boolean>(resolve => {
    let waiters = loginSettleWaiters.get(provider);
    if (!waiters) {
      waiters = new Set();
      loginSettleWaiters.set(provider, waiters);
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

/** Forget a provider's login flow (logout). Any code-mode POST awaiting it is released. */
export function clearLoginState(provider: string): void {
  loginAbort.get(provider)?.controller.abort("cleared");
  loginAbort.delete(provider);
  clearManualCodeSlot(provider);
  dropLoginFlow(provider);
}

export function cancelLoginFlow(provider: string, flowId?: string): boolean {
  const active = loginAbort.get(provider);
  const existing = loginState.get(provider);
  if (flowId !== undefined && active?.flowId !== flowId) return false;
  if (!active && (!existing || existing.done)) return false;
  active?.controller.abort("cancelled");
  loginAbort.delete(provider);
  clearManualCodeSlot(provider);
  settleLoginFlow(provider, { error: "Login cancelled", errorCode: "no_pending_login" });
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
  for (const [provider, state] of loginState) {
    if (context.providerNames.has(provider) || !state.done || loginAbort.has(provider)) continue;
    if (loginState.delete(provider)) removed += 1;
    if (loginManual.delete(provider)) removed += 1;
    if (loginAbort.delete(provider)) removed += 1;
  }
  lastOAuthFlowReconciledGeneration = context.generation;
  return removed;
}

/** Test-only counterpart to `resetOAuthReauthStateForTests`, for the same leak. */
export function resetOAuthFlowReconcileStateForTests(): void {
  lastOAuthFlowReconciledGeneration = 0;
}

export function clearManualCodeSlot(provider: string): void {
  loginManual.delete(provider);
}

export function ensureManualCodeSlot(provider: string): ManualCodeSlot {
  let slot = loginManual.get(provider);
  if (!slot) {
    slot = {};
    loginManual.set(provider, slot);
  }
  return slot;
}

/** Wait for a GUI/CLI paste of the OAuth redirect URL or code (or return a stashed early submit). */
export function waitForManualLoginCode(provider: string, signal: AbortSignal, expectedState?: string): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
  }
  const slot = ensureManualCodeSlot(provider);
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
 * Feed a pasted redirect URL or authorization code into an in-progress GUI login.
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
 * Same validation as `submitManualLoginCode`, with the machine-readable reason attached.
 * Optionally pins the submission to one `flowId` so a paste from a superseded attempt is
 * refused rather than fed to whatever login is running now.
 */
export function submitLoginCode(
  provider: string,
  input: string,
  expectedFlowId?: string,
): { ok: true } | { ok: false; error: string; code: LoginCodeError } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "empty code", code: "malformed_input" };
  if (retainedUtf8Bytes(trimmed) > OAUTH_PENDING_CODE_MAX_BYTES) {
    return { ok: false, error: "code too large", code: "malformed_input" };
  }
  const st = loginState.get(provider);
  if (!st || st.done) return { ok: false, error: "no login in progress", code: "no_pending_login" };
  if (expectedFlowId !== undefined && st.flowId !== expectedFlowId) {
    return { ok: false, error: "no login in progress", code: "no_pending_login" };
  }
  if (st.expiresAt !== undefined && Date.now() > st.expiresAt) {
    return { ok: false, error: "login expired", code: "no_pending_login" };
  }
  const slot = ensureManualCodeSlot(provider);
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
  return { ok: true };
}
