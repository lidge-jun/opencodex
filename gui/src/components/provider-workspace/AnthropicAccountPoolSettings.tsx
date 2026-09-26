/**
 * OAuth account-pool controls for Anthropic and generic providers.
 *
 * Anthropic keeps quotaWindow and its experimental warning. Generic OAuth
 * providers (including Google Antigravity) share the same /api/pool/settings
 * contract without quotaWindow: the toggle is proactive pre-dispatch selection,
 * while 429 rotation stays presence-driven.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { getPoolSettings, putPoolSettings } from "../../pool-settings";
import {
  ACCOUNT_POOL_QUOTA_WINDOWS,
  DEFAULT_ACCOUNT_POOL_QUOTA_WINDOW,
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolQuotaWindow,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  type AccountPoolQuotaWindow,
  type AccountPoolStrategy,
} from "../../account-pool-strategy";
import AccountPoolStrategyControls from "../AccountPoolStrategyControls";
import AccountPoolStrategyPreview from "../AccountPoolStrategyPreview";
import { Select } from "../../ui";

const QUOTA_WINDOW_LABEL_KEYS = {
  "five-hour": "accountPool.quotaWindowFiveHour",
  weekly: "accountPool.quotaWindowWeekly",
  "max-utilization": "accountPool.quotaWindowMaxUtilization",
} as const;

type PoolState = {
  enabled: boolean;
  threshold: number;
  strategy: AccountPoolStrategy;
  stickyLimit: number;
  quotaWindow: AccountPoolQuotaWindow;
  supported: string[];
  /** Saved-but-inactive marker from the API (generic kind, kernel off). */
  inert: boolean;
};

function controlId(provider: string, suffix: string): string {
  const safe = provider.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "oauth";
  if (provider === "anthropic") {
    if (suffix === "quota-window") return "anthropic-pool-quota-window";
    if (suffix === "strategy") return "anthropic-pool-strategy";
    if (suffix === "sticky-limit") return "anthropic-pool-sticky-limit";
  }
  return safe + "-" + suffix;
}

