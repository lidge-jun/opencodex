import { useId, useState } from "react";
import { useT } from "../i18n/shared";
import { clampNumberDraft } from "../clamp-draft";
import {
  QUOTA_LIVE_REFRESH_MAX_SECONDS as MAX_SECONDS,
  QUOTA_LIVE_REFRESH_MIN_SECONDS as MIN_SECONDS,
  useQuotaLiveRefreshPref,
  writeQuotaLiveRefreshPref,
} from "../quota-live-refresh-pref";
import { NumberStepper } from "./NumberStepper";

/** "Live quota updates": this browser's switch and interval for re-reading quota bars. */
export default function QuotaLiveRefreshSetting() {
  const t = useT();
  const descId = useId();
  const pref = useQuotaLiveRefreshPref();
  const [draft, setDraft] = useState(String(pref.intervalSeconds));
  // Follow a change saved elsewhere (another tab, or this row's own commit).
  const [shownSeconds, setShownSeconds] = useState(pref.intervalSeconds);
  if (shownSeconds !== pref.intervalSeconds) {
    setShownSeconds(pref.intervalSeconds);
    setDraft(String(pref.intervalSeconds));
  }

  // Empty or non-numeric input keeps the saved interval and a number outside the range is
  // clamped; either way the field then shows the interval actually in effect.
  const commit = (value: string) => {
    const seconds = value.trim() === "" ? Number.NaN : Number(value);
    const saved = Number.isFinite(seconds) ? writeQuotaLiveRefreshPref({ ...pref, intervalSeconds: seconds }) : pref;
    setDraft(String(saved.intervalSeconds));
  };

  return (
    <div className="card card-row codex-auto-switch-card">
      <div className="codex-auto-switch-copy">
        <strong>{t("quotaLive.title")}</strong>
        <div id={descId} className="card-sub">{t("quotaLive.hint")}</div>
      </div>
      <div className="codex-auto-switch-controls">
        <label className="codex-auto-switch-threshold">
          <span className="field-label">{t("quotaLive.interval")}</span>
          <span className="codex-auto-switch-input-wrap">
            <input
              className="input mono codex-auto-switch-input"
              type="number"
              min={MIN_SECONDS}
              max={MAX_SECONDS}
              step={1}
              inputMode="numeric"
              value={draft}
              disabled={!pref.enabled}
              aria-label={t("quotaLive.intervalAria", { min: MIN_SECONDS, max: MAX_SECONDS })}
              aria-describedby={descId}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={(event) => commit(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit(event.currentTarget.value);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(String(pref.intervalSeconds));
                }
              }}
            />
            <span className="codex-auto-switch-unit" aria-hidden="true">{t("quotaLive.unit")}</span>
            <NumberStepper
              disabled={!pref.enabled}
              incrementLabel={t("quotaLive.intervalInc")}
              decrementLabel={t("quotaLive.intervalDec")}
              onIncrement={() => commit(clampNumberDraft(draft, 5, MIN_SECONDS, MAX_SECONDS))}
              onDecrement={() => commit(clampNumberDraft(draft, -5, MIN_SECONDS, MAX_SECONDS))}
            />
          </span>
        </label>
        <span className="codex-auto-switch-toggle-slot">
          <button
            type="button"
            className={`toggle ${pref.enabled ? "on" : ""}`}
            onClick={() => { writeQuotaLiveRefreshPref({ ...pref, enabled: !pref.enabled }); }}
            aria-pressed={pref.enabled}
            aria-label={t("quotaLive.title")}
            aria-describedby={descId}
            title={t("quotaLive.title")}
          >
            <span className="toggle-knob" />
          </button>
        </span>
      </div>
    </div>
  );
}
