/**
 * Opt-in Anthropic OAuth account pool controls (#294).
 * Experimental — shows a strong warning because the feature is not battle-tested.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/shared";

type PoolState = {
  enabled: boolean;
  threshold: number;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/oauth/accounts/pool?provider=anthropic`, {
          signal: ac.signal,
        });
        if (!res.ok) throw new Error("load");
        const json = await res.json() as { enabled?: boolean; autoSwitchThreshold?: number };
        if (cancelled) return;
        const nextEnabled = json.enabled === true;
        const nextThreshold = typeof json.autoSwitchThreshold === "number" ? json.autoSwitchThreshold : 80;
        setState({ enabled: nextEnabled, threshold: nextThreshold });
        setDraft(String(nextThreshold));
        setLoadError(false);
      } catch {
        if (cancelled || ac.signal.aborted) return;
        setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [apiBase]);

  const save = useCallback(async (nextEnabled: boolean, nextThreshold: number) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: nextEnabled,
          autoSwitchThreshold: nextThreshold,
        }),
      });
      if (!res.ok) throw new Error("save");
      setState({ enabled: nextEnabled, threshold: nextThreshold });
      setDraft(String(nextThreshold));
    } catch {
      setError(t("anthropicPool.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [apiBase, t]);

  const enabled = state?.enabled === true;
  const threshold = state?.threshold ?? 80;
  const loading = state === null && !loadError;
  // Always allow turning the pool off; only block enabling when fewer than 2 accounts.
  const toggleDisabled = loading || saving || loadError || (!enabled && accountCount < 2);

  return (
    <div className="card" style={{ marginTop: 12 }} aria-busy={loading || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t("anthropicPool.title")}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {loadError
              ? t("anthropicPool.loadFailed")
              : loading
                ? t("common.loading")
                : enabled
                  ? t("anthropicPool.enabledDesc", { threshold })
                  : t("anthropicPool.disabledDesc")}
          </div>
        </div>
        <label className="toggle" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={toggleDisabled}
            onChange={(event) => {
              const next = event.target.checked;
              void save(next, threshold);
            }}
          />
          <span>{enabled ? t("anthropicPool.on") : t("anthropicPool.off")}</span>
        </label>
      </div>

      <div
        role="alert"
        className="card-sub"
        style={{
          marginTop: 10,
          padding: "8px 10px",
          border: "1px solid var(--border, #c9a227)",
          borderRadius: 6,
          background: "color-mix(in srgb, var(--warn, #c9a227) 12%, transparent)",
        }}
      >
        {t("anthropicPool.experimentalWarning")}
      </div>

      {accountCount < 2 && (
        <div className="card-sub" style={{ marginTop: 8 }}>{t("anthropicPool.needTwoAccounts")}</div>
      )}

      {enabled && (
        <label className="field" style={{ display: "block", marginTop: 12 }}>
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
              if (parsed !== threshold) void save(true, parsed);
            }}
          />
          <div className="card-sub" style={{ marginTop: 4 }}>{t("anthropicPool.thresholdHelp")}</div>
        </label>
      )}

      {error && (
        <div role="alert" className="card-sub" style={{ marginTop: 8, color: "var(--danger, #c44)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
