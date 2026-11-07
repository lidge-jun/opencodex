import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import CodexAccountPool from "../components/CodexAccountPool";
import DefaultModeRequestUserInputSetting from "../components/DefaultModeRequestUserInputSetting";
import UltraFastTierSetting from "../components/UltraFastTierSetting";
import MainAccountHardLockSetting from "../components/MainAccountHardLockSetting";
import { useCodexAccountPool } from "../hooks/useCodexAccountPool";
import CodexAccountPickerSetting from "../components/CodexAccountPickerSetting";
import { codexAccountModeState, type CodexAccountModeState } from "../codex-multi-state";
import { navigateHash } from "../hash-routing";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../provider-payload";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";
import { HelpButton, HelpRegion, InlineBanner } from "../components/v2-accounts/surface";
import { useHelp } from "../components/v2-accounts/use-help";

export type OpenAiAccountBannerState = CodexAccountModeState | "invalid" | null;

export function OpenAiAccountModeBanner({
  state,
  busy,
  onEnable,
}: {
  state: OpenAiAccountBannerState;
  busy: boolean;
  onEnable: () => void;
}) {
  const t = useT();
  const help = useHelp();
  // Nothing is known yet: an empty titled card is a blank slab that later jumps when
  // /api/config arrives. Render nothing and let the pool section own the space.
  if (state === null) return null;
  const settled = state === "pool" || state === "direct";
  return (
    // One quiet line when the mode is settled: the mode is the state, its explanation sits
    // behind the "?". A missing or disabled provider is a problem, so it stays spelled out.
    <div className={`openai-account-mode-banner acc-mode flex flex-col gap-2 rounded-[12px] px-4 py-3 ring-1 ring-line ${settled ? "bg-transparent" : "bg-surface"}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[13px] font-medium text-fg-muted">{t("codexAuth.accountModeTitle")}</span>
        {state === "pool" ? (
          <span className="badge openai-account-mode-banner__badge-slot">{t("codexAuth.accountModePool")}</span>
        ) : state === "direct" ? (
          <span className="badge openai-account-mode-banner__badge-slot">{t("codexAuth.accountModeDirect")}</span>
        ) : null}
        {settled && (
          <HelpButton open={help.open} controls={help.id} name={t("codexAuth.accountModeTitle")} onToggle={help.toggle} />
        )}
        {(state === "absent" || state === "disabled") && (
          <button type="button" className="btn btn-primary btn-sm ml-auto" disabled={busy} onClick={onEnable}>
            {busy ? t("codexAuth.enablingOpenai") : t("codexAuth.enableOpenai")}
          </button>
        )}
      </div>
      {settled && (
        <HelpRegion id={help.id} open={help.open}>
          {state === "pool" && t("codexAuth.accountModePoolDesc")}
          {state === "direct" && (
            <>
              {t("codexAuth.accountModeDirectDesc")}{" "}
              <button type="button" className="link-btn" onClick={() => navigateHash("providers")}>
                {t("codexAuth.openProviders")}
              </button>
            </>
          )}
        </HelpRegion>
      )}
      {(state === "absent" || state === "disabled") && (
        <p className="card-sub m-0 text-[13px] text-fg-muted">{t("codexAuth.openaiUnavailableDesc")}</p>
      )}
      {state === "invalid" && (
        <p className="card-sub openai-account-mode-banner__desc m-0 text-[13px] text-fg-muted">
          {t("codexAuth.openaiMissing")}{" "}
          <button type="button" className="link-btn" onClick={() => navigateHash("providers")}>
            {t("codexAuth.openProviders")}
          </button>
        </p>
      )}
    </div>
  );
}

function openaiProviderFromConfig(config: unknown): {
  adapter?: string;
  authMode?: string;
  baseUrl?: string;
  disabled?: boolean;
} | undefined {
  if (!config || typeof config !== "object") return undefined;
  const providers = (config as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  if (!Object.hasOwn(providers, "openai")) return undefined;
  const provider = (providers as Record<string, unknown>).openai;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  return provider as {
    adapter?: string;
    authMode?: string;
    baseUrl?: string;
    disabled?: boolean;
  };
}

type CachedMode = {
  bannerState: OpenAiAccountBannerState;
  accountModeState: CodexAccountModeState | null;
};

/**
 * The Multi-auth panel of Codex Set — a thin wrapper around CodexAccountPool
 * (WP060 extraction). The panel owns the /api/config fetch feeding the
 * account-mode banner and passes the mode down so the pool renders mode-aware
 * copy.
 *
 * This is a MOVE, not a rewrite: every line below arrived here from
 * `CodexAuth.tsx` unchanged, including the session cache key
 * `ocx.codex-auth.config.v1`. Renaming that key would discard every user's warm
 * cache to gain nothing, and the backend namespace /api/codex-auth/* does not
 * move either (devlog 004 §C: a dozen test files bind to it).
 */
export default function CodexSetMultiauth({ apiBase }: { apiBase: string }) {
  // The controller, not just the setting, owns proxy-specific state and callbacks.
  return <CodexSetMultiauthForProxy key={apiBase} apiBase={apiBase} />;
}

function CodexSetMultiauthForProxy({ apiBase }: { apiBase: string }) {
  const t = useT();
  const poolController = useCodexAccountPool(apiBase);
  const { load: loadAccounts } = poolController;
  const ownerMountedRef = useRef(false);
  useLayoutEffect(() => {
    ownerMountedRef.current = true;
    // Retire captured callbacks at commit, before a replacement proxy can be displayed.
    return () => { ownerMountedRef.current = false; };
  }, []);
  const onHardLockSaved = useCallback(() => ownerMountedRef.current
    ? loadAccounts(false)
    : Promise.resolve(false), [loadAccounts]);
  const configCacheKey = `ocx.codex-auth.config.v1:${apiBase}`;
  const cached = readSessionListCache<CachedMode>(configCacheKey);
  const [bannerState, setBannerState] = useState<OpenAiAccountBannerState>(() => cached?.bannerState ?? null);
  const [accountModeState, setAccountModeState] = useState<CodexAccountModeState | null>(
    () => cached?.accountModeState ?? null,
  );
  // Which apiBase this instance has already read the account mode for. StrictMode double-invokes
  // the mount effect and its deferred read cannot be cancelled, so dedupe here.
  const initialModeKeyRef = useRef<string | null>(null);
  const [enableBusy, setEnableBusy] = useState(false);
  const [enableError, setEnableError] = useState("");

  const loadMode = useCallback(async () => {
    const bounded = createBoundedFetch(15_000);
    try {
      const res = await fetch(`${apiBase}/api/config`, { signal: bounded.signal });
      if (!res.ok) throw new Error(String(res.status));
      const config = await res.json();
      const providerState = openAiAccountProviderState(openaiProviderFromConfig(config));
      if (providerState === "absent" || providerState === "disabled" || providerState === "invalid") {
        setBannerState(providerState);
        // Non-canonical / missing rows are not a live Codex account mode.
        const mode = providerState === "disabled" ? "disabled" as const : "absent" as const;
        setAccountModeState(mode);
        writeSessionListCache(configCacheKey, { bannerState: providerState, accountModeState: mode });
        return;
      }
      const mode = codexAccountModeState(config);
      setBannerState(mode);
      setAccountModeState(mode);
      writeSessionListCache(configCacheKey, { bannerState: mode, accountModeState: mode });
    } catch {
      // Keep last-good banner on transient config failures.
    } finally {
      bounded.clear();
    }
  }, [apiBase, configCacheKey]);

  useEffect(() => {
    // Deferred by a microtask, not a timer: a timer had to be cancelled in cleanup, so a quick hop
    // away from this tab left the banner with no mode read until the next poll. A microtask keeps
    // the state update out of the effect body while still guaranteeing the request goes out.
    // Guarded per identity: StrictMode double-invokes this effect and the microtask cannot be
    // cancelled, so without it the banner reads /api/config twice on every mount.
    if (initialModeKeyRef.current !== apiBase) {
      initialModeKeyRef.current = apiBase;
      void Promise.resolve().then(() => { void loadMode(); });
    }
    // Hidden tabs hold no timer and fire nothing; the visible make-up tick re-reads
    // the mode the moment the user returns.
    const stop = startVisibilityPoll(() => { void loadMode(); }, 30_000);
    return () => { stop(); };
  }, [apiBase, loadMode]);

  const enableOpenAi = async () => {
    setEnableBusy(true);
    setEnableError("");
    try {
      // Recovery is gated on the same canonical checks as Providers → Accounts.
      if (bannerState !== "absent" && bannerState !== "disabled") return;
      await ensureOpenAiProvider(apiBase, bannerState);
      await loadMode();
    } catch (error) {
      if (error instanceof OpenAiEnableError) {
        setEnableError(t(error.i18nKey));
      } else {
        setEnableError(error instanceof Error ? error.message : t("prov.saveFailed"));
      }
    } finally {
      setEnableBusy(false);
    }
  };

  const banner = <>
    <OpenAiAccountModeBanner
      state={bannerState}
      busy={enableBusy}
      onEnable={() => { void enableOpenAi(); }}
    />
    {enableError && <InlineBanner tone="err" role="alert">{enableError}</InlineBanner>}
  </>;

  return (
    <>
      <CodexAccountPool
        apiBase={apiBase}
        controller={poolController}
        hasMainHardLockSetting
        accountModeState={accountModeState}
        banner={banner}
        advancedExtras={<>
          <CodexAccountPickerSetting apiBase={apiBase} />
          <DefaultModeRequestUserInputSetting apiBase={apiBase} />
          <UltraFastTierSetting apiBase={apiBase} />
          <MainAccountHardLockSetting apiBase={apiBase} onSaved={onHardLockSaved} />
        </>}
      />
    </>
  );
}
