import { captureAccountAutoPauseFence, accountAutoPauseFenceIsLocal, accountAutoPauseFenceMatchesDisk } from "../config/account-auto-pause-revisions";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { OAuthAccessSnapshot } from "./index";
import type { CodexAuthContext } from "../codex/auth-context";
import type { AccountPauseReason } from "../types/account-auto-pause";
import { credentialGeneration, getAccountSet, setAccountPaused } from "./store";
import { mutatePersistedConfig } from "../config";
import { isCodexAccountGenerationLive, readCodexAccountRecord } from "../codex/account-store";
import { captureMainQuotaDispatch, isMainQuotaDispatchLive } from "../codex/main-account-cache";
import { isCodexAccountPaused, setCodexAccountPaused } from "../codex/account-pause";
import { apiKeyPoolEntryId } from "../providers/api-keys";
import { resolveProviderApiKey } from "../providers/api-key-resolve";
import { createHash } from "node:crypto";
import { setProviderApiKeyPaused } from "../providers/api-key-pause";
import { AccountRefusalStreaks, autoPauseThreshold, permanentAccountRefusal } from "./account-auto-pause-policy";
import { clearThreadAccountMapForAccount, reconcileCodexActiveAfterExclusion } from "../codex/routing";
import { isNonReplayableResponse } from "../lib/upstream-retry";
import { hasUpstreamRewriters, upstreamRewriterEpoch } from "../plugins/upstream-hooks";

const streaks = new WeakMap<OcxConfig, AccountRefusalStreaks>();
export { wasAccountAutoPaused, wasPermanentAccountRefusal } from "../lib/account-auto-pause-response";
import { markAccountAutoPaused, markPermanentAccountRefusal } from "../lib/account-auto-pause-response";
export interface AccountAutoPauseBinding {
  config: OcxConfig;
  oauth?: OAuthAccessSnapshot;
  codex?: CodexAuthContext;
}

