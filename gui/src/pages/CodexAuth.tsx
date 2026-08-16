import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import CodexAccountPool from "../components/CodexAccountPool";
import DefaultModeRequestUserInputSetting from "../components/DefaultModeRequestUserInputSetting";
import CodexAccountPickerSetting from "../components/CodexAccountPickerSetting";
import { codexAccountModeState, type CodexAccountModeState } from "../codex-multi-state";
import { navigateHash } from "../hash-routing";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../provider-payload";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { startVisibilityPoll } from "../visibility-poll";
import { createBoundedFetch } from "../bounded-fetch";

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
  return (
    <div className="panel openai-account-mode-banner" style={{ marginBottom: 16 }}>
      <div className="row">
        <strong>{t("codexAuth.accountModeTitle")}</strong>
        {state === null ? (
          <span className="badge badge-accent openai-account-mode-banner__badge-slot openai-account-mode-banner__badge-slot--pending" aria-hidden="true">
            {t("codexAuth.accountModePool")}
          </span>
        ) : state === "pool" ? (
          <span className="badge badge-accent openai-account-mode-banner__badge-slot">{t("codexAuth.accountModePool")}</span>
        ) : state === "direct" ? (
          <span className="badge badge-green openai-account-mode-banner__badge-slot">{t("codexAuth.accountModeDirect")}</span>
        ) : null}
      </div>
      {/*
        Reserve the description line while config is still unknown so the pool
        section below does not jump when /api/config arrives.
      */}
      {state === null && (
        <p className="card-sub openai-account-mode-banner__desc openai-account-mode-banner__desc--pending" aria-hidden="true">
          &nbsp;
        </p>
      )}
      {state === "pool" && (
        <p className="card-sub openai-account-mode-banner__desc">{t("codexAuth.accountModePoolDesc")}</p>
      )}
      {state === "direct" && (
        <p className="card-sub openai-account-mode-banner__desc">
          {t("codexAuth.accountModeDirectDesc")}{" "}
          <button type="button" className="link-btn" onClick={() => navigateHash("providers")}>
            {t("codexAuth.openProviders")}
          </button>
        </p>
      )}
      {(state === "absent" || state === "disabled") && (
        <div className="row" style={{ alignItems: "center", marginTop: 8 }}>
          <p className="card-sub" style={{ flex: 1, margin: 0 }}>{t("codexAuth.openaiUnavailableDesc")}</p>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onEnable}>
            {busy ? t("codexAuth.enablingOpenai") : t("codexAuth.enableOpenai")}
          </button>
        </div>
      )}
      {state === "invalid" && (
        <p className="card-sub openai-account-mode-banner__desc">
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
 * Codex Auth page — a thin wrapper around CodexAccountPool (WP060 extraction).
 * The page owns the /api/config fetch feeding the account-mode banner and
 * passes the mode down so the pool renders mode-aware copy.
 */
export default function CodexAuth({ apiBase }: { apiBase: string }) {
  const t = useT();
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
    {enableError && <div className="notice notice-err" role="alert">{enableError}</div>}
  </>;

  return (
    <>
      <CodexAccountPool
        apiBase={apiBase}
        accountModeState={accountModeState}
        banner={banner}
        advancedExtras={<>
          <CodexAccountPickerSetting apiBase={apiBase} />
          <DefaultModeRequestUserInputSetting apiBase={apiBase} />
        </>}
      />
    </>
  );
}
