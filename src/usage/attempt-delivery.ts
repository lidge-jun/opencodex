/**
 * Counting what an attempt delivered, without recording what it said.
 *
 * The recorder below is bound to a request-scoped object and reaches the CURRENT attempt through
 * a callback rather than holding one. An attempt can be rotated mid-request -- a key-account
 * change seals the old one and starts a fresh one -- and a recorder holding a reference would
 * keep crediting frames to an attempt that had already been finalized and snapshotted.
 *
 * Nothing here reads a payload's content. `semanticBytes` is a length; the event classification
 * reads only a frame's type name and an item's type name, both of which are protocol constants.
 */
import type { AttemptDeliverySummary } from "./telemetry-contract";

export interface AttemptDeliveryTarget {
  deliverySummary?: AttemptDeliverySummary;
}

export interface RelayedEventObservation {
  semanticBytes?: number;
  sideEffect?: boolean;
  terminal?: boolean;
}

export interface AttemptDeliveryRecorder {
  noteAdapterEvent(): void;
  noteRelayedEvent(observation?: RelayedEventObservation): void;
}

export function createAttemptDeliverySummary(): AttemptDeliverySummary {
  return { adapterEvents: 0, relayedEvents: 0, semanticBytes: 0, sideEffectEvents: 0, terminalEvents: 0 };
}

/**
 * Saturating addition.
 *
 * A counter that wraps or drifts into a non-integer is worse than one that stops: the row would
 * be dropped by the normalizer and the whole summary lost. A long-lived stream that somehow
 * reaches the safe-integer ceiling keeps a readable, if pinned, number.
 */
function bump(current: number, by: number): number {
  if (!Number.isFinite(by) || by <= 0) return current;
  return Math.min(Number.MAX_SAFE_INTEGER, current + Math.floor(by));
}

const SEMANTIC_DELTA_EVENTS: ReadonlySet<string> = new Set([
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

const SIDE_EFFECT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "custom_tool_call",
  "web_search_call",
]);

/**
 * What one relayed frame contributes, read from its type name alone.
 *
 * A side effect is counted when the item STARTS, not on its argument fragments and not again on
 * the matching done frame, so one tool call is one effect however many deltas carried its
 * arguments.
 */
export function classifyRelayedResponseEvent(
  name: string,
  data: Record<string, unknown>,
): RelayedEventObservation {
  const observation: RelayedEventObservation = {};
  if (SEMANTIC_DELTA_EVENTS.has(name) && typeof data.delta === "string") {
    observation.semanticBytes = Buffer.byteLength(data.delta, "utf8");
  }
  if (name === "response.output_item.added") {
    const item = data.item;
    const type = item !== null && typeof item === "object"
      ? (item as Record<string, unknown>).type
      : undefined;
    if (typeof type === "string" && SIDE_EFFECT_ITEM_TYPES.has(type)) observation.sideEffect = true;
  }
  if (TERMINAL_EVENTS.has(name)) observation.terminal = true;
  return observation;
}

const recordersByScope = new WeakMap<object, AttemptDeliveryRecorder>();

/**
 * Bind a recorder to a request-scoped object.
 *
 * The scope is the request's translator budget, which every bridge on the delivery path already
 * receives. Reusing it avoids threading a new parameter through six call sites where any one of
 * them silently defaulting would leave a transport uncounted -- the failure mode that made
 * `locallyAnswered` travel on the attempt instead of as an argument.
 */
export function bindAttemptDeliveryRecorder(
  scope: object,
  currentAttempt: () => AttemptDeliveryTarget | undefined,
): AttemptDeliveryRecorder {
  const summaryFor = (): AttemptDeliverySummary | undefined => {
    const attempt = currentAttempt();
    if (!attempt) return undefined;
    return attempt.deliverySummary ??= createAttemptDeliverySummary();
  };
  const recorder: AttemptDeliveryRecorder = {
    noteAdapterEvent(): void {
      const summary = summaryFor();
      if (summary) summary.adapterEvents = bump(summary.adapterEvents, 1);
    },
    noteRelayedEvent(observation): void {
      const summary = summaryFor();
      if (!summary) return;
      summary.relayedEvents = bump(summary.relayedEvents, 1);
      if (observation?.semanticBytes) summary.semanticBytes = bump(summary.semanticBytes, observation.semanticBytes);
      if (observation?.sideEffect) summary.sideEffectEvents = bump(summary.sideEffectEvents, 1);
      if (observation?.terminal) summary.terminalEvents = bump(summary.terminalEvents, 1);
    },
  };
  recordersByScope.set(scope, recorder);
  return recorder;
}

export function attemptDeliveryRecorder(scope: object | undefined): AttemptDeliveryRecorder | undefined {
  return scope ? recordersByScope.get(scope) : undefined;
}

/**
 * A persisted summary is trusted only when all five counts are non-negative safe integers.
 *
 * The whole record is dropped rather than repaired: a partially trusted count is a number an
 * operator would compare against another number, and half a summary is how a loss signal turns
 * into a false one.
 */
export function normalizeAttemptDeliverySummary(value: unknown): AttemptDeliverySummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const counts = createAttemptDeliverySummary();
  for (const key of Object.keys(counts) as Array<keyof AttemptDeliverySummary>) {
    const count = raw[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
    counts[key] = count;
  }
  return counts;
}

/** A detached copy, so a snapshotted attempt cannot keep counting after it was finalized. */
export function cloneAttemptDeliverySummary(
  summary: AttemptDeliverySummary | undefined,
): AttemptDeliverySummary | undefined {
  return summary ? { ...summary } : undefined;
}
