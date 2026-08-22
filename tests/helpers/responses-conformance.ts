import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

/**
 * Shared harness for Responses tool round-trip conformance
 * (devlog/_plan/260813_routed_tool_discovery_profiles/030-034).
 *
 * Every existing tool test re-implements `replay`/`collectSse` locally, which is why the
 * streaming and non-streaming paths had never been compared: each test only looked at one.
 *
 * The streamed side is read from BOTH surfaces on purpose. `response.completed` is what a
 * client that reconnects or ignores deltas sees; `response.output_item.done` is what a client
 * consuming normal incremental frames sees. The bridge builds them separately, so reading only
 * the snapshot hides a whole divergence class — an item can be correct in the final snapshot
 * and wrong in the incremental frame. devlog 034 requires the incremental assertions.
 */

export async function* replay(events: readonly AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

export interface SseFrame {
  event?: string;
  data: Record<string, unknown>;
}

export async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

/** The tool-bearing fields every transport must agree on, in output order. */
export interface NormalizedToolItem {
  type: string;
  name?: string;
  call_id?: string;
  /** `arguments` for function/tool_search, `input` for custom. Objects are preserved. */
  payload?: unknown;
  status?: string;
  /** Namespace identity, when the restored item carries one. */
  namespace?: string;
}

function normalizeItem(item: Record<string, unknown>): NormalizedToolItem {
  const payload = item.arguments !== undefined ? item.arguments : item.input;
  return {
    type: String(item.type ?? ""),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(typeof item.status === "string" ? { status: item.status } : {}),
    ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
  };
}

const isToolItem = (item: Record<string, unknown>): boolean =>
  String(item.type ?? "").includes("call");

type BridgeMaps = [
  toolNsMap?: Map<string, { namespace: string; name: string; freeform?: true }>,
  freeformToolNames?: Set<string>,
  toolSearchToolNames?: Set<string>,
];

export interface StreamedView {
  /** Tool items from the terminal `response.completed` snapshot. */
  snapshot: NormalizedToolItem[];
  /** Tool items from the incremental `response.output_item.done` frames. */
  incremental: NormalizedToolItem[];
  /** Every frame's event name, in order. */
  eventNames: string[];
  /** Ordered payloads of every argument/input delta frame. */
  deltas: string[];
  /** Every non-call output item type from the snapshot, e.g. "message". */
  snapshotItemTypes: string[];
}

export async function streamedView(
  events: readonly AdapterEvent[],
  modelId: string,
  ...maps: BridgeMaps
): Promise<StreamedView> {
  const frames = await collectSse(bridgeToResponsesSSE(replay(events), modelId, ...maps));
  const completed = frames.find(frame => frame.event === "response.completed");
  const response = completed?.data.response as Record<string, unknown> | undefined;
  const output = Array.isArray(response?.output) ? response.output as Record<string, unknown>[] : [];

  const doneItems = frames
    .filter(frame => frame.event === "response.output_item.done")
    .map(frame => frame.data.item)
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object");

  return {
    snapshot: output.filter(isToolItem).map(normalizeItem),
    incremental: doneItems.filter(isToolItem).map(normalizeItem),
    eventNames: frames.map(frame => frame.event ?? ""),
    deltas: frames
      .filter(frame => frame.event?.endsWith(".delta") && typeof frame.data.delta === "string")
      .map(frame => String(frame.data.delta)),
    snapshotItemTypes: output.map(item => String(item.type ?? "")),
  };
}

/** Tool items from the non-streaming transport. */
export function jsonToolItems(
  events: readonly AdapterEvent[],
  modelId: string,
  options?: Parameters<typeof buildResponseJSON>[2],
): NormalizedToolItem[] {
  const body = buildResponseJSON([...events], modelId, options);
  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  return output.filter(isToolItem).map(normalizeItem);
}

/** Every output item type from the non-streaming transport, including non-call items. */
export function jsonItemTypes(
  events: readonly AdapterEvent[],
  modelId: string,
  options?: Parameters<typeof buildResponseJSON>[2],
): string[] {
  const body = buildResponseJSON([...events], modelId, options);
  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  return output.map(item => String(item.type ?? ""));
}
