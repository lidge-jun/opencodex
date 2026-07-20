import type { OcxUsage } from "../../types";
import type { OcxMessage, OcxRequestOptions, OcxTool } from "../../types";

export interface CursorRunRequest {
  modelId: string;
  conversationId: string;
  system: string[];
  messages: CursorRequestMessage[];
  rawMessages?: OcxMessage[];
  tools?: OcxTool[];
  toolChoice?: OcxRequestOptions["toolChoice"];
  parallelToolCalls?: boolean;
  /** Wire-names of tools whose inputSchema was stubbed to stay under the byte budget. */
  stubbedToolNames?: ReadonlySet<string>;
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
  | { type: "exec"; execCase: string; requestId: string };

export type CursorClientMessage =
  | { type: "kv_value"; key: string; value?: Uint8Array }
  | { type: "kv_stored"; key: string }
  | { type: "exec_result"; requestId: string; ok: boolean; message: string };
