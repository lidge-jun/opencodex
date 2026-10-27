import { TurnTokenCodec } from "../../responses/turn-membership";
import { resolveDurableReplayPrincipal, type DataPlaneAdmission } from "../auth-cors";
import { reasoningReplayConversationIdFromResponsesRequest } from "../request-log-conversation";
import type { OcxConfig } from "../../types";

/** Explicit embedding-shell opt-in. No disk, timers, secret recovery, or implicit key generation. */
export function responseTurnMembership(
  req: Request,
  config: Pick<OcxConfig, "apiKeys">,
  admission: DataPlaneAdmission | undefined,
  material = process.env.OPENCODEX_RESPONSE_TURN_SIGNING_KEY,
) {
  if (!material || !/^dr_turn_v1_[A-Za-z0-9_-]{43}$/.test(material)) return undefined;
  const encoded = material.slice("dr_turn_v1_".length);
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) return undefined;
  const principal = resolveDurableReplayPrincipal(req, config, admission, key);
  if (!principal) return undefined;
  // Only the request's own thread identifies this chat. Parents and session/cache cohorts include siblings.
  const thread = reasoningReplayConversationIdFromResponsesRequest({
    threadIdHeader: req.headers.get("thread-id"),
  });
  if (!thread) return undefined;
  const scope = { principal, thread };
  const codec = new TurnTokenCodec(new Map([["k1", key]]), "k1");
  return {
    begin: () => codec.begin(scope),
    normalize: (input: unknown[]) => codec.normalize(scope, input),
  };
}
