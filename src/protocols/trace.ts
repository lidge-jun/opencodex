/**
 * Observed protocol path for one request (PF-02).
 *
 * SERVER SIDE: the dashboard never imports this file; it reads the finished `ProtocolTraceV1`
 * through `dto.ts`. Marks live in WeakMaps keyed by the request log context and by the live
 * attempt objects, so neither `RequestLogContext` nor the persisted attempt row grows a field,
 * and a context that is never finalized takes its marks with it.
 *
 * Every function here is side-effect free apart from its own WeakMap and never throws into the
 * request path: a trace is diagnostics, and a request must not fail because its trace could not
 * be recorded. Nothing conversation-derived is kept — only fixed vocabulary.
 */
import {
  PROTOCOL_CONTRACT_VERSION,
  isProtocolReasonCode,
  upstreamWireForAdapter,
  type DeliveryMode,
  type Protocol,
  type ProtocolHop,
  type ProtocolReasonCode,
  type UpstreamWire,
} from "./contract";
import { PROTOCOL_DTO_LIMITS, PROTOCOL_TRACE_SCHEMA_VERSION, type ProtocolAttemptTraceV1, type ProtocolTraceV1 } from "./dto";
import { featureEffectsForPath, isProtocolFeature, type ProtocolFeature } from "./features";
import { deliveryModeForLane, requestPathForLane, responsePathForLane, type ProtocolLane } from "./path";

/** Features are computed inside the mark, so a thrown feature scan is contained there too. */
export type ProtocolFeatureSource = Iterable<ProtocolFeature> | (() => Iterable<ProtocolFeature>);

interface EntryMark {
  kind: "entry";
  inbound: Protocol;
  lane: ProtocolLane;
  reasonCodes: ProtocolReasonCode[];
  features: ProtocolFeature[];
}

interface BlockedMark {
  kind: "blocked";
  inbound: Protocol;
  reasonCodes: ProtocolReasonCode[];
  features: ProtocolFeature[];
}

interface AttemptMark {
  mode: Exclude<DeliveryMode, "blocked">;
  requestPath: ProtocolHop[];
  responsePath?: ProtocolHop[];
}

/** The attempt fields the trace reads. `PersistedUsageAttempt` satisfies it. */
export interface ProtocolTraceAttempt {
  ordinal: number;
  adapter: string;
}

const requestMarks = new WeakMap<object, EntryMark | BlockedMark>();
const attemptMarks = new WeakMap<object, AttemptMark>();

function boundedReasons(codes: Iterable<ProtocolReasonCode>): ProtocolReasonCode[] {
  const out: ProtocolReasonCode[] = [];
  for (const code of codes) {
    if (!isProtocolReasonCode(code) || out.includes(code)) continue;
    out.push(code);
    if (out.length >= PROTOCOL_DTO_LIMITS.reasonCodes) break;
  }
  return out;
}

function collectFeatures(source: ProtocolFeatureSource | undefined): ProtocolFeature[] {
  if (source === undefined) return [];
  const iterable = typeof source === "function" ? source() : source;
  const out: ProtocolFeature[] = [];
  for (const feature of iterable) {
    if (isProtocolFeature(feature) && !out.includes(feature)) out.push(feature);
    if (out.length >= PROTOCOL_DTO_LIMITS.featureEffects) break;
  }
  return out;
}

/**
 * Record which lane a Chat or Messages ingress chose. A later mark replaces an earlier one:
 * the last decision before the send is the one that describes it.
 */
export function markProtocolEntry(
  logCtx: object,
  mark: { inbound: Protocol; lane: ProtocolLane; reasonCodes?: Iterable<ProtocolReasonCode>; features?: ProtocolFeatureSource },
): void {
  try {
    requestMarks.set(logCtx, {
      kind: "entry",
      inbound: mark.inbound,
      lane: mark.lane,
      reasonCodes: boundedReasons(mark.reasonCodes ?? []),
      features: collectFeatures(mark.features),
    });
  } catch {
    /* a trace must never fail the request it describes */
  }
}

/** Record a refusal made before any upstream send. */
export function markProtocolBlocked(
  logCtx: object,
  mark: { inbound: Protocol; reasonCodes: Iterable<ProtocolReasonCode>; features?: ProtocolFeatureSource },
): void {
  try {
    requestMarks.set(logCtx, {
      kind: "blocked",
      inbound: mark.inbound,
      reasonCodes: boundedReasons(mark.reasonCodes),
      features: collectFeatures(mark.features),
    });
  } catch {
    /* a trace must never fail the request it describes */
  }
}

/**
 * Record the path one physical attempt actually took, overriding the lane-derived one. For a
 * send site that knows its path better than the ingress lane does.
 */
export function markAttemptProtocolPath(
  attempt: object,
  mark: { mode: Exclude<DeliveryMode, "blocked">; requestPath: readonly ProtocolHop[]; responsePath?: readonly ProtocolHop[] },
): void {
  try {
    if (mark.requestPath.length === 0 || mark.requestPath.length > PROTOCOL_DTO_LIMITS.pathHops) return;
    const responsePath = mark.responsePath && mark.responsePath.length > 0
      && mark.responsePath.length <= PROTOCOL_DTO_LIMITS.pathHops
      ? [...mark.responsePath]
      : undefined;
    attemptMarks.set(attempt, {
      mode: mark.mode,
      requestPath: [...mark.requestPath],
      ...(responsePath ? { responsePath } : {}),
    });
  } catch {
    /* a trace must never fail the request it describes */
  }
}

