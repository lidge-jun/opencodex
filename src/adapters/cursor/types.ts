import type { OcxUsage } from "../../types";
import type { OcxMessage, OcxRequestOptions, OcxTool } from "../../types";
import type { CursorRoutingLevel } from "./discovery";
import type { CursorCheckpointInvalidationReason } from "./checkpoint-store";
import type { ResolvedCursorImage } from "./images";

export interface CursorRequestedModelParameter {
  id: string;
  value: string;
}

export interface CursorRunRequest {
  modelId: string;
  /** Cursor model-picker parameters encoded through AgentRunRequest.requested_model. */
  requestedModelParameters?: readonly CursorRequestedModelParameter[];
  /** Cursor Router optimization parameter; valid only while modelId is the `default` wire model. */
  routingLevel?: CursorRoutingLevel;
  /**
   * Cursor Max Mode (ultra/big-context). Set from a synthetic `-1m` picker variant; the wire
   * keeps the original model id and raises RequestedModel.maxMode + ModelDetails.maxMode
   * (both fields — missing either can invalid_argument upstream). Devlog 260826 070.
   */
  maxMode?: boolean;
  /**
   * Bare API callers (no caller tools, no Codex thread identity) pay a ~10-15K input-token
   * preamble because an absent AgentRunRequest.mcp_tools field makes Cursor inject its default
   * native tool catalog. When true, an explicitly empty McpTools wrapper is serialized instead,
   * suppressing that default. Codex-identified sessions keep the absent-field behavior.
   */
  suppressDefaultCursorToolCatalog?: boolean;
  /**
   * Corrective active-turn text for the single envelope-echo retry (devlog 260826 gap-10).
   * When set on an external tool-result continuation, buildPreparedCursorRunRequest uses it as
   * the userMessageAction prefix instead of the standard continuation text; rawMessages stay
   * untouched so history replay is unchanged.
   */
  echoRetryContinuationText?: string;
  conversationId: string;
  system: string[];
  messages: CursorRequestMessage[];
  rawMessages?: readonly OcxMessage[];
  /**
   * Images for the active user/developer turn or an external model's trailing tool-result run.
   * Encoded as SelectedImage blobIdWithData refs under
   * UserMessage.selected_context (bytes live in the request-scoped KV store for getBlobArgs
   * hydration). Bounded sourceLabel metadata from tool images is appended to the active action,
   * outside prunable history; it is not a new image wire field. Native Composer selection stays
   * unchanged. History stays text-only. data: URLs only in this slice.
   */
  selectedImages?: readonly ResolvedCursorImage[];
  tools?: OcxTool[];
  toolChoice?: OcxRequestOptions["toolChoice"];
  parallelToolCalls?: boolean;
  /**
   * Clear provider-private context-usage carry-forward before this run. Used when Codex starts a
   * newly observed compacted context epoch, so pre-compaction totals are not over-reported while
   * historical previous_response_id replay remains idempotent.
   */
  contextUsageReset?: boolean;
  /**
   * Defaults to true. Set false for compaction summarizer turns: their checkpoints describe the
   * pre-compaction history being summarized and must not become the next turn's carry-forward total.
   */
  contextUsageStoreCheckpoints?: boolean;
  /**
   * Reuse a previously captured ConversationStateStructure instead of rebuilding historical
   * root/turn blobs. Absent means the existing full-replay path.
   */
  checkpointBytes?: Uint8Array;
  continuationMode?: "full-replay" | "checkpoint";
  checkpointInvalidationReason?: CursorCheckpointInvalidationReason;
  /**
   * When set with checkpointBytes, only this suffix of rawMessages is replayed onto the
   * decoded ConversationStateStructure. Used for tool-result continuations.
   */
  checkpointSuffixStart?: number;
}

export interface CursorRequestMessage {
  role: "user" | "assistant" | "developer" | "tool";
  content: string;
}

export type CursorServerMessage =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end"; id?: string }
  | { type: "done"; usage?: OcxUsage }
  | { type: "error"; message: string; usage?: OcxUsage }
  | { type: "heartbeat" }
  | { type: "kv_get"; key: string }
  | { type: "kv_set"; key: string; value: Uint8Array }
  | { type: "exec"; execCase: string; requestId: string }
  /** A native exec/MCP action ran locally; retrying this turn could duplicate its side effects. */
  | { type: "local_side_effect" };

export type CursorClientMessage =
  | { type: "kv_value"; key: string; value?: Uint8Array }
  | { type: "kv_stored"; key: string }
  | { type: "exec_result"; requestId: string; ok: boolean; message: string };
