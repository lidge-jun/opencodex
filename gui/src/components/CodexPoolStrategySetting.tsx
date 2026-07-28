import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  putCodexPoolStrategy,
  type AccountPoolStrategy,
} from "../account-pool-strategy";
import AccountPoolStrategyControls from "./AccountPoolStrategyControls";

/**
 * Codex account-pool rotation strategy controls.
 * Reads GET /api/codex-auth/active; writes PUT /api/codex-auth/pool-strategy.
 */
export default function CodexPoolStrategySetting({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [strategy, setStrategy] = useState<AccountPoolStrategy | null>(null);
  const [stickyLimit, setStickyLimit] = useState(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyServer = useCallback((json: {
    accountPoolStrategy?: unknown;
    accountPoolStickyLimit?: unknown;
  }) => {
    const nextStrategy = normalizeAccountPoolStrategy(json.accountPoolStrategy);
    const nextSticky = normalizeAccountPoolStickyLimit(json.accountPoolStickyLimit);
    setStrategy(nextStrategy);
    setStickyLimit(nextSticky);
    setStickyDraft(String(nextSticky));
    setLoadError(false);
    setError(null);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/codex-auth/active`);
      if (!res.ok) throw new Error("load");
      applyServer(await res.json() as {
        accountPoolStrategy?: unknown;
        accountPoolStickyLimit?: unknown;
      });
    } catch {
      setLoadError(true);
    }
  }, [apiBase, applyServer]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/codex-auth/active`);
        if (!res.ok) throw new Error("load");
        const json = await res.json() as {
          accountPoolStrategy?: unknown;
          accountPoolStickyLimit?: unknown;
        };
        if (cancelled) return;
        applyServer(json);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, applyServer]);

  const save = useCallback(async (next: {
    strategy?: AccountPoolStrategy;
    stickyLimit?: number;
  }) => {
    const previousStrategy = strategy;
    const previousSticky = stickyLimit;
    if (next.strategy !== undefined) setStrategy(next.strategy);
    if (next.stickyLimit !== undefined) {
      setStickyLimit(next.stickyLimit);
      setStickyDraft(String(next.stickyLimit));
    }
    setSaving(true);
    setError(null);
    const result = await putCodexPoolStrategy(apiBase, next);
    if (result.ok) {
      setStrategy(result.strategy);
      setStickyLimit(result.stickyLimit);
      setStickyDraft(String(result.stickyLimit));
    } else {
      setError(t("accountPool.strategyUpdateFailed"));
      if (previousStrategy) setStrategy(previousStrategy);
      setStickyLimit(previousSticky);
      setStickyDraft(String(previousSticky));
    }
    setSaving(false);
  }, [apiBase, stickyLimit, strategy, t]);

  const ready = strategy !== null;
  const loading = !ready && !loadError;

  return (
    <div className="card" style={{ marginTop: 16 }} aria-busy={loading || saving}>
      <strong>{t("accountPool.strategy")}</strong>
      <div className="card-sub" style={{ marginTop: 4 }} role={loadError ? "alert" : undefined}>
        {loadError
          ? t("accountPool.strategyLoadFailed")
          : loading
            ? t("common.loading")
            : t("accountPool.strategyDesc")}
      </div>
      {loadError && (
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => { void load(); }}>
          {t("common.retry")}
        </button>
      )}
      {ready && (
        <AccountPoolStrategyControls
          strategy={strategy}
          stickyDraft={stickyDraft}
          disabled={saving}
          strategySelectId="codex-pool-strategy"
          stickyInputId="codex-pool-sticky-limit"
          onStrategyChange={(next) => {
            if (next === strategy) return;
            void save({ strategy: next });
          }}
          onStickyDraftChange={setStickyDraft}
          onStickyCommit={() => {
            const parsed = parseAccountPoolStickyLimitDraft(stickyDraft);
            if (parsed === null) {
              setStickyDraft(String(stickyLimit));
              setError(t("accountPool.stickyLimitInvalid"));
              return;
            }
            if (parsed === stickyLimit) {
              setStickyDraft(String(parsed));
              return;
            }
            void save({ stickyLimit: parsed });
          }}
        />
      )}
      {error && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--danger, #c44)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
