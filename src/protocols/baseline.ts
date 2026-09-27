/**
 * The 3 ingress × 3 upstream × stream baseline: the path each combination takes in the
 * current code for an eligible single-provider route, and the path the protocol-first-class
 * work targets.
 *
 * LEAF MODULE (see `contract.ts`). `current` is a claim about today's code and must change in
 * the same commit that changes the code it describes; `target` changes only with the plan in
 * `devlog/_plan/260924_protocol_first_class/`. Combos, policy routes, OAuth credentials and
 * Responses-only features are not "eligible single-provider routes" and are described by the
 * planner, not by this table.
 */
import { deliveryModeForPath, PROTOCOLS, type DeliveryMode, type Protocol, type ProtocolHop } from "./contract";

/** How the client receives the result. `sse-folded` = streamed internally, folded to JSON. */
export type ResponseShape = "sse" | "json" | "sse-folded";

export interface BaselinePath {
  mode: Exclude<DeliveryMode, "blocked">;
  requestPath: readonly ProtocolHop[];
  /** Upstream first, client last. */
  responsePath: readonly ProtocolHop[];
  responseShape: ResponseShape;
}

export interface BaselineCell {
  inbound: Protocol;
  upstream: Protocol;
  stream: boolean;
  current: BaselinePath;
  target: BaselinePath;
}

function path(requestPath: readonly ProtocolHop[], stream: boolean, folded: boolean): BaselinePath {
  const responsePath = [...requestPath].reverse();
  return {
    mode: deliveryModeForPath(requestPath),
    requestPath,
    responsePath,
    responseShape: stream ? "sse" : folded ? "sse-folded" : "json",
  };
}

/** Current request path for an eligible single-provider route. */
function currentRequestPath(inbound: Protocol, upstream: Protocol): readonly ProtocolHop[] {
  if (inbound === upstream) {
    // Native Messages exists today only for caller-forwarded Anthropic credentials; a
    // proxy-managed Anthropic key still replays through Responses.
    return inbound === "messages" ? ["messages", "responses-internal", "ir", "messages"] : [inbound, upstream];
  }
  if (inbound === "responses") return ["responses", "ir", upstream];
  // Chat and Messages reach a Responses upstream through their Responses codec directly.
  if (upstream === "responses") return [inbound, "responses"];
  return [inbound, "responses-internal", "ir", upstream];
}

function targetRequestPath(inbound: Protocol, upstream: Protocol): readonly ProtocolHop[] {
  if (inbound === upstream) return [inbound, upstream];
  if (inbound !== "responses" && upstream === "responses") return [inbound, "responses"];
  return [inbound, "ir", upstream];
}

/**
 * Whether the current non-stream client response is folded from an internal stream. Every
 * routed (non-native) path streams internally; native Chat and Responses passthrough honour
 * the caller's stream bit.
 */
function currentFolds(inbound: Protocol, upstream: Protocol): boolean {
  if (inbound === "responses") return false;
  return !(inbound === "chat" && upstream === "chat");
}

export const BASELINE_MATRIX: readonly BaselineCell[] = PROTOCOLS.flatMap(inbound =>
  PROTOCOLS.flatMap(upstream =>
    [false, true].map((stream): BaselineCell => ({
      inbound,
      upstream,
      stream,
      current: path(currentRequestPath(inbound, upstream), stream, currentFolds(inbound, upstream)),
      target: path(targetRequestPath(inbound, upstream), stream, false),
    })),
  ),
);

export function baselineCell(inbound: Protocol, upstream: Protocol, stream: boolean): BaselineCell {
  const cell = BASELINE_MATRIX.find(row => row.inbound === inbound && row.upstream === upstream && row.stream === stream);
  if (!cell) throw new RangeError(`no baseline cell for ${inbound}>${upstream}/${stream}`);
  return cell;
}
