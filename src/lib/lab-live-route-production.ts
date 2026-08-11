/**
 * Production host integration for CL-03 trusted exact-route execution.
 *
 * Issues a host-recognized `TrustedLabRouteExecutor` that routes provider traffic
 * through the CL-03 credential lease, pinned transport, and observation normalization
 * pipeline. Secret material stays outside Lab modules.
 *
 * @internal host integration only
 */
import { resolveEnvValue } from "../config";
import {
  getValidAccessTokenSnapshot,
  OAuthLoginRequiredError,
  UnsupportedOAuthProviderError,
} from "../oauth";
import type { OcxConfig } from "../types";
import { createCredentialLease } from "../lab/live/credential-lease";
import {
  liveUpstreamRequestPath,
  normalizeLabLiveTransportObservation,
} from "../lab/live/executor";
import { createPinnedTransport } from "../lab/live/transport";
import { TransportError } from "../lab/live/transport";
import type { LabRouteContext } from "../lab/live/types";
import { createLabAuthorizedPinnedSender } from "./lab-live-pinned-sender";
import { createHostIssuedLabRouteExecutor } from "./lab-live-host";
import type { TrustedLabRouteExecutor } from "../lab/live/types";

const CREDENTIAL_HEADER = /(authorization|api[-_]?key|token|secret|credential|cookie)/i;

export interface ProductionLabRouteExecutorDeps {
  configDir?: string;
  loadConfig: () => OcxConfig;
}

async function buildLabProviderAuthHeaders(
  routeContext: LabRouteContext,
  config: OcxConfig,
): Promise<Record<string, string>> {
  const provider = config.providers?.[routeContext.providerId];
  if (!provider || provider.disabled === true) {
    throw new TransportError("auth_blocked", "provider unavailable");
  }
  if (provider.authMode === "forward") {
    throw new TransportError("auth_blocked", "forward auth unsupported for lab probes");
  }
  if (provider.authMode === "local") {
    throw new TransportError("auth_blocked", "local provider unsupported for lab probes");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (provider.authMode === "oauth") {
    let protocol: string;
    try {
      protocol = new URL(routeContext.baseUrl).protocol;
    } catch {
      throw new TransportError("auth_blocked", "invalid OAuth provider destination");
    }
    if (protocol !== "https:") {
      throw new TransportError("auth_blocked", "OAuth lab probes require HTTPS");
    }
    try {
      const snapshot = await getValidAccessTokenSnapshot(routeContext.providerId);
      headers.Authorization = `Bearer ${snapshot.accessToken}`;
    } catch (error) {
      if (error instanceof OAuthLoginRequiredError || error instanceof UnsupportedOAuthProviderError) {
        throw new TransportError("auth_blocked", "oauth unavailable");
      }
      // Non-terminal refresh failures (network, lock contention, provider transient errors)
      // are harness/infrastructure failures rather than evidence that credentials are invalid.
      throw new TransportError("harness_failure", "oauth refresh unavailable");
    }
  } else {
    const apiKey = resolveEnvValue(provider.apiKey)?.trim();
    if (!apiKey) throw new TransportError("auth_blocked", "missing api key");
    if (provider.adapter === "anthropic" && provider.apiKeyTransport === "x-api-key") {
      headers["x-api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  if (provider.headers) {
    for (const [name, value] of Object.entries(provider.headers)) {
      if (CREDENTIAL_HEADER.test(name)) continue;
      const resolved = resolveEnvValue(value);
      headers[name] = typeof resolved === "string" ? resolved : value;
    }
  }

  return headers;
}

/** Create the process-local trusted CL-03 route executor for Lab automation dispatch. */
export function createProductionLabRouteExecutor(
  deps: ProductionLabRouteExecutorDeps,
): TrustedLabRouteExecutor {
  return createHostIssuedLabRouteExecutor(async (input) => {
    if (!input.initiatingRequest) {
      throw new TransportError("harness_failure", "live scenario missing initiating request");
    }
    const config = deps.loadConfig();
    const lease = createCredentialLease({
      destination: input.destination,
      transportId: "lab-automation",
      budget: input.limits.maxRequests,
    });
    const authHeaders = await buildLabProviderAuthHeaders(input.routeContext, config);
    const sender = createLabAuthorizedPinnedSender(async () => authHeaders);
    const transport = createPinnedTransport({
      destination: input.destination,
      lease,
      sender,
      limits: input.limits,
      transportId: "lab-automation",
    });
    const path = liveUpstreamRequestPath(input.routeContext.upstreamProtocol);
    const response = await transport.request({
      method: "POST",
      path,
      body: input.initiatingRequest,
      signal: input.signal,
    });
    return normalizeLabLiveTransportObservation(input.routeContext, response);
  });
}
