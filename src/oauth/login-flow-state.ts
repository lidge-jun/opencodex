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
export const loginState = new Map<string, { error?: string; done: boolean }>();
export const loginAbort = new Map<string, { controller: AbortController; flowId?: string }>();
export const kiroLoginSettling = new Set<string>();

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
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "empty code" };
  if (retainedUtf8Bytes(trimmed) > OAUTH_PENDING_CODE_MAX_BYTES) return { ok: false, error: "code too large" };
  const st = loginState.get(provider);
  if (!st || st.done) return { ok: false, error: "no login in progress" };
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
  if (!parsed.code && !isCommandCodeJson) return { ok: false, error: "no authorization code found in input" };
  // A raw paste carrying an explicit code#state suffix is state-bearing too: it
  // must match the expected state rather than bypass validation.
  const stateBearing = !isCommandCodeJson && (parsed.kind !== "raw" || parsed.state !== undefined);
  if (stateBearing && slot.expectedState !== undefined) {
    if (parsed.state === undefined) return { ok: false, error: "redirect URL is missing the state parameter" };
    if (parsed.state !== slot.expectedState) {
      return {
        ok: false,
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
