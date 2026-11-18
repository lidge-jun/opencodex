/**
 * Use policy for the Antigravity ACP provider (plan 080).
 *
 * Google permits a personal app to launch the official `agy acp` binary for the user's own account
 * when use is interactive and user-directed, not an unattended worker pool or automated agent loop,
 * and points programmatic workloads to a Gemini API key or Vertex AI. OpenCodex documents that and
 * enforces only signals it can know for certain: a subagent turn (`x-codex-parent-thread-id`), an
 * unattended Codex turn that Codex itself labels (a memory-pipeline turn or a spawned thread), a
 * combo member or a combo's internal decision call, a route chosen by subagent fallback, and a
 * request the listener classified as remote. No heuristic beyond those is applied.
 */
import { detectMemoryModelPhase } from "../../server/responses/memory-models";
import { isThreadSpawnRequest, isThreadSpawnTurnMetadata } from "../../server/effort-policy";
import { currentRequestIsLocal } from "../../lib/request-peer-scope";

export const AGY_ACP_INTERACTIVE_ONLY = "agy_acp_interactive_only";
export const AGY_ACP_LOCAL_ONLY = "agy_acp_local_only";

export interface AgyAcpPolicySignals {
  headers: Headers;
  /** The request body, for the frame's own copy of Codex's turn metadata (WebSocket turns carry it there). */
  body?: unknown;
  inboundTransport?: "websocket";
  comboAttempt?: boolean;
  subagentFallback?: boolean;
  /** A combo's internal decision call (JEV): combo machinery, refused like a combo member. */
  internalDecisionCall?: boolean;
  /** Override for tests and callers that already hold the snapshot; defaults to the request scope. */
  local?: boolean;
}

export interface AgyAcpPolicyRefusal {
  status: 403;
  errorType: "permission_error";
  code: typeof AGY_ACP_INTERACTIVE_ONLY | typeof AGY_ACP_LOCAL_ONLY;
  message: string;
}

const INTERACTIVE_MESSAGE = "The Antigravity CLI (ACP) provider is for interactive, user-directed turns only: it refuses subagent and spawned-thread turns, Codex memory turns, combo members and combo decision calls, and subagent-fallback routing, per Google's terms for the agy acp binary. Use a Gemini API key or Vertex AI for programmatic workloads.";
const LOCAL_MESSAGE = "The Antigravity CLI (ACP) provider requires a local connection to the proxy host. Hub links and connections classified as remote are refused. Use a Gemini API key or Vertex AI for shared or programmatic workloads.";

function isExplicitUserTurn(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const metadata = JSON.parse(value) as { request_kind?: unknown; thread_source?: unknown } | null;
    return metadata?.request_kind === "turn" && metadata.thread_source === "user";
  } catch {
    return false;
  }
}

/**
 * A turn Codex itself labels as unattended, without a parent-thread header: Codex's memory
 * pipeline (`x-openai-subagent: memory_consolidation`, `x-openai-memgen-request`, or memory turn
 * metadata in the header or the body copy) and a spawned thread (`isThreadSpawnRequest`).
 */
function isUnattendedCodexTurn({ headers, body, inboundTransport }: AgyAcpPolicySignals): boolean {
  if (inboundTransport !== "websocket"
    && (headers.get("x-openai-subagent") === "memory_consolidation" || headers.has("x-openai-memgen-request"))) return true;
  const client = body && typeof body === "object" && "client_metadata" in body ? body.client_metadata : undefined;
  const turn = client && typeof client === "object" && "x-codex-turn-metadata" in client
    ? client["x-codex-turn-metadata"] : undefined;
  if (isThreadSpawnTurnMetadata(turn)) return true;
  if (inboundTransport !== "websocket" && isThreadSpawnRequest(headers)) return true;
  if (inboundTransport === "websocket") {
    // collab_spawn describes the connection. Only explicit user provenance supersedes a
    // spawned-turn metadata snapshot from the upgrade; an unlabeled frame still refuses.
    if (headers.get("x-openai-subagent") === "collab_spawn"
      || (isThreadSpawnTurnMetadata(headers.get("x-codex-turn-metadata")) && !isExplicitUserTurn(turn))) return true;
  }
  // For a refusal, either turn-local copy can establish an unattended label on its own.
  if (inboundTransport !== "websocket" && detectMemoryModelPhase(undefined, headers) !== null) return true;
  return detectMemoryModelPhase(body, headers, { transport: "websocket" }) !== null;
}

/** The refusal for a turn this provider must not serve, or undefined when it may run. */
export function agyAcpPolicyRefusal(signals: AgyAcpPolicySignals): AgyAcpPolicyRefusal | undefined {
  if (signals.headers.has("x-codex-parent-thread-id") || signals.comboAttempt === true || signals.internalDecisionCall === true
    || signals.subagentFallback === true || isUnattendedCodexTurn(signals)) {
    return { status: 403, errorType: "permission_error", code: AGY_ACP_INTERACTIVE_ONLY, message: INTERACTIVE_MESSAGE };
  }
  const local = signals.local ?? currentRequestIsLocal();
  if (!local) return { status: 403, errorType: "permission_error", code: AGY_ACP_LOCAL_ONLY, message: LOCAL_MESSAGE };
  return undefined;
}
