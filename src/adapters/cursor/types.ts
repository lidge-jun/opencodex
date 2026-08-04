import type { OcxUsage } from "../../types";
import type { OcxMessage, OcxRequestOptions, OcxTool } from "../../types";
import type { CursorRoutingLevel } from "./discovery";

export interface CursorRunRequest {
  modelId: string;
  /** Cursor Router optimization parameter; valid only while modelId is the `default` wire model. */
  routingLevel?: CursorRoutingLevel;
  conversationId: string;
  system: string[];
  messages: CursorRequestMessage[];
  rawMessages?: OcxMessage[];
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
