import { useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useT } from "../i18n/shared";
import type { ConfiguredProviderSummary } from "../models-groups";

/**
 * Off/On switch for a provider's opt-in Fast lane (Anthropic fast mode spends usage credits at 2x
 * price, so it ships off). Drawn only when the server reports `fastOptIn` for the provider.
 */
export function ProviderFastRow({ summary, apiBase, onSaved }: {
  summary: ConfiguredProviderSummary | undefined;
  apiBase: string;
  onSaved: (ok: boolean, message: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // The confirmed save wins until the reloaded summary moves off the value it was saved from, so
  // the control never falls back to a stale summary while (or if) the catalog reload is pending.
  const [saved, setSaved] = useState<{ value: boolean; from: boolean } | null>(null);
  const reported = summary?.fastOptIn?.enabled;
  // Once the summary moves off the value the save started from, the server has spoken; drop the
  // override so a later change by another client is shown as-is (render-time reset, no effect).
  if (saved && reported !== saved.from) setSaved(null);
  if (!summary?.fastOptIn) return null;
  const serverEnabled = summary.fastOptIn.enabled;
  const enabled = saved && saved.from === serverEnabled ? saved.value : serverEnabled;
  const save = async (next: boolean) => {
    if (busy || next === enabled) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(summary.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastEnabled: next }),
      });
      await readJsonOrThrow(response, t("models.fastSaveFailed"));
      setSaved({ value: next, from: serverEnabled });
      onSaved(true, t(next ? "models.fastEnabled" : "models.fastDisabled"));
    } catch (error) {
      onSaved(false, error instanceof Error ? error.message : t("models.fastSaveFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row models-provider-hint">
      <span className="muted text-label">{t("models.fastProvider")}</span>
      <div className="segmented models-segmented" role="radiogroup" aria-label={t("models.fastProvider")}>
        {([false, true] as const).map(mode => (
          <button key={String(mode)} type="button" role="radio" aria-checked={enabled === mode}
            className={`btn btn-sm${enabled === mode ? " btn-primary" : " btn-ghost"}`}
            disabled={busy} onClick={() => void save(mode)}>
            {t(mode ? "models.newPolicy_on" : "models.newPolicy_off")}
          </button>
        ))}
      </div>
      <span className="muted text-caption">{t("models.fastProviderHint")}</span>
    </div>
  );
}
