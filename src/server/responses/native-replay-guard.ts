/**
 * The replay judgment a native passthrough request carries into every one of its sends.
 *
 * Two questions are answered together, because they share the same answer: may this request be
 * sent a second time at all, and did the attempt that physically left stay inside that judgment?
 * The inbound body is judged ONCE -- it does not change between legs, and every rebuild this lane
 * performs only ever removes a hazard -- while the physical guard is asked on every call, because
 * a rebuild queued behind a claimed replacement grant can reintroduce a hazard the inbound body
 * never had.
 *
 * The physical guard also carries the grant: `authorize` marks the next physical send as the
 * replacement a caller just bought, and `send` clears that mark whatever happens to it. A refused
 * rebuild or an exhausted send budget must not leave the next ordinary send judged as one.
 */
import type { AdapterRequest } from "../../adapters/base";
import {
  createPhysicalReplayGuard, nativePassthroughReplayJudgmentBody, selfContainedResponsesBody,
} from "./reset-replay";

export interface NativeReplayGuardOptions {
  /** Whether the destination the request is dialled against executes tools on the origin. */
  providerExecuted: () => boolean;
  /** The parsed inbound body the judgment is made on. */
  parsed: Parameters<typeof nativePassthroughReplayJudgmentBody>[0];
  /**
   * The outbound request, read per send: the recovery loop reassigns it as adapters rebuild.
   * Received as a thunk rather than a value for exactly that reason.
   */
  currentRequest: () => AdapterRequest;
}

export interface NativeReplayGuard {
  /** Whether this request, and the body about to leave, may be replayed. */
  isSelfContained: () => boolean;
  /** Mark the one physical send a recovery grant just bought. */
  authorize: () => void;
  /** The `onPhysicalDispatch` handler for a send of the current request. */
  sendHandler: (next?: () => void) => (body?: BodyInit | null) => void;
  /** Record a send whose request the caller already holds (a retry with a rebuilt request). */
  record: (request: AdapterRequest, body: BodyInit | null | undefined) => void;
}

export function createNativeReplayGuard(options: NativeReplayGuardOptions): NativeReplayGuard {
  const physical = createPhysicalReplayGuard(options.providerExecuted);
  // Judged once: walking the input array is not something a provider that never opted in should
  // pay for on every leg, and the inbound body cannot change mid-request.
  let selfContained: boolean | undefined;
  return {
    isSelfContained: (): boolean =>
      (selfContained ??= selfContainedResponsesBody(nativePassthroughReplayJudgmentBody(options.parsed)))
      && physical.isSelfContained(options.currentRequest()),
    authorize: () => physical.authorize(),
    sendHandler: (next?: () => void) => (body?: BodyInit | null): void =>
      physical.record(options.currentRequest(), body, next),
    record: (request: AdapterRequest, body: BodyInit | null | undefined) => physical.record(request, body),
  };
}
