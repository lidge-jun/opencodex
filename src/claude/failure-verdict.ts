import type { ReplayRefusalCode } from "../lib/upstream-retry";

type Rec = Record<string, unknown>;
/** Delivered projections and the original records consumed by one Messages collector. */
export interface MessagesFailureVerdictSink {
  delivered?: { client: string; legacy: Rec; replayRefusalCode?: ReplayRefusalCode; replayVetoStatus?: number }[];
  collected?: Rec;
  collectedProjection?: boolean;
  collectedErrorEvent?: true;
  /** The matched, admitted terminal selected this code's explicit retry veto. */
  collectedReplayRefusalCode?: ReplayRefusalCode;
  collectedReplayVetoStatus?: number;
}
export function admitMessagesFailure(sink: MessagesFailureVerdictSink | undefined, client: Rec, legacy: Rec, replayRefusalCode?: ReplayRefusalCode, replayVetoStatus?: number): void {
  if (sink) (sink.delivered ??= []).push({ client: JSON.stringify(client), legacy, replayRefusalCode, replayVetoStatus });
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
    sink.collectedReplayVetoStatus = next.replayVetoStatus;
  } else {
    sink.collected = client;
    sink.collectedProjection = false;
    sink.collectedReplayRefusalCode = undefined;
    sink.collectedReplayVetoStatus = undefined;
  }
}