function isReverse(a: readonly ProtocolHop[], b: readonly ProtocolHop[]): boolean {
  return a.length === b.length && a.every((hop, index) => hop === b[b.length - 1 - index]);
}

interface ResolvedPath {
  upstream: UpstreamWire;
  mode: Exclude<DeliveryMode, "blocked">;
  requestPath: ProtocolHop[];
  responsePath: ProtocolHop[];
}

function pathFor(inbound: Protocol, lane: ProtocolLane, upstream: UpstreamWire): ResolvedPath {
  return {
    upstream,
    mode: deliveryModeForLane(inbound, lane, upstream),
    requestPath: requestPathForLane(inbound, lane, upstream),
    responsePath: responsePathForLane(inbound, lane, upstream),
  };
}

function attemptPath(inbound: Protocol, lane: ProtocolLane, attempt: ProtocolTraceAttempt): ResolvedPath {
  // A native Chat or Messages lane sends the ingress wire itself, whatever the adapter id says;
  // Responses has no lane and follows its adapter.
  const upstream = lane === "native" && inbound !== "responses" ? inbound : upstreamWireForAdapter(attempt.adapter);
  const derived = pathFor(inbound, lane, upstream);
  const mark = attemptMarks.get(attempt);
  if (!mark) return derived;
  return {
    upstream,
    mode: mark.mode,
    requestPath: [...mark.requestPath],
    responsePath: mark.responsePath ? [...mark.responsePath] : [...mark.requestPath].reverse(),
  };
}

/** A reason code the path itself implies, so a trace is never reason-less. */
function pathReason(path: ResolvedPath): ProtocolReasonCode {
  if (path.upstream === "other") return "upstream-other";
  if (path.mode === "native") return "same-wire-native";
  if (path.mode === "legacy-bridge") return "not-migrated";
  return path.requestPath.includes("ir") ? "cross-wire-ir" : "cross-wire-codec";
}

/**
 * Derive the observed trace at finalize. `attempts` are the live attempt objects (the ones
 * `markAttemptProtocolPath` was keyed by), not detached copies.
 *
 * - blocked mark: `blocked`, empty paths.
 * - Responses inbound without a mark: the final adapter's wire decides the path.
 * - Chat or Messages: the entry lane decides, through `path.ts`.
 * - no attempt and no native or blocked mark: `undefined`; nothing is guessed.
 */
export function protocolTraceForRequest(
  logCtx: object & { inboundProtocol?: Protocol },
  attempts: readonly ProtocolTraceAttempt[] | undefined,
): ProtocolTraceV1 | undefined {
  try {
    const mark = requestMarks.get(logCtx);
    if (mark?.kind === "blocked") {
      return {
        v: PROTOCOL_TRACE_SCHEMA_VERSION,
        inbound: mark.inbound,
        mode: "blocked",
        requestPath: [],
        responsePath: [],
        reasonCodes: mark.reasonCodes,
        contractVersion: PROTOCOL_CONTRACT_VERSION,
      };
    }
    let inbound: Protocol;
    let lane: ProtocolLane;
    if (mark) {
      inbound = mark.inbound;
      lane = mark.lane;
    } else if (logCtx.inboundProtocol === "responses") {
      inbound = "responses";
      lane = "native";
    } else {
      return undefined;
    }
    const live = (attempts ?? []).filter(attempt => Number.isInteger(attempt.ordinal) && attempt.ordinal > 0);
    const kept = live.slice(-PROTOCOL_DTO_LIMITS.attempts);
    const attemptPaths = kept.map(attempt => ({ attempt, path: attemptPath(inbound, lane, attempt) }));
    let final: ResolvedPath;
    const last = attemptPaths.at(-1);
    if (last) final = last.path;
    else if (mark && lane === "native") final = pathFor(inbound, lane, inbound);
    else return undefined;

    const reasonCodes = boundedReasons([...(mark?.reasonCodes ?? []), pathReason(final)]);
    const features = mark?.features ?? [];
    const effects = features.length > 0
      ? featureEffectsForPath(inbound, final.requestPath, features).effects.slice(0, PROTOCOL_DTO_LIMITS.featureEffects)
      : [];
    const attemptTraces: ProtocolAttemptTraceV1[] = attemptPaths.map(({ attempt, path }) => ({
      ordinal: attempt.ordinal,
      upstream: path.upstream,
      mode: path.mode,
      requestPath: path.requestPath,
      ...(isReverse(path.requestPath, path.responsePath) ? {} : { responsePath: path.responsePath }),
    }));
    return {
      v: PROTOCOL_TRACE_SCHEMA_VERSION,
      inbound,
      mode: final.mode,
      upstream: final.upstream,
      requestPath: final.requestPath,
      responsePath: final.responsePath,
      reasonCodes,
      ...(effects.length > 0 ? { featureEffects: effects.map(effect => ({ ...effect })) } : {}),
      ...(attemptTraces.length > 0 ? { attempts: attemptTraces } : {}),
      contractVersion: PROTOCOL_CONTRACT_VERSION,
    };
  } catch {
    return undefined;
  }
}
