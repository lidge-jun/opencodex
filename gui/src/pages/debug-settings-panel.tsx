import { useI18n } from "../i18n/shared";
import { Switch } from "../ui";
import { card, cardHint, cardTitle, quietButton } from "../components/v2-logs/classes";
import type { DebugSettings } from "./debug-shared";
import { isDebugFlagEnabled } from "./debug-shared";

const FLAGS = ["debug", "usage", "injection", "claude"] as const;

/*
 * The four debug switches as one settings card: what the tab is for in one line, then a
 * switch row per stream. Turning a stream on is what fills the live tail below.
 */
export function DebugSettingsPanel({
  debug,
  debugBusy,
  onSetFlag,
  onReset,
}: {
  debug: DebugSettings;
  debugBusy: boolean;
  onSetFlag: (flag: "debug" | "usage" | "injection" | "claude", enabled: boolean) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();

  return (
    <section className={card} aria-labelledby="debug-logging-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
          <h3 id="debug-logging-title" className={cardTitle}>{t("logsV2.debugLogging")}</h3>
          <p className={cardHint}>{t("debug.subtitle")}</p>
        </div>
        <button type="button" className={quietButton} disabled={debugBusy} onClick={onReset}>
          {t("debug.reset")}
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {FLAGS.map(flag => {
          const checked = isDebugFlagEnabled(debug, flag);
          return (
            <div
              key={flag}
              className="flex min-w-0 items-center gap-3 rounded-[10px] bg-bg px-3 py-2.5 ring-1 ring-inset ring-line"
            >
              <Switch
                on={checked}
                disabled={debugBusy}
                label={t(`debug.${flag}`)}
                onClick={() => onSetFlag(flag, !checked)}
              />
              <span className="min-w-0 text-[13px] font-medium text-fg">{t(`debug.${flag}`)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Standalone page title; the embedded tab already sits under the Logs & Debug heading. */
export function DebugPageHeader({ embedded }: { embedded?: boolean }) {
  const { t } = useI18n();
  if (embedded) return null;
  return (
    <div className="page-head">
      <h2>{t("debug.title")}</h2>
    </div>
  );
}
