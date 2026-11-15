import { handleResponses } from "../../src/server/responses";
import { expandPreviousResponseInput, rememberResponseState } from "../../src/responses/state";
import { responseReplayOwnerKey } from "../../src/responses/state/replay-owner";
import { contextPrincipalIdOf, resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";

const key = "synthetic-response-replay-owner";
const thread = "synthetic-response-replay-thread";
const apiKeys = [{ id: "replay-fixture", key }];
export const responseReplayFixtureApiKeys = apiKeys;
export function responseReplayFixtureHeaders(ownThread = thread) {
  return { "x-opencodex-api-key": key, "thread-id": ownThread };
}

/** Direct-handler fixtures take the same configured admission that ingress would resolve. */
export function handleOwnedResponses(...[req, config, log, options]: Parameters<typeof handleResponses>) {
  const admittedConfig = { ...config, apiKeys };
  req.headers.set("x-opencodex-api-key", key);
  if (!req.headers.has("thread-id")) req.headers.set("thread-id", thread);
  const admission = resolveDataPlaneAdmissionSecret(key, admittedConfig)!;
  return handleResponses(req, admittedConfig, log, { ...options, admission });
}

export function expandOwnedResponseInput(body: unknown): unknown {
  const scope = ownedResponseStateOptions();
  return expandPreviousResponseInput(body, scope.clientThreadId, scope.replayOwnerKey);
}

export function ownedResponseStateOptions(ownThread = thread) {
  const admission = resolveDataPlaneAdmissionSecret(key, { apiKeys });
  return { clientThreadId: ownThread, replayOwnerKey: responseReplayOwnerKey(contextPrincipalIdOf(admission ?? undefined), ownThread) };
}

export function rememberOwnedResponseState(...[request, response, provider, options]: Parameters<typeof rememberResponseState>): void {
  rememberResponseState(request, response, provider, { ...options, ...ownedResponseStateOptions(options?.clientThreadId) });
}
