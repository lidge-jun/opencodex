import type { OcxProviderConfig } from "../../types";
import { vertexConfiguredCredentialKind } from "../../lib/gcp-adc";
import { resolveVertexDiscoveryAuth, selectVertexDiscoveryCredential, vertexDiscoveryDeadline } from "../../providers/google-vertex-model-discovery";
import { effectiveGoogleMode } from "../../providers/registry";

export type StaticCatalogProbeResult =
  | { applicable: false; reason: "static_catalog"; latencyMs: 0 }
  | { ok: boolean; latencyMs: number; message?: string; error?: string };

/**
 * Connection test for a provider without live model discovery. There is no models endpoint to
 * call, so most such providers have nothing to test. Vertex on Application Default Credentials
 * (or a `gcp-sa:` marker) still has a credential: minting an access token proves it, needs no
 * model list, and is the same exchange the first real request performs. The probe forces a new
 * exchange: a cached token would keep reporting ok for up to an hour after the credential is revoked.
 */
export async function staticCatalogConnectionTest(name: string, provider: OcxProviderConfig, signal?: AbortSignal): Promise<StaticCatalogProbeResult> {
  if (effectiveGoogleMode(name, provider) !== "vertex") {
    return { applicable: false, reason: "static_catalog", latencyMs: 0 };
  }
  // A literal key or a keychain:/${ENV} reference is an API key: answer before anything is resolved,
  // so this probe never reads the credential store for a row it cannot test.
  const configured = vertexConfiguredCredentialKind(provider.apiKey);
  if (configured === "api-key" || configured === "reference" || selectVertexDiscoveryCredential(provider).kind === "api-key") {
    return { applicable: false, reason: "static_catalog", latencyMs: 0 };
  }
  const started = Date.now();
  const auth = await resolveVertexDiscoveryAuth(provider, vertexDiscoveryDeadline(signal), { forceExchange: true });
  const latencyMs = Date.now() - started;
  return auth
    ? { ok: true, latencyMs, message: "Google Cloud credentials verified (access token issued). Static model catalog; no live model list." }
    : { ok: false, latencyMs, error: "Google Cloud credentials could not issue an access token. Check `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS." };
}
