import { useI18n } from "../i18n/shared";
import { IconRefresh } from "../icons";
import { Switch } from "../ui";
import type { DebugSettings, LogStream } from "./debug-shared";
import { isDebugFlagEnabled } from "./debug-shared";

export function DebugSettingsPanel({
  debug,
  debugBusy,
  stream,
  onSetFlag,
  onReset,
  onStreamChange,
}: {
  debug: DebugSettings;
  debugBusy: boolean;
  stream: LogStream;
  onSetFlag: (flag: "debug" | "usage" | "injection" | "claude", enabled: boolean) => void;
  onReset: () => void;
  onStreamChange: (stream: LogStream) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          {(["debug", "usage", "injection", "claude"] as const).map(flag => {
            const checked = isDebugFlagEnabled(debug, flag);
            return (
              <div key={flag} style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 220 }}>
                <Switch
                  on={checked}
                  disabled={debugBusy}
                  label={t(`debug.${flag}`)}
                  onClick={() => onSetFlag(flag, !checked)}
                />
                <span className="text-control">{t(`debug.${flag}`)}</span>
              </div>
            );
          })}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={debugBusy} onClick={onReset}>
          {t("debug.reset")}
        </button>
      </div>

      {(debug.enabled || debug.usage || debug.injection) && (
        <div style={{ display: "inline-flex", gap: 6, marginTop: 12 }}>
          {debug.enabled && (
            <button
              type="button"
              className={`btn btn-sm${stream === "provider" ? " btn-primary" : " btn-ghost"}`}
              onClick={() => onStreamChange("provider")}
            >
              {t("debug.streamProvider")}
            </button>
          )}
          {debug.usage && (
            <button
              type="button"
              className={`btn btn-sm${stream === "usage" ? " btn-primary" : " btn-ghost"}`}
              onClick={() => onStreamChange("usage")}
            >
              {t("debug.streamUsage")}
            </button>
          )}
          {debug.injection && (
            <button
              type="button"
              className={`btn btn-sm${stream === "injection" ? " btn-primary" : " btn-ghost"}`}
              onClick={() => onStreamChange("injection")}
            >
              {t("debug.streamInjection")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DebugPageHeader({
  embedded,
  refreshing,
  streamEnabled,
  follow,
  onRefresh,
  onFollowChange,
}: {
  embedded?: boolean;
  refreshing: boolean;
  streamEnabled: boolean;
  follow: boolean;
  onRefresh: () => void;
  onFollowChange: (follow: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <div className={embedded ? "row" : "page-head"} style={embedded ? { justifyContent: "flex-end", marginBottom: 4 } : undefined}>
        {!embedded && <h2>{t("debug.title")}</h2>}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshing || !streamEnabled}
            onClick={onRefresh}
          >
            <IconRefresh /> {t("debug.refresh")}
          </button>
          <label className="muted text-control" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={follow} onChange={e => onFollowChange(e.target.checked)} />
            {t("debug.follow")}
          </label>
        </div>
      </div>
      <p className="page-sub">{t("debug.subtitle")}</p>
    </>
  );
}