export default function AnthropicAccountPoolSettings({
  apiBase,
  accountCount,
  provider = "anthropic",
}: {
  apiBase: string;
  accountCount: number;
  provider?: string;
}) {
  const t = useT();
  const isAnthropic = provider === "anthropic";
  const [state, setState] = useState<PoolState | null>(null);
  const [draft, setDraft] = useState("80");
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [visibleProvider, setVisibleProvider] = useState(provider);
  // Provider switch: clear stale pool state during render (same adjustment pattern
  // as ProviderDetails) so the previous provider is never shown while reloading.
  const providerRef = useRef(provider);
  useEffect(() => { providerRef.current = provider; }, [provider]);

  if (provider !== visibleProvider) {
    setVisibleProvider(provider);
    setState(null);
    setLoadError(false);
  }

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void Promise.resolve()
      .then(() => getPoolSettings(apiBase, provider, (input, init) => fetch(input, init), { signal: ac.signal }))
      .then(settings => {
        if (!settings) throw new Error("load");
        return settings;
      })
      .then(json => {
        if (cancelled) return;
        const nextThreshold = typeof json.autoSwitchThreshold === "number" ? json.autoSwitchThreshold : 80;
        const nextSticky = normalizeAccountPoolStickyLimit(json.stickyLimit);
        setState({
          enabled: json.enabled === true || json.enabledEffective === true,
          threshold: nextThreshold,
          strategy: normalizeAccountPoolStrategy(json.strategy),
          stickyLimit: nextSticky,
          quotaWindow: json.quotaWindow == null
            ? DEFAULT_ACCOUNT_POOL_QUOTA_WINDOW
            : normalizeAccountPoolQuotaWindow(json.quotaWindow),
          supported: json.supported,
          inert: json.inert === true,
        });
        setDraft(String(nextThreshold));
        setStickyDraft(String(nextSticky));
        setLoadError(false);
      })
      .catch(() => {
        if (cancelled || ac.signal.aborted) return;
        setLoadError(true);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase, provider]);

  const save = useCallback(async (next: {
    enabled: boolean;
    threshold: number;
    strategy: AccountPoolStrategy;
    stickyLimit: number;
    quotaWindow: AccountPoolQuotaWindow;
  }) => {
    const previousState = state;
    const saveProvider = provider;
    setState({
      enabled: next.enabled,
      threshold: next.threshold,
      strategy: next.strategy,
      stickyLimit: next.stickyLimit,
      quotaWindow: next.quotaWindow,
      supported: previousState?.supported ?? [],
      inert: previousState?.inert ?? false,
    });
    setSaving(true);
    setError(null);
    try {
      const json = await putPoolSettings(apiBase, provider, {
        enabled: next.enabled,
        threshold: next.threshold,
        strategy: next.strategy,
        stickyLimit: next.stickyLimit,
        ...(isAnthropic ? { quotaWindow: next.quotaWindow } : {}),
      });
      if (!json) throw new Error("save");
      if (saveProvider !== providerRef.current) return;
      const savedStrategy = normalizeAccountPoolStrategy(json?.strategy ?? next.strategy);
      const savedSticky = normalizeAccountPoolStickyLimit(json?.stickyLimit ?? next.stickyLimit);
      const savedWindow = json?.quotaWindow == null
        ? next.quotaWindow
        : normalizeAccountPoolQuotaWindow(json.quotaWindow);
      setState({
        enabled: next.enabled,
        threshold: next.threshold,
        strategy: savedStrategy,
        stickyLimit: savedSticky,
        quotaWindow: savedWindow,
        supported: json.supported.length > 0 ? json.supported : (previousState?.supported ?? []),
        inert: json.inert === true,
      });
      setDraft(String(next.threshold));
      setStickyDraft(String(savedSticky));
    } catch {
      if (saveProvider !== providerRef.current) return;
      setError(t(isAnthropic ? "anthropicPool.saveFailed" : "genericPool.saveFailed"));
      if (previousState) {
        setState(previousState);
        setDraft(String(previousState.threshold));
        setStickyDraft(String(previousState.stickyLimit));
      }
    } finally {
      setSaving(false);
    }
  }, [apiBase, isAnthropic, provider, state, t]);

  const enabled = state?.enabled === true;
  const threshold = state?.threshold ?? 80;
  const strategy = state?.strategy ?? DEFAULT_ACCOUNT_POOL_STRATEGY;
  const stickyLimit = state?.stickyLimit ?? DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
  const parsedDraft = Number(draft);
  const previewThreshold = Number.isInteger(parsedDraft) && parsedDraft >= 0 && parsedDraft <= 100
    ? parsedDraft
    : threshold;
  const quotaWindow = state?.quotaWindow ?? DEFAULT_ACCOUNT_POOL_QUOTA_WINDOW;
  const showQuotaWindow = isAnthropic || (state?.supported ?? []).includes("quotaWindow");
  const quotaWindowInert = strategy === "round-robin";
  // Generic kind with the shared pool kernel off: strategy/threshold/sticky are
  // persisted but not consumed. The select stays on the saved value, disabled,
  // with a "saved, not live" marker instead of live behavior.
  const strategyInert = !isAnthropic && (state?.inert === true);
  const loading = state === null && !loadError;
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);
  const titleKey = isAnthropic ? "anthropicPool.title" : "genericPool.title";
  const enabledDesc = isAnthropic
    ? (threshold === 0
      ? t("anthropicPool.enabledNoProactiveDesc", { window: t(QUOTA_WINDOW_LABEL_KEYS[quotaWindow]) })
      : t("anthropicPool.enabledDesc", { threshold, window: t(QUOTA_WINDOW_LABEL_KEYS[quotaWindow]) }))
    : (threshold === 0 ? t("genericPool.enabledNoProactiveDesc") : t("genericPool.enabledDesc", { threshold }));
  const disabledDesc = t(isAnthropic ? "anthropicPool.disabledDesc" : "genericPool.disabledDesc");

  return (
    <div className="card anthropic-pool-card" aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t(titleKey)}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? t(isAnthropic ? "anthropicPool.loadFailed" : "genericPool.loadFailed")
              : loading
                ? t("common.loading")
                : enabled
                  ? enabledDesc
                  : disabledDesc}
          </div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={toggleDisabled}
          aria-pressed={enabled}
          aria-label={t(titleKey)}
          title={enabled ? t("anthropicPool.on") : t("anthropicPool.off")}
          onClick={() => {
            void save({
              enabled: !enabled,
              threshold,
              strategy,
              stickyLimit,
              quotaWindow,
            });
          }}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {isAnthropic && (
        <div role="alert" className="card-sub anthropic-pool-card__notice">
          {t("anthropicPool.experimentalWarning")}
        </div>
      )}

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>
          {t(isAnthropic ? "anthropicPool.needTwoAccounts" : "genericPool.needTwoAccounts")}
        </div>
      )}

      {enabled && state && (
        <>
          {(isAnthropic || strategy === "fill-first") && (
          <label className="field anthropic-pool-card__field">
            <span className="field-label">{t(isAnthropic ? "anthropicPool.threshold" : "genericPool.threshold")}</span>
            <input
              className="input mono"
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft}
              disabled={saving || strategyInert}
              aria-label={t(isAnthropic ? "anthropicPool.thresholdAria" : "genericPool.thresholdAria")}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                const parsed = Number(draft);
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
                  setDraft(String(threshold));
                  setError(t("anthropicPool.thresholdInvalid"));
                  return;
                }
                if (parsed !== threshold) {
                  void save({
                    enabled: true,
                    threshold: parsed,
                    strategy,
                    stickyLimit,
                    quotaWindow,
                  });
                }
              }}
            />
            <div className="card-sub" style={{ marginTop: 4 }}>
              {t(isAnthropic ? "anthropicPool.thresholdHelp" : "genericPool.thresholdHelp")}
            </div>
          </label>
          )}

          <AccountPoolStrategyControls
            strategy={strategy}
            allowResetFirst={!isAnthropic}
            compact={!isAnthropic}
            stickyDraft={stickyDraft}
            disabled={saving || strategyInert}
            strategySelectId={controlId(provider, "strategy")}
            stickyInputId={controlId(provider, "sticky-limit")}
            onStrategyChange={(next) => {
              if (next === strategy) return;
              void save({
                enabled: true,
                threshold,
                strategy: next,
                stickyLimit,
                quotaWindow,
              });
            }}
            onStickyDraftChange={setStickyDraft}
            onStickyCommit={(nextDraft) => {
              const parsed = parseAccountPoolStickyLimitDraft(nextDraft ?? stickyDraft);
              if (parsed === null) {
                setStickyDraft(String(stickyLimit));
                setError(t("accountPool.stickyLimitInvalid"));
                return;
              }
              if (parsed === stickyLimit) {
                setStickyDraft(String(parsed));
                return;
              }
              void save({
                enabled: true,
                threshold,
                strategy,
                stickyLimit: parsed,
                quotaWindow,
              });
            }}
          />

          {strategyInert && (
            <div className="card-sub" style={{ marginTop: 4 }}>
              {t("genericPool.visualStored")}
            </div>
          )}

          {isAnthropic && (
            <AccountPoolStrategyPreview
              strategy={strategy}
              threshold={previewThreshold}
              kind="anthropic"
              enabled={enabled}
            />
          )}

          {showQuotaWindow && (
            <div className="field anthropic-pool-card__field anthropic-pool-card__field--quota-window">
              <span className="field-label">{t("accountPool.quotaWindow")}</span>
              <Select
                id={controlId(provider, "quota-window")}
                value={quotaWindow}
                options={ACCOUNT_POOL_QUOTA_WINDOWS.map((value) => ({
                  value,
                  label: t(QUOTA_WINDOW_LABEL_KEYS[value]),
                }))}
                disabled={saving || quotaWindowInert}
                label={t("accountPool.quotaWindow")}
                onChange={(next) => {
                  const parsed = normalizeAccountPoolQuotaWindow(next);
                  if (parsed === quotaWindow) return;
                  void save({
                    enabled: true,
                    threshold,
                    strategy,
                    stickyLimit,
                    quotaWindow: parsed,
                  });
                }}
              />
              <div className="card-sub" style={{ marginTop: 4 }}>{t("accountPool.quotaWindowDesc")}</div>
              <div className="card-sub" style={{ marginTop: 4 }}>
                {quotaWindowInert ? t("accountPool.quotaWindowInert") : t("accountPool.quotaWindowHint")}
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--danger, #c44)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
