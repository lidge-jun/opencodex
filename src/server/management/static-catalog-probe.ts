import type { OcxProviderConfig } from "../../types";
import { resolveVertexDiscoveryAuth, selectVertexDiscoveryCredential, vertexDiscoveryDeadline } from "../../providers/google-vertex-model-discovery";
import { effectiveGoogleMode } from "../../providers/registry";

export type StaticCatalogProbeResult =
  | { applicable: false; reason: "static_catalog"; latencyMs: 0 }
  | { ok: boolean; latencyMs: number; message?: string; error?: string };

/**
 * Connection test for a provider without live model discovery. There is no models endpoint to
 * call, so most such providers have nothing to test. Vertex on Application Default Credentials
 * (or a `gcp-sa:` marker) still has a credential: minting an access token proves it, needs no
 * model list, and is the same exchange the first real request performs.
 */
export async function staticCatalogConnectionTest(name: string, provider: OcxProviderConfig, signal?: AbortSignal): Promise<StaticCatalogProbeResult> {
  if (effectiveGoogleMode(name, provider) !== "vertex" || selectVertexDiscoveryCredential(provider).kind === "api-key") {
    return { applicable: false, reason: "static_catalog", latencyMs: 0 };
  }
  const started = Date.now();
  const auth = await resolveVertexDiscoveryAuth(provider, vertexDiscoveryDeadline(signal));
  const latencyMs = Date.now() - started;
  return auth
    ? { ok: true, latencyMs, message: "Google Cloud credentials verified (access token issued). Static model catalog; no live model list." }
    : { ok: false, latencyMs, error: "Google Cloud credentials could not issue an access token. Check `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS." };
}
