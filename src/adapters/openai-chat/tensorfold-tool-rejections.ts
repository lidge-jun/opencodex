import * as z from "zod/v4";
import type { AdapterEvent, OcxUsage } from "../../types";

const diagnosticSchema = z.object({
  tensorfold: z.object({
    tool_call_rejections: z.array(z.object({ reason: z.literal("unknown_tool_name"), name: z.string().min(1) })).min(1).max(128),
  }),
});

/** Consume TensorFold's explicit rejection signal without interpreting answer text as a call. */
export function tensorfoldToolRejectionEvent(
  payload: unknown,
  toolsEnabled: boolean,
  usage?: OcxUsage,
): Extract<AdapterEvent, { type: "error" }> | undefined {
  if (!toolsEnabled || !diagnosticSchema.safeParse(payload).success) return undefined;
  return {
    type: "error", status: 502, errorType: "upstream_error", code: "upstream_tool_call_rejected",
    message: "TensorFold rejected one or more tool calls because their names were not offered by this request.",
    retryable: false, usage,
  };
}
