import { responseReplayOwnerKey } from "../../responses/state/replay-owner";
import { connectionReplayScopeForThread, connectionReplayScopeOwnerKey } from "../../responses/state/connection-scope";
import type { HandleResponsesOptions } from "./core-options";

/** Direct and combo ingress use the same credential-first, connection-local replay authority. */
export function selectResponseReplayOwner(
  strict: boolean,
  principal: string | undefined,
  ownThread: string | undefined,
  options: Pick<HandleResponsesOptions, "inboundTransport" | "admission" | "replayScope">,
) {
  const credentialOwnerKey = strict ? responseReplayOwnerKey(principal, ownThread) : undefined;
  const replayConnectionScope = credentialOwnerKey === null && options.inboundTransport === "websocket"
    && options.admission?.kind === "loopback"
    ? connectionReplayScopeForThread(options.replayScope, ownThread) : undefined;
  return {
    replayOwnerKey: strict ? credentialOwnerKey ?? connectionReplayScopeOwnerKey(replayConnectionScope) ?? null : undefined,
    replayConnectionScope,
  };
}
