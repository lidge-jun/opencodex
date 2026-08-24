/**
 * Opt-in Cursor OAuth account pool controls.
 * Experimental — shows a strong warning because the feature is not battle-tested.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/shared";

type PoolState = {
  enabled: boolean;
};

export default function CursorAccountPoolSettings({
  apiBase,
  accountCount,
}: {
  apiBase: string;
  accountCount: number;
}) {
  const t = useT();
  const [state, setState] = useState<PoolState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void Promise.resolve()
      .then(() => fetch(`${apiBase}/api/oauth/accounts/pool?provider=cursor`, { signal: ac.signal }))
      .then(res => {
        if (!res.ok) throw new Error("load");
        return res.json() as Promise<{ enabled?: boolean }>;
      })
      .then(json => {
        if (cancelled) return;
        setState({ enabled: json.enabled === true });
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

  const save = useCallback(async (next: PoolState) => {
    const previousState = state;
    setState(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "cursor",
          enabled: next.enabled,
        }),
      });
      if (!res.ok) throw new Error("save");
      setState(next);
    } catch {
      setError(t("cursorPool.saveFailed"));
      if (previousState) setState(previousState);
    } finally {
      setSaving(false);
    }
  }, [apiBase, state, t]);

  const enabled = state?.enabled === true;
  const loading = state === null && !loadError;
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);

  return (
    <div className="card" style={{ marginTop: 12 }} aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t("cursorPool.title")}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? t("cursorPool.loadFailed")
              : loading
                ? t("common.loading")
                : enabled
                  ? t("cursorPool.enabledDesc")
                  : t("cursorPool.disabledDesc")}
          </div>
        </div>
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          disabled={toggleDisabled}
          aria-pressed={enabled}
          aria-label={t("cursorPool.title")}
          title={enabled ? t("cursorPool.on") : t("cursorPool.off")}
          onClick={() => {
            void save({ enabled: !enabled });
          }}
        >
          <span className="toggle-knob" />
        </button>
      </div>

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
        {t("cursorPool.experimentalWarning")}
      </div>

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>{t("cursorPool.needTwoAccounts")}</div>
      )}

      {error && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--danger, #c44)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
