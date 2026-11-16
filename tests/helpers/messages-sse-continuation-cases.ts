import { sseStart, type MessagesSseCase } from "./messages-sse-cases";
export const continuationLanes = ["native", "builtin", "passthrough", "count-tokens"] as const;
export const continuationTails = [
  ["ping", 'event: ping\ndata: {"type":"ping","sequence":1}\n\n'],
  ["terminal", 'event: message_stop\ndata: {"type":"message_stop"}\n\n'],
] as const;
export const splitCrError = 'event: error\r\ndata: {"type":"error","error":{"type":"api_error","message":"hidden"}}\r\n\r';
export const ownedCrError = 'event: error\r\ndata: {"type":"error","error":{"type":"api_error","message":"The provider failed to complete the request."}}\r\n\r\n';
export function continuationCase(tail: typeof continuationTails[number]): MessagesSseCase {
  return { id: `split-crlf-${tail[0]}`, kind: "error-block", chunks: [splitCrError, "\n", tail[1]] };
}
export function continuationExpected(lane: typeof continuationLanes[number], tail: typeof continuationTails[number]): string {
  const prefix = lane === "native" ? sseStart.replace('"model":"wire-model"', '"model":"fixture/wire-model"')
    : lane === "builtin" ? sseStart.replace('"model":"wire-model"', '"model":"anthropic/wire-model"') : "";
  return prefix + ownedCrError + tail[1];
}
