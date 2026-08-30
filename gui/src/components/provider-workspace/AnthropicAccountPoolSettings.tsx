/**
 * Opt-in Anthropic OAuth account pool controls (#294).
 * Experimental — shows a strong warning because the feature is not battle-tested.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
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
};

export default function AnthropicAccountPoolSettings({
  apiBase,
  accountCount,
}: {
  apiBase: string;
  accountCount: number;
}) {
  const t = useT();
  const [state, setState] = useState<PoolState | null>(null);
  const [draft, setDraft] = useState("80");
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    // Promise chain rather than async/await: every setter then lives in a `.then`
    // callback guarded by the same `cancelled` flag, which is the shape static analysis
    // (react-doctor no-set-state-after-await-in-effect) can actually verify. The
    // behaviour is unchanged — the guard and the abort controller were already here.
    //
    // Deferred by a microtask, not a timer: a timer had to be cancelled in cleanup, so a
    // mount-then-unmount dropped the request entirely. The abort controller already covers
    // in-flight cancellation, which is the part that actually needs to be cancellable.
    void Promise.resolve()
      .then(() => fetch(`${apiBase}/api/oauth/accounts/pool?provider=anthropic`, { signal: ac.signal }))
      .then(res => {
        if (!res.ok) throw new Error("load");
        return res.json() as Promise<{
          enabled?: boolean;
          autoSwitchThreshold?: number;
          strategy?: unknown;
          stickyLimit?: unknown;
          quotaWindow?: unknown;
        }>;
      })
      .then(json => {
        if (cancelled) return;
        const nextThreshold = typeof json.autoSwitchThreshold === "number" ? json.autoSwitchThreshold : 80;
        const nextSticky = normalizeAccountPoolStickyLimit(json.stickyLimit);
        setState({
          enabled: json.enabled === true,
          threshold: nextThreshold,
          strategy: normalizeAccountPoolStrategy(json.strategy),
          stickyLimit: nextSticky,
          quotaWindow: normalizeAccountPoolQuotaWindow(json.quotaWindow),
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
  }, [apiBase]);

  const save = useCallback(async (next: {
    enabled: boolean;
    threshold: number;
    strategy: AccountPoolStrategy;
    stickyLimit: number;
    quotaWindow: AccountPoolQuotaWindow;
  }) => {
    const previousState = state;
    setState({
      enabled: next.enabled,
      threshold: next.threshold,
      strategy: next.strategy,
      stickyLimit: next.stickyLimit,
      quotaWindow: next.quotaWindow,
    });
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: next.enabled,
          autoSwitchThreshold: next.threshold,
          strategy: next.strategy,
          stickyLimit: next.stickyLimit,
          quotaWindow: next.quotaWindow,
        }),
      });
      if (!res.ok) throw new Error("save");
      const json = await res.json().catch(() => null) as {
        strategy?: unknown;
        stickyLimit?: unknown;
        quotaWindow?: unknown;
      } | null;
      const savedStrategy = normalizeAccountPoolStrategy(json?.strategy ?? next.strategy);
      const savedSticky = normalizeAccountPoolStickyLimit(json?.stickyLimit ?? next.stickyLimit);
      const savedWindow = normalizeAccountPoolQuotaWindow(json?.quotaWindow ?? next.quotaWindow);
      setState({
        enabled: next.enabled,
        threshold: next.threshold,
        strategy: savedStrategy,
        stickyLimit: savedSticky,
        quotaWindow: savedWindow,
      });
      setDraft(String(next.threshold));
      setStickyDraft(String(savedSticky));
    } catch {
      setError(t("anthropicPool.saveFailed"));
      if (previousState) {
        setState(previousState);
        setDraft(String(previousState.threshold));
        setStickyDraft(String(previousState.stickyLimit));
      }
    } finally {
      setSaving(false);
    }
  }, [apiBase, state, t]);

  const enabled = state?.enabled === true;
  const threshold = state?.threshold ?? 80;
  const strategy = state?.strategy ?? DEFAULT_ACCOUNT_POOL_STRATEGY;
  const stickyLimit = state?.stickyLimit ?? DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
  const quotaWindow = state?.quotaWindow ?? DEFAULT_ACCOUNT_POOL_QUOTA_WINDOW;
  // The window is inert ONLY under round-robin, which never scores a usage bar at any stage.
  //
  // A 0 threshold is not inertness: it disables PROACTIVE usage-based switching, but
  // new-session selection and 429 recovery still consult the configured window (see
  // pickLowestUsage / rotateAnthropicAccountOn429). Treating fill-first + threshold 0 as
  // inert told operators the window had no effect when it still governed two routing stages.
  const quotaWindowInert = strategy === "round-robin";
  const loading = state === null && !loadError;
  // Always allow turning the pool off; only block enabling when fewer than 2 accounts.
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);

  return (
    <div className="card anthropic-pool-card" aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t("anthropicPool.title")}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? t("anthropicPool.loadFailed")
              : loading
                ? t("common.loading")
                : enabled
                  ? threshold === 0
                    ? t("anthropicPool.enabledNoProactiveDesc", {
                        window: t(QUOTA_WINDOW_LABEL_KEYS[quotaWindow]),
                      })
                    : t("anthropicPool.enabledDesc", {
                        threshold,
                        window: t(QUOTA_WINDOW_LABEL_KEYS[quotaWindow]),
                      })
                  : t("anthropicPool.disabledDesc")}
          </div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={toggleDisabled}
          aria-pressed={enabled}
          aria-label={t("anthropicPool.title")}
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

      <div role="alert" className="card-sub anthropic-pool-card__notice">
        {t("anthropicPool.experimentalWarning")}
      </div>

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>{t("anthropicPool.needTwoAccounts")}</div>
      )}

      {enabled && state && (
        <>
          <label className="field anthropic-pool-card__field">
            <span className="field-label">{t("anthropicPool.threshold")}</span>
            <input
              className="input mono"
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft}
              disabled={saving}
              aria-label={t("anthropicPool.thresholdAria")}
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
            <div className="card-sub" style={{ marginTop: 4 }}>{t("anthropicPool.thresholdHelp")}</div>
          </label>

          <AccountPoolStrategyControls
            strategy={strategy}
            stickyDraft={stickyDraft}
            disabled={saving}
            strategySelectId="anthropic-pool-strategy"
            stickyInputId="anthropic-pool-sticky-limit"
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

          <div className="field anthropic-pool-card__field anthropic-pool-card__field--quota-window">
            <span className="field-label">{t("accountPool.quotaWindow")}</span>
            <Select
              id="anthropic-pool-quota-window"
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
