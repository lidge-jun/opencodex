import { createHash } from "node:crypto";
import { M365_COPILOT_BASE_URL } from "../../providers/m365-copilot-models";
import { M365_COPILOT_WEB_URL, normalizeM365WebSession, readM365ModelBootstrap } from "../../providers/m365-copilot-discovery";
import { providerOutboundGet } from "../../lib/provider-outbound";
import { credentialGeneration, getAccountCredentialWithStatus, getAccountSet } from "../../oauth/store";
import { m365CopilotClaims } from "../../oauth/m365-copilot";
import { getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, markProviderDiscoveryFailed, markProviderDiscoveryOk, setCached } from "../model-cache";
import { applyConfigHintsToCachedModels, applyProviderConfigHints } from "./model-hints";
import type { CatalogModel } from "./parsing";
import type { CapturedProviderGather, ModelsAuthResolution } from "./gather-capture";

export async function fetchM365CopilotCatalog(captured: CapturedProviderGather, auth: ModelsAuthResolution, ttlMs: number, contextCap: number | undefined, isCurrent: () => boolean): Promise<{ models: CatalogModel[]; state: "authoritative" | "degraded" }> {
  const { name, provider, metadataModelIdCaseFold, effectiveAlias, metadataConfigDir } = captured;
  const session = normalizeM365WebSession(auth.m365);
  if (name !== "m365-copilot" || provider.disabled || provider.authMode !== "oauth" || provider.baseUrl.replace(/\/+$/, "") !== M365_COPILOT_BASE_URL || !auth.apiKey || !session) {
    if (isCurrent()) markProviderDiscoveryFailed(name, { reason: "provider" });
    return { models: [], state: "degraded" };
  }
  const claims = m365CopilotClaims(auth.apiKey);
  if (session.accountId.toLowerCase() !== (claims.oid + "@" + claims.tid).toLowerCase()) return { models: [], state: "degraded" };
  const identity = createHash("sha256").update(JSON.stringify([auth.oauthAccountId, session.accountId, session.cookie])).digest("hex");
  const hinted = (models: CatalogModel[]) => applyConfigHintsToCachedModels(name, provider, models, contextCap, metadataModelIdCaseFold, effectiveAlias, metadataConfigDir, false);
  const fresh = getFreshCached(name, ttlMs, Date.now(), identity);
  if (fresh) return { models: hinted(fresh), state: "authoritative" };
  if (isModelsFetchCoolingDown(name, undefined, undefined, identity)) return { models: hinted(getStaleCached(name, identity) ?? []), state: "degraded" };
  const maySend = () => {
    if (!isCurrent()) return false;
    if (auth.observed) return true;
    const row = auth.oauthAccountId ? getAccountCredentialWithStatus(name, auth.oauthAccountId) : null;
    return !!row && !row.paused && !row.needsReauth && getAccountSet(name)?.activeAccountId === auth.oauthAccountId
      && row.credential.access === auth.apiKey && credentialGeneration(row.credential) === auth.oauthGeneration && row.credential.m365?.cookie === session.cookie;
  };
  try {
    const signal = AbortSignal.timeout(15_000);
    const response = await providerOutboundGet(name, provider, M365_COPILOT_WEB_URL, { headers: { cookie: session.cookie }, signal }, { beforeSend: maySend });
    if (!response.ok || response.status >= 300) { await response.body?.cancel(); throw new Error("Microsoft 365 Copilot web sign-in expired; retry login"); }
    const items = await readM365ModelBootstrap(response, session.accountId, signal);
    const models = items.map(item => applyProviderConfigHints(name, provider, { id: item.id, provider: name, displayName: item.name as string, inputModalities: ["text"] }, contextCap, metadataModelIdCaseFold, effectiveAlias, metadataConfigDir, false));
    if (!maySend()) return { models: [], state: "degraded" };
    setCached(name, models, Date.now(), undefined, identity);
    markProviderDiscoveryOk(name, models.length);
    return { models, state: "authoritative" };
  } catch {
    if (isCurrent()) { markModelsFetchFailure(name, undefined, identity); markProviderDiscoveryFailed(name, { reason: "provider" }); }
    return { models: hinted(getStaleCached(name, identity) ?? []), state: "degraded" };
  }
}
