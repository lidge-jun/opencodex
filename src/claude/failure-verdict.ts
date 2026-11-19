import type { ReplayRefusalCode } from "../lib/upstream-retry";

type Rec = Record<string, unknown>;
/** Delivered projections and the original records consumed by one Messages collector. */
export interface MessagesFailureVerdictSink {
  delivered?: { client: string; legacy: Rec; replayRefusalCode?: ReplayRefusalCode }[];
  collected?: Rec;
  collectedProjection?: boolean;
  collectedErrorEvent?: true;
  /** The matched Responses terminal paired this code with an explicit retry veto. */
  collectedReplayRefusalCode?: ReplayRefusalCode;
}
export function admitMessagesFailure(sink: MessagesFailureVerdictSink | undefined, client: Rec, legacy: Rec, replayRefusalCode?: ReplayRefusalCode): void {
  if (sink) (sink.delivered ??= []).push({ client: JSON.stringify(client), legacy, replayRefusalCode });
}
export function collectMessagesFailure(sink: MessagesFailureVerdictSink | undefined, client: Rec): void {
  if (!sink) return;
  sink.collectedErrorEvent = true;
  const next = sink.delivered?.[0];
  if (next?.client === JSON.stringify(client)) {
    sink.delivered!.shift();
    sink.collected = next.legacy;
    sink.collectedProjection = true;
    sink.collectedReplayRefusalCode = next.replayRefusalCode;
  } else {
    sink.collected = client;
    sink.collectedProjection = false;
    sink.collectedReplayRefusalCode = undefined;
  }
}
