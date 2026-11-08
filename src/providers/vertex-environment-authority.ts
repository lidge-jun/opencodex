import { createHmac, randomBytes } from "node:crypto";
import { GCP_CREDENTIAL_MARKER_PREFIX } from "./api-key-resolve";
import type { ProviderApiKeySelection } from "../types/provider";
import type { OcxProviderConfig } from "../types";

// Keep the ambient key out of generic provider config and any serializable selection.
const digestKey = randomBytes(32);
export type VertexAmbientKeyAuthority = { digest: string; generation: number };
const keySnapshots = new WeakMap<ProviderApiKeySelection, { ambient?: VertexAmbientKeyAuthority; adapter: string; modelAdapters: string }>();
let observedKey: VertexAmbientKeyAuthority | undefined;
let keyGeneration = 0;

function ambientKeyDigest(): string {
  return createHmac("sha256", digestKey).update(process.env.GOOGLE_CLOUD_API_KEY || "").digest("hex");
}

function observeAmbientKey(): VertexAmbientKeyAuthority {
  const digest = ambientKeyDigest();
  if (observedKey?.digest !== digest) observedKey = { digest, generation: ++keyGeneration };
  return observedKey;
}

export function captureVertexAmbientKey(key: string): VertexAmbientKeyAuthority {
  const current = observeAmbientKey();
  const digest = createHmac("sha256", digestKey).update(key).digest("hex");
  return digest === current.digest ? current : { digest, generation: -1 };
}

export function vertexAmbientKeyIsCurrent(expected: VertexAmbientKeyAuthority): boolean {
  const current = observeAmbientKey();
  return expected.digest === current.digest && expected.generation === current.generation;
}

function modelAdapterSignature(provider: OcxProviderConfig): string {
  return JSON.stringify(Object.entries(provider.modelAdapters ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export function captureVertexEnvironmentKey(selection: ProviderApiKeySelection | undefined, provider: OcxProviderConfig): void {
  if (!selection || keySnapshots.has(selection)) return;
  const configuredKey = provider.apiKey;
  const ambient = !configuredKey?.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)
    && (!configuredKey || configuredKey.startsWith("<") || configuredKey === "N/A") ? observeAmbientKey() : undefined;
  keySnapshots.set(selection, { adapter: provider.adapter, modelAdapters: modelAdapterSignature(provider), ambient });
}

export function vertexEnvironmentKeyIsCurrent(selection: ProviderApiKeySelection, current: OcxProviderConfig): boolean {
  const expected = keySnapshots.get(selection);
  return expected === undefined || (expected.adapter === current.adapter && expected.modelAdapters === modelAdapterSignature(current)
    && (!expected.ambient || vertexAmbientKeyIsCurrent(expected.ambient)));
}
