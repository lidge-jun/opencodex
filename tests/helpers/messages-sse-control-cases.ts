import { SSE_SENTINEL, sseStart, sseDone, type MessagesSseCase } from "./messages-sse-cases";
export const messagesSseControlLanes = ["native", "builtin", "passthrough", "count-tokens"] as const;
export const messagesSseControlFields = [
  ["id", `id: ${SSE_SENTINEL}`],
  ["retry", `retry: ${SSE_SENTINEL}`],
  ["comment", `: ${SSE_SENTINEL}`],
  ["unknown", `extension: ${SSE_SENTINEL}`],
  ["second-event", `event: error\n: ${SSE_SENTINEL}`],
] as const;
export const messagesSseControlVariants = ["hidden", "empty", "recovery"] as const;
export function messagesSseControlCase(field: typeof messagesSseControlFields[number], variant: typeof messagesSseControlVariants[number]): MessagesSseCase {
  const data = variant === "empty" ? "" : JSON.stringify({ type: "error", error: { type: "api_error", message: variant === "recovery" ? "prompt is too long" : "hidden" } });
  return { id: `control-${field[0]}-${variant}`, kind: "error-block", chunks: ["event: error\n", field[1] + "\n", `data:${data}\n\n`] };
}
export const messagesSseControlRename: MessagesSseCase = { id: "control-rename", kind: "rename", chunks: [
  `event: error\nid: ${SSE_SENTINEL}\n: ${SSE_SENTINEL}\ndata: {"type":"error","error":{"type":"api_error","message":"hidden"}}\nevent: ping\n\n`, sseDone,
] };
export function messagesSseControlRenameBytes(lane: typeof messagesSseControlLanes[number]): string {
  const prefix = lane === "native" ? sseStart.replace('"model":"wire-model"', '"model":"fixture/wire-model"')
    : lane === "builtin" ? sseStart.replace('"model":"wire-model"', '"model":"anthropic/wire-model"') : "";
  return prefix + messagesSseControlRename.chunks.join("");
}
