import { providerOutboundGet, providerRedirectError } from "../../lib/provider-outbound";
import { extractProviderModelItems, readBoundedDiscoveryJson } from "../model-discovery";
import type { OcxProviderConfig } from "../../types";
import {
  REPLIT_MODELS_MAX_MODELS,
  REPLIT_MODELS_MAX_RESPONSE_BYTES,
  REPLIT_OPENAI_PROVIDER_ID,
  REPLIT_PROBE_TIMEOUT_MS,
} from "./constants";
import type { ValidatedReplitOrigin } from "./origin";

type ProbeProviderConfig = Pick<OcxProviderConfig, "baseUrl"> & {
  adapter: string;
  fetch?: typeof globalThis.fetch;
};

export interface ReplitGatewayProbeSuccess {
  ok: true;
  healthz: { status: number; latencyMs: number };
  models: { status: number; modelCount: number; latencyMs: number };
}

export interface ReplitGatewayProbeFailure {
  ok: false;
  stage: "healthz" | "models";
  category?: "redirect_rejected" | "upstream_error" | "timeout" | "internal";
  error: string;
  latencyMs: number;
}

export type ReplitGatewayProbeResult = ReplitGatewayProbeSuccess | ReplitGatewayProbeFailure;

export interface ReplitGatewayProbeDeps {
  fetch?: typeof globalThis.fetch;
}

function probeProviderStub(origin: ValidatedReplitOrigin): ProbeProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: origin,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort release for non-conforming response streams.
  }
}

async function probeGet(
  providerName: string,
  origin: ValidatedReplitOrigin,
  url: string,
  init: RequestInit = {},
  deps: ReplitGatewayProbeDeps = {},
): Promise<Response> {
  const provider = probeProviderStub(origin);
  if (deps.fetch) {
    provider.fetch = deps.fetch;
  }
  return providerOutboundGet(providerName, provider, url, {
    ...init,
    signal: AbortSignal.timeout(REPLIT_PROBE_TIMEOUT_MS),
  });
}

export function buildReplitGatewayProbeRequests(origin: ValidatedReplitOrigin, gatewayKey: string): {
  healthz: { url: string; init?: RequestInit };
  models: { url: string; init: RequestInit };
} {
  return {
    healthz: { url: `${origin}/healthz` },
    models: {
      url: `${origin}/v1/models`,
      init: {
        headers: { Authorization: `Bearer ${gatewayKey}` },
      },
    },
  };
}

export async function probeReplitGateway(
  origin: ValidatedReplitOrigin,
  gatewayKey: string,
  deps: ReplitGatewayProbeDeps = {},
): Promise<ReplitGatewayProbeResult> {
  const requests = buildReplitGatewayProbeRequests(origin, gatewayKey);

  const healthzStarted = Date.now();
  let healthzResponse: Response;
  try {
    healthzResponse = await probeGet(REPLIT_OPENAI_PROVIDER_ID, origin, requests.healthz.url, requests.healthz.init ?? {}, deps);
  } catch (error) {
    return {
      ok: false,
      stage: "healthz",
      category: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "internal",
      error: error instanceof Error ? error.message : "healthz probe failed",
      latencyMs: Date.now() - healthzStarted,
    };
  }
  const healthzLatencyMs = Date.now() - healthzStarted;
  const healthzRedirect = await providerRedirectError(healthzResponse, requests.healthz.url);
  if (healthzRedirect) {
    return {
      ok: false,
      stage: "healthz",
      category: "redirect_rejected",
      error: healthzRedirect,
      latencyMs: healthzLatencyMs,
    };
  }
  if (!healthzResponse.ok) {
    await cancelResponseBody(healthzResponse);
    return {
      ok: false,
      stage: "healthz",
      category: "upstream_error",
      error: `healthz returned ${healthzResponse.status}`,
      latencyMs: healthzLatencyMs,
    };
  }
  await cancelResponseBody(healthzResponse);

  const modelsStarted = Date.now();
  let modelsResponse: Response;
  try {
    modelsResponse = await probeGet(REPLIT_OPENAI_PROVIDER_ID, origin, requests.models.url, requests.models.init, deps);
  } catch (error) {
    return {
      ok: false,
      stage: "models",
      category: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "internal",
      error: error instanceof Error ? error.message : "models probe failed",
      latencyMs: Date.now() - modelsStarted,
    };
  }
  const modelsLatencyMs = Date.now() - modelsStarted;
  const modelsRedirect = await providerRedirectError(modelsResponse, requests.models.url);
  if (modelsRedirect) {
    return {
      ok: false,
      stage: "models",
      category: "redirect_rejected",
      error: modelsRedirect,
      latencyMs: modelsLatencyMs,
    };
  }
  if (!modelsResponse.ok) {
    await cancelResponseBody(modelsResponse);
    return {
      ok: false,
      stage: "models",
      category: "upstream_error",
      error: `/v1/models returned ${modelsResponse.status}`,
      latencyMs: modelsLatencyMs,
    };
  }

  const bounded = await readBoundedDiscoveryJson(modelsResponse, REPLIT_MODELS_MAX_RESPONSE_BYTES);
  if (!bounded.ok) {
    return {
      ok: false,
      stage: "models",
      category: "upstream_error",
      error: bounded.reason === "response_too_large"
        ? `/v1/models exceeded the ${REPLIT_MODELS_MAX_RESPONSE_BYTES}-byte response limit`
        : "/v1/models returned invalid JSON",
      latencyMs: modelsLatencyMs,
    };
  }
  const extracted = extractProviderModelItems(bounded.value, {
    maxResponseBytes: REPLIT_MODELS_MAX_RESPONSE_BYTES,
    maxModels: REPLIT_MODELS_MAX_MODELS,
  });
  if (!extracted.ok) {
    return {
      ok: false,
      stage: "models",
      category: "upstream_error",
      error: extracted.reason === "too_many_models"
        ? `/v1/models exceeded the ${REPLIT_MODELS_MAX_MODELS}-row model limit`
        : "/v1/models returned an unexpected shape",
      latencyMs: modelsLatencyMs,
    };
  }

  return {
    ok: true,
    healthz: { status: healthzResponse.status, latencyMs: healthzLatencyMs },
    models: {
      status: modelsResponse.status,
      modelCount: extracted.items.length,
      latencyMs: modelsLatencyMs,
    },
  };
}
