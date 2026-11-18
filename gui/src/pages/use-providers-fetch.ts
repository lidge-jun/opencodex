import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { writeSessionListCache } from "../session-list-cache";
import type { OAuthStatus, ProvidersConfig } from "./providers-shared";
export type ProvidersConfigRefreshResult = "applied" | "failed" | "superseded";

export function useProvidersFetch({
  apiBase,
  targetKey,
  t,
  setConfig,
  setOauthProviders,
  setOauthStatus,
  notify,
  invalidateProviderQuotas,
  configCacheKey,
}: {
  apiBase: string;
  /** Stable logical target; the relay apiBase can stay the same across a re-pair. */
  targetKey: string;
  t: TFn;
  setConfig: React.Dispatch<React.SetStateAction<ProvidersConfig | null>>;
  setOauthProviders: React.Dispatch<React.SetStateAction<string[]>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  notify: (msg: string, ok: boolean) => void;
  /** Bump the shell's quota revision; `force` adds `?refresh=1` to its next read. */
  invalidateProviderQuotas: (force?: boolean) => void;
  /** Session seed key for instant Providers shell paint (no secrets — hasApiKey flags only). */
  configCacheKey?: string;
}) {
  const configRequest = useRef(0);
  const oauthDiscovery = useRef(0);
  const oauthDiscoveryPublished = useRef(0);
  const target = useMemo(() => ({ apiBase, targetKey }), [apiBase, targetKey]);
  const activeTarget = useRef<typeof target | null>(null);
  const oauthWrites = useRef(new Map<string, number>());
  const oauthReads = useRef(new Map<string, number>());
  const oauthPublished = useRef(new Map<string, number>());
  const oauthAdmitted = useRef(new Set<string>());
  const oauthBlocked = useRef(new Set<string>());
  useEffect(() => () => { configRequest.current += 1; }, [target]);
  useLayoutEffect(() => {
    activeTarget.current = target;
    const blocked = oauthBlocked.current;
    return () => { activeTarget.current = null; oauthDiscovery.current += 1; oauthAdmitted.current.clear(); blocked.clear(); };
  }, [target]);
  const invalidateOauthStatusReads = useCallback((provider: string, blocked?: boolean) => {
    if (activeTarget.current !== target || (blocked === undefined && oauthBlocked.current.has(provider))) return false;
    oauthWrites.current.set(provider, (oauthWrites.current.get(provider) ?? 0) + 1);
    if (blocked === true) oauthBlocked.current.add(provider);
    if (blocked === false) oauthBlocked.current.delete(provider);
    return true;
  }, [target]);
  const captureOauthStatusRead = useCallback((provider: string) => {
    const revision = oauthWrites.current.get(provider) ?? 0;
    return () => activeTarget.current === target && !oauthBlocked.current.has(provider)
      && (oauthWrites.current.get(provider) ?? 0) === revision;
  }, [target]);
  const fetchConfig = useCallback(async (): Promise<ProvidersConfigRefreshResult> => {
    // An old target's completion must not advance the shared request sequence and make the
    // new target's in-flight config read look superseded.
    if (activeTarget.current !== target) return "superseded";
    const request = ++configRequest.current;
    // A read that started before this target or revision moved must not publish. Named
    // because the check is only meaningful after the read settles, never before it.
    const superseded = () => activeTarget.current !== target || request !== configRequest.current;
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await readJsonOrThrow<ProvidersConfig>(res);
      if (superseded()) return "superseded";
      if (!data) throw new Error("config response missing");
      setConfig(data ?? null);
      if (configCacheKey && data) writeSessionListCache(configCacheKey, data);
      return "applied";
    } catch {
      if (superseded()) return "superseded";
      notify(t("prov.loadConfigFail"), false);
      return "failed";
    }
  }, [apiBase, configCacheKey, notify, setConfig, t, target]);

  const fetchOauth = useCallback(async () => {
    if (activeTarget.current !== target) return;
    const discovery = ++oauthDiscovery.current;
    const writes = new Map(oauthWrites.current);
    const unchanged = (provider: string) => (writes.get(provider) ?? 0) === (oauthWrites.current.get(provider) ?? 0);
    try {
      // Codex openai status is owned by useCodexAccountPool — do not duplicate /accounts.
      const provRes = await fetch(`${apiBase}/api/oauth/providers`);
      const provData = await readJsonOrThrow<{ providers?: string[] }>(provRes);
      if (!Array.isArray(provData?.providers) || !provData.providers.every(p => typeof p === "string")) return;
      const provs = provData.providers;
      if (activeTarget.current !== target || discovery < oauthDiscoveryPublished.current) return;
      oauthDiscoveryPublished.current = discovery;
      oauthAdmitted.current = new Set(provs);
      setOauthProviders(provs);
      setOauthStatus(current => Object.fromEntries(Object.entries(current).filter(([provider]) => oauthAdmitted.current.has(provider) || !unchanged(provider))));
      await Promise.all(provs.map(async p => {
        const read = (oauthReads.current.get(p) ?? 0) + 1;
        oauthReads.current.set(p, read);
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${encodeURIComponent(p)}`).catch(() => null);
        const s = sRes ? await readJsonIfOk<OAuthStatus>(sRes) : null;
        if (!s || typeof s.loggedIn !== "boolean") return;
        if (activeTarget.current !== target || !oauthAdmitted.current.has(p) || oauthBlocked.current.has(p) || !unchanged(p) || read < (oauthPublished.current.get(p) ?? 0)) return;
        oauthPublished.current.set(p, read);
        setOauthStatus(current => activeTarget.current === target && oauthAdmitted.current.has(p) && !oauthBlocked.current.has(p) && unchanged(p)
          && read === oauthPublished.current.get(p) ? { ...current, [p]: s } : current);
      }));
    } catch { /* ignore */ }
  }, [apiBase, target, setOauthProviders, setOauthStatus]);

  /*
   * The workspace shell owns the single quota read; this only invalidates it. Keeping the
   * name means all twelve existing mutation call sites keep working unchanged, and a
   * mutation can no longer race the shell's own fetch for the same data.
   */
  const fetchProviderQuotas = useCallback(async (refresh = false) => {
    invalidateProviderQuotas(refresh);
  }, [invalidateProviderQuotas]);

  return { fetchConfig, fetchOauth, fetchProviderQuotas, invalidateOauthStatusReads, captureOauthStatusRead };
}