/** Capture before transport. A later response cannot acquire authority over a newer login/resume. */
export type AccountAutoPauseObserver = ((response: Response) => Promise<Response>) & {
  /** Final-send report: only a response whose wire credential and destination match is counted. */
  physical: (sameDestination: boolean, headers: Headers) => void;
};
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"] as const;
const CODEX_SELECTOR_HEADERS = ["openai-organization", "openai-project"] as const;
// Nested capture sites (a providerFetch observer around a dispatchOverride's own observer) see the
// same physical response. It counts once per account, and a response whose final send was reported
// to any observer is never attributed by an observer that received no report.
const countedResponses = new WeakMap<Response, Set<string>>();
const reportedResponses = new WeakSet<Response>();
export function captureAccountAutoPauseAttempt(name: string, provider: OcxProviderConfig, binding?: AccountAutoPauseBinding, headers?: Headers):
  AccountAutoPauseObserver | undefined {
  if (!binding) return;
  const { config, oauth, codex } = binding;
  const threshold = autoPauseThreshold(config.providers[name]?.accountAutoPause);
  if (!threshold) return;
  const configured = config.providers[name];
  if (!configured || configured.disabled) return;
  const fence = captureAccountAutoPauseFence(config, name);
  if (!fence) return;
  const route = JSON.stringify([configured.baseUrl, configured.adapter, configured.authMode]);
  const policyCurrent = () => accountAutoPauseFenceIsLocal(name, fence) && !config.providers[name]?.disabled
    && autoPauseThreshold(config.providers[name]?.accountAutoPause) === threshold
    && JSON.stringify([config.providers[name]?.baseUrl, config.providers[name]?.adapter, config.providers[name]?.authMode]) === route;
  let key: string, incarnation: string, current: () => boolean, owns: (wire: Headers) => boolean;
  let pause: (reason: AccountPauseReason) => Promise<boolean>;
  if (provider.authMode === "oauth") {
    if (!oauth || oauth.provider !== name || headers?.get("authorization") !== `Bearer ${oauth.accessToken}` || headers.has("x-api-key")) return;
    const row = getAccountSet(name)?.accounts.find(a => a.id === oauth.accountId);
    if (!row || row.paused || credentialGeneration(row.credential) !== oauth.generation) return;
    const revision = row.pauseRevision;
    owns = wire => wire.get("authorization") === `Bearer ${oauth.accessToken}` && !wire.has("x-api-key");
    key = `${name}\0oauth\0${oauth.accountId}`;
    incarnation = `${row.loginId ?? row.addedAt ?? oauth.accountId}\0${revision ?? ""}`;
    current = () => {
      const live = getAccountSet(name)?.accounts.find(a => a.id === oauth.accountId);
      return !!live && !live.paused && live.pauseRevision === revision && credentialGeneration(live.credential) === oauth.generation;
    };
    pause = async reason => (await setAccountPaused(name, oauth.accountId, true, {
      generation: oauth.generation, pauseRevision: revision, isCurrent: policyCurrent,
      assertPolicyBeforePersist: () => { if (!accountAutoPauseFenceMatchesDisk(name, fence)) throw new Error("Account auto-pause policy changed before persistence"); }, details: { reason, pausedAt: Date.now() },
    })).status === "updated";
  } else if (provider.authMode === "forward") {
    if (!codex || codex.kind !== "pool" && codex.kind !== "main-pool") return;
    const { accountId } = codex;
    // The bearer and the workspace together name the Codex account; organization/project selectors
    // must stay as captured, so a rewrite that keeps the bearer cannot redirect the refusal.
    const selectors = CODEX_SELECTOR_HEADERS.map(header => headers?.get(header) ?? null);
    const codexOwns = (wire: Headers) => wire.get("authorization") === `Bearer ${codex.accessToken}`
      && wire.get("chatgpt-account-id") === codex.chatgptAccountId
      && CODEX_SELECTOR_HEADERS.every((header, index) => wire.get(header) === selectors[index]);
    if (!headers || !codexOwns(headers)) return;
    owns = codexOwns;
    const revision = config.codexAccountPauseState?.[accountId]?.revision;
    const mainDispatch = codex.kind === "main-pool" ? captureMainQuotaDispatch(codex.accessToken, codex.chatgptAccountId, codex.writerGeneration) : undefined;
    const credentialCurrent = () => codex.kind === "pool"
      ? isCodexAccountGenerationLive(accountId, codex.generation)
      : !!mainDispatch && isMainQuotaDispatchLive(mainDispatch);
    key = `${name}\0codex\0${accountId}`;
    incarnation = `${codex.kind === "pool" ? readCodexAccountRecord(accountId)?.quotaHistoryIdentity ?? codex.generation : mainDispatch?.credentialGeneration}\0${revision ?? ""}`;
    current = () => !isCodexAccountPaused(config, accountId)
      && config.codexAccountPauseState?.[accountId]?.revision === revision && credentialCurrent();
    pause = async reason => {
      let pauseState: OcxConfig["codexAccountPauseState"];
      const outcome = mutatePersistedConfig(fresh => {
        if (!policyCurrent() || !accountAutoPauseFenceMatchesDisk(name, fence, fresh) || !credentialCurrent() || isCodexAccountPaused(fresh, accountId)
          || fresh.codexAccountPauseState?.[accountId]?.revision !== revision
          || autoPauseThreshold(fresh.providers[name]?.accountAutoPause) !== threshold) return { changed: false, value: false };
        setCodexAccountPaused(fresh, accountId, true, { reason, pausedAt: Date.now() });
        pauseState = structuredClone(fresh.codexAccountPauseState);
        return { changed: true, value: true };
      });
      if (outcome.status !== "committed" || !outcome.value) return false;
      config.pausedCodexAccountIds = [...new Set([...(config.pausedCodexAccountIds ?? []), accountId])];
      config.codexAccountPauseState = pauseState;
      clearThreadAccountMapForAccount(accountId);
      reconcileCodexActiveAfterExclusion(config, accountId);
      return true;
    };
  } else {
    const selection = provider._apiKeyAttempt;
    if (!headers || !provider.apiKey || ![headers.get("authorization"), headers.get("x-api-key"), headers.get("x-goog-api-key")].some(value => value === provider.apiKey || value === `Bearer ${provider.apiKey}`)) return;
    const entry = configured.apiKeyPool?.find(e => e.id === selection?.entryId && e.key === selection.reference)
      ?? (!configured.apiKeyPool?.length && configured.apiKey ? { id: apiKeyPoolEntryId(configured.apiKey), key: configured.apiKey, disabled: false, pauseRevision: undefined } : undefined);
    if (!entry || entry.disabled || !selection) return;
    const { id, key: reference, pauseRevision } = entry;
    key = `${name}\0key\0${id}`;
    const resolvedKey = provider.apiKey;
    owns = wire => {
      const sent = CREDENTIAL_HEADERS.map(header => wire.get(header)).filter((value): value is string => value !== null);
      return sent.length > 0 && sent.every(value => value === resolvedKey || value === `Bearer ${resolvedKey}`);
    };
    incarnation = `${createHash("sha256").update(resolvedKey).digest("hex")}\0${pauseRevision ?? ""}`;
    current = () => {
      const configured = config.providers[name];
      const live = configured?.apiKeyPool?.find(e => e.id === id) ?? (!configured?.apiKeyPool?.length && configured?.apiKey === reference ? entry : undefined);
      return !!live && !live.disabled && live.key === reference && live.pauseRevision === pauseRevision && resolveProviderApiKey(reference) === resolvedKey;
    };
    pause = async reason => setProviderApiKeyPaused(config, name, id, true, {
      selection, pauseRevision, resolvedKey, fence, details: { reason, pausedAt: Date.now() },
    });
  }
  incarnation += `\0${fence.diskRevision}\0${fence.localGen}`;
  let tracker = streaks.get(config);
  if (!tracker) { tracker = new AccountRefusalStreaks(); streaks.set(config, tracker); }
  const observed = new WeakSet<Response>();
  // undefined: no HTTP final-send report (Codex WebSocket). Such a send is attributable only when
  // no rewriter was registered at capture and none was registered or removed before the response,
  // so no plugin could have rewritten the dial in between.
  const rewriterEpoch = hasUpstreamRewriters() ? undefined : upstreamRewriterEpoch();
  let wireOwned: boolean | undefined;
  const observer = (async (response: Response) => {
    if (observed.has(response) || isNonReplayableResponse(response)) return response;
    observed.add(response);
    if (wireOwned !== undefined) reportedResponses.add(response);
    else if (reportedResponses.has(response)) return response;
    if (!(wireOwned ?? (rewriterEpoch !== undefined && upstreamRewriterEpoch() === rewriterEpoch))) return response;
    const counted = countedResponses.get(response) ?? new Set<string>();
    if (counted.has(key)) return response;
    countedResponses.set(response, counted.add(key));
    try {
      const verdict = permanentAccountRefusal(response).then(reason => {
        if (reason) markPermanentAccountRefusal(response);
        return reason;
      });
      const paused = await tracker.observe(key, incarnation, threshold, verdict, response.ok,
        () => policyCurrent() && current(), pause);
      if (paused) {
        markAccountAutoPaused(response);
        // Fixed codes only. Never print the upstream body, provider label, or account identifier.
        console.warn(`[account-auto-pause] paused after ${threshold} consecutive permanent account refusals`);
      }
    } catch {
      // Optional persistence must preserve the original provider response.
      console.warn("[account-auto-pause] could not persist account pause; upstream response preserved");
    }
    return response;
  }) as AccountAutoPauseObserver;
  observer.physical = (sameDestination, wire) => { wireOwned = sameDestination && owns(wire); };
  return observer;
}
