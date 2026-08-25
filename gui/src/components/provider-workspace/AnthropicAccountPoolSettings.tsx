/**
 * Shared OAuth account-pool controls for Anthropic and Google Antigravity.
 * Anthropic remains experimental and keeps its strong warning; Google does not.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  type AccountPoolStrategy,
} from "../../account-pool-strategy";
import AccountPoolStrategyControls from "../AccountPoolStrategyControls";

type PoolState = {
  enabled: boolean;
  threshold: number;
  strategy: AccountPoolStrategy;
  stickyLimit: number;
};

export default function AccountPoolSettings({
  apiBase,
  accountCount,
  provider = "anthropic",
}: {
  apiBase: string;
  accountCount: number;
  provider?: "anthropic" | "google-antigravity";
}) {
  const t = useT();
  const isGoogleAntigravity = provider === "google-antigravity";
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
      .then(() => fetch(`${apiBase}/api/oauth/accounts/pool?provider=${provider}`, { signal: ac.signal }))
      .then(res => {
        if (!res.ok) throw new Error("load");
        return res.json() as Promise<{
          enabled?: boolean;
          autoSwitchThreshold?: number;
          strategy?: unknown;
          stickyLimit?: unknown;
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
  }) => {
    const previousState = state;
    setState({
      enabled: next.enabled,
      threshold: next.threshold,
      strategy: next.strategy,
      stickyLimit: next.stickyLimit,
    });
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          enabled: next.enabled,
          autoSwitchThreshold: next.threshold,
          strategy: next.strategy,
          stickyLimit: next.stickyLimit,
        }),
      });
      if (!res.ok) throw new Error("save");
      const json = await res.json().catch(() => null) as {
        strategy?: unknown;
        stickyLimit?: unknown;
      } | null;
      const savedStrategy = normalizeAccountPoolStrategy(json?.strategy ?? next.strategy);
      const savedSticky = normalizeAccountPoolStickyLimit(json?.stickyLimit ?? next.stickyLimit);
      setState({
        enabled: next.enabled,
        threshold: next.threshold,
        strategy: savedStrategy,
        stickyLimit: savedSticky,
      });
      setDraft(String(next.threshold));
      setStickyDraft(String(savedSticky));
    } catch {
      setError(t(isGoogleAntigravity ? "googleAntigravityPool.saveFailed" : "anthropicPool.saveFailed"));
      if (previousState) {
        setState(previousState);
        setDraft(String(previousState.threshold));
        setStickyDraft(String(previousState.stickyLimit));
      }
    } finally {
      setSaving(false);
    }
  }, [apiBase, isGoogleAntigravity, provider, state, t]);

  const enabled = state?.enabled === true;
  const threshold = state?.threshold ?? 80;
  const strategy = state?.strategy ?? DEFAULT_ACCOUNT_POOL_STRATEGY;
  const stickyLimit = state?.stickyLimit ?? DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
  const loading = state === null && !loadError;
  // Always allow turning the pool off; only block enabling when fewer than 2 accounts.
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);

  return (
    <div className="card" style={{ marginTop: 12 }} aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t(isGoogleAntigravity ? "googleAntigravityPool.title" : "anthropicPool.title")}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? t(isGoogleAntigravity ? "googleAntigravityPool.loadFailed" : "anthropicPool.loadFailed")
              : loading
                ? t("common.loading")
                : enabled
                  ? t(isGoogleAntigravity ? "googleAntigravityPool.enabledDesc" : "anthropicPool.enabledDesc", { threshold })
                  : t(isGoogleAntigravity ? "googleAntigravityPool.disabledDesc" : "anthropicPool.disabledDesc")}
          </div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={toggleDisabled}
          aria-pressed={enabled}
          aria-label={t(isGoogleAntigravity ? "googleAntigravityPool.title" : "anthropicPool.title")}
          title={enabled
            ? t(isGoogleAntigravity ? "googleAntigravityPool.on" : "anthropicPool.on")
            : t(isGoogleAntigravity ? "googleAntigravityPool.off" : "anthropicPool.off")}
          onClick={() => {
            void save({
              enabled: !enabled,
              threshold,
              strategy,
              stickyLimit,
            });
          }}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {!isGoogleAntigravity && (
        <div
          role="alert"
          className="card-sub"
          style={{
            marginTop: 10,
            padding: "10px 16px",
            border: "1px solid var(--border, #c9a227)",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--warn, #c9a227) 12%, transparent)",
          }}
        >
          {t("anthropicPool.experimentalWarning")}
        </div>
      )}

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>
          {t(isGoogleAntigravity ? "googleAntigravityPool.needTwoAccounts" : "anthropicPool.needTwoAccounts")}
        </div>
      )}

      {enabled && state && (
        <>
          <label className="field" style={{ display: "block", marginTop: 12 }}>
            <span className="field-label">
              {t(isGoogleAntigravity ? "googleAntigravityPool.threshold" : "anthropicPool.threshold")}
            </span>
            <input
              className="input mono"
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft}
              disabled={saving}
              aria-label={t(isGoogleAntigravity ? "googleAntigravityPool.thresholdAria" : "anthropicPool.thresholdAria")}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                const normalizedDraft = draft.trim();
                const parsed = Number(normalizedDraft);
                if (normalizedDraft.length === 0 || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
                  setDraft(String(threshold));
                  setError(t(isGoogleAntigravity
                    ? "googleAntigravityPool.thresholdInvalid"
                    : "anthropicPool.thresholdInvalid"));
                  return;
                }
                if (parsed !== threshold) {
                  void save({
                    enabled: true,
                    threshold: parsed,
                    strategy,
                    stickyLimit,
                  });
                }
              }}
            />
            <div className="card-sub" style={{ marginTop: 4 }}>
              {t(isGoogleAntigravity ? "googleAntigravityPool.thresholdHelp" : "anthropicPool.thresholdHelp")}
            </div>
          </label>

          <AccountPoolStrategyControls
            strategy={strategy}
            stickyDraft={stickyDraft}
            disabled={saving}
            strategySelectId={isGoogleAntigravity ? "google-antigravity-pool-strategy" : "anthropic-pool-strategy"}
            stickyInputId={isGoogleAntigravity ? "google-antigravity-pool-sticky-limit" : "anthropic-pool-sticky-limit"}
            onStrategyChange={(next) => {
              if (next === strategy) return;
              void save({
                enabled: true,
                threshold,
                strategy: next,
                stickyLimit,
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
              });
            }}
          />
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
