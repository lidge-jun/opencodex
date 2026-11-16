/**
 * Use policy for the Antigravity ACP provider (plan 080).
 *
 * Google permits a personal app to launch the official `agy acp` binary for the user's own account
 * when use is interactive and user-directed, not an unattended worker pool or automated agent loop,
 * and points programmatic workloads to a Gemini API key or Vertex AI. OpenCodex documents that and
 * enforces only signals it can know for certain: a subagent turn (`x-codex-parent-thread-id`), a
 * combo member, a route chosen by subagent fallback, and a request that did not come from this
 * machine. No heuristic beyond those is applied.
 */
import { currentRequestIsLocal } from "../../lib/request-peer-scope";

export const AGY_ACP_INTERACTIVE_ONLY = "agy_acp_interactive_only";
export const AGY_ACP_LOCAL_ONLY = "agy_acp_local_only";

export interface AgyAcpPolicySignals {
  headers: Headers;
  comboAttempt?: boolean;
  subagentFallback?: boolean;
  /** Override for tests and callers that already hold the snapshot; defaults to the request scope. */
  local?: boolean;
}

export interface AgyAcpPolicyRefusal {
  status: 403;
  errorType: "permission_error";
  code: typeof AGY_ACP_INTERACTIVE_ONLY | typeof AGY_ACP_LOCAL_ONLY;
  message: string;
}

const INTERACTIVE_MESSAGE = "The Antigravity CLI (ACP) provider is for interactive, user-directed turns only: it refuses subagent turns, combo members and subagent-fallback routing, per Google's terms for the agy acp binary. Use a Gemini API key or Vertex AI for programmatic workloads.";
const LOCAL_MESSAGE = "The Antigravity CLI (ACP) provider serves only requests from this machine: it is never shared over a hub, link or remote listener. Use a Gemini API key or Vertex AI for shared or programmatic workloads.";

/** The refusal for a turn this provider must not serve, or undefined when it may run. */
export function agyAcpPolicyRefusal(signals: AgyAcpPolicySignals): AgyAcpPolicyRefusal | undefined {
  if (signals.headers.has("x-codex-parent-thread-id") || signals.comboAttempt === true || signals.subagentFallback === true) {
    return { status: 403, errorType: "permission_error", code: AGY_ACP_INTERACTIVE_ONLY, message: INTERACTIVE_MESSAGE };
  }
  const local = signals.local ?? currentRequestIsLocal();
  if (!local) return { status: 403, errorType: "permission_error", code: AGY_ACP_LOCAL_ONLY, message: LOCAL_MESSAGE };
  return undefined;
}
