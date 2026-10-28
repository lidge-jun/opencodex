import { getConfigDir } from "../../config/paths";
import { getValidAccessSnapshotForAccount, type OAuthAccessSnapshot } from "../../oauth";
import { credentialGeneration, getAccountCredentialWithStatus, getAccountSet } from "../../oauth/store";
import { providerOutboundPost, providerRedirectError } from "../../lib/provider-outbound";
import { isRegistryModelDiscoveryUrl, readBoundedDiscoveryJson } from "../../providers/model-discovery";
import { parseAntigravityAvailableModels, type AntigravityAvailableModel } from "../../providers/antigravity-models";
import { captureAntigravityModelObservation, recordAntigravityAccountRoster } from "../../providers/antigravity-account-roster";
import type { OcxProviderConfig } from "../../types";
import { materializeCapturedHeaders, type CapturedModelsRequest } from "./gather-capture";

/** A sibling contributes only while the exact snapshot sent is still usable. */
export async function discoverAntigravitySiblings(
  name: string, provider: OcxProviderConfig, activeAccountId: string,
  request: CapturedModelsRequest, maxBytes: number, maxModels: number,
  root: string,
): Promise<() => AntigravityAvailableModel[]> {
  if (root !== getConfigDir()) return () => [];
  const results: Array<{
    snapshot: OAuthAccessSnapshot; models: AntigravityAvailableModel[];
    observation: ReturnType<typeof captureAntigravityModelObservation>;
  }> = [];
  const current = (snapshot: OAuthAccessSnapshot): boolean => {
    if (getConfigDir() !== root) return false;
    const row = getAccountCredentialWithStatus(name, snapshot.accountId);
    return !!row && !row.paused && !row.needsReauth && row.credential.expires > Date.now()
      && credentialGeneration(row.credential) === snapshot.generation
      && row.credential.access === snapshot.accessToken;
  };
  // Bound concurrency and preserve stable account order; a failed sibling is fail-soft.
  for (const sibling of getAccountSet(name)?.accounts ?? []) {
    if (sibling.id === activeAccountId || sibling.paused || sibling.needsReauth) continue;
    try {
      if (getConfigDir() !== root) break;
      const snapshot = await getValidAccessSnapshotForAccount(name, sibling.id, { requireUsableAccount: true });
      const project = provider.project ?? snapshot.projectId;
      if (!project || !current(snapshot)) continue;
      const observation = captureAntigravityModelObservation();
      const response = await providerOutboundPost(name, provider, request.url, {
        headers: materializeCapturedHeaders(request, snapshot.accessToken),
        body: JSON.stringify({ project }), signal: AbortSignal.timeout(8000),
      }, { isCanonicalUrl: isRegistryModelDiscoveryUrl, beforeSend: () => current(snapshot) });
      if (!response.ok || await providerRedirectError(response, request.url)) continue;
      const bounded = await readBoundedDiscoveryJson(response, maxBytes);
      if (!bounded.ok) continue;
      const models = parseAntigravityAvailableModels(bounded.value, maxModels);
      if (models && current(snapshot)) results.push({ snapshot, models, observation });
    } catch { /* A sibling cannot invalidate successful active-account discovery. */ }
  }
  // Called synchronously with the catalog publication, after all outbound awaits.
  return () => {
    const union: AntigravityAvailableModel[] = [];
    for (const { snapshot, models, observation } of results) {
      if (!current(snapshot)) continue;
      recordAntigravityAccountRoster(name, snapshot.accountId, models, Date.now(), observation);
      union.push(...models);
    }
    return union;
  };
}
