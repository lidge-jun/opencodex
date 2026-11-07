import { createHmac, randomBytes } from "node:crypto";
import { GCP_CREDENTIAL_MARKER_PREFIX } from "./api-key-resolve";
import type { ProviderApiKeySelection } from "../types/provider";

// Keep the ambient key out of generic provider config and any serializable selection.
const digestKey = randomBytes(32);
const keySnapshots = new WeakMap<ProviderApiKeySelection, string>();

function ambientKeyDigest(): string {
  return createHmac("sha256", digestKey).update(process.env.GOOGLE_CLOUD_API_KEY || "").digest("hex");
}

export function captureVertexEnvironmentKey(selection: ProviderApiKeySelection | undefined, configuredKey: string | undefined): void {
  if (!selection || configuredKey?.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)) return;
  if (configuredKey && !configuredKey.startsWith("<") && configuredKey !== "N/A") return;
  if (keySnapshots.has(selection)) return;
  keySnapshots.set(selection, ambientKeyDigest());
}

export function vertexEnvironmentKeyIsCurrent(selection: ProviderApiKeySelection): boolean {
  const expected = keySnapshots.get(selection);
  return expected === undefined || expected === ambientKeyDigest();
}
