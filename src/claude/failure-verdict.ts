type Rec = Record<string, unknown>;
/** Delivered projections and the original records consumed by one Messages collector. */
export interface MessagesFailureVerdictSink {
  delivered?: { client: string; legacy: Rec }[];
  collected?: Rec;
  collectedProjection?: boolean;
  collectedErrorEvent?: true;
}
export function admitMessagesFailure(sink: MessagesFailureVerdictSink | undefined, client: Rec, legacy: Rec): void {
  if (sink) (sink.delivered ??= []).push({ client: JSON.stringify(client), legacy });
}
export function collectMessagesFailure(sink: MessagesFailureVerdictSink | undefined, client: Rec): void {
  if (!sink) return;
  sink.collectedErrorEvent = true;
  const next = sink.delivered?.[0];
  if (next?.client === JSON.stringify(client)) {
    sink.delivered!.shift();
    sink.collected = next.legacy;
    sink.collectedProjection = true;
  } else { sink.collected = client; sink.collectedProjection = false; }
}
