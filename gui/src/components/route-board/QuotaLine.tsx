import { formatProviderDisplayName } from "../../provider-icons";
import { useT, type TFn, type TKey } from "../../i18n/shared";
import { quotaFamilyWindow, type ProviderQuotaLine, type QuotaWindowView } from "../../route-board-model";

const WINDOW_NAME_KEYS: Partial<Record<TKey, TKey>> = {
  "quota.weeklyLimit": "routeBoard.window.weekly",
  "quota.fiveHourLimit": "routeBoard.window.fiveHour",
  "quota.monthlyLimit": "routeBoard.window.monthly",
};

function windowName(window: QuotaWindowView, t: TFn): string {
  const key = window.labelKey ? WINDOW_NAME_KEYS[window.labelKey] ?? window.labelKey : undefined;
  if (key) return t(key);
  const pool = quotaFamilyWindow(window.label ?? "");
  if (pool) return t("routeBoard.quota.family", { family: pool.family, window: t(pool.weekly ? "routeBoard.window.weekly" : "routeBoard.window.fiveHour") });
  return window.label ?? window.id;
}

/** "Anthropic (2 accounts): weekly 51% left · 5h 83% left · Anthropic API: metered" */
export function QuotaLine({ quotas, labels }: { quotas: readonly ProviderQuotaLine[]; labels?: ReadonlyMap<string, string> }) {
  const t = useT();
  return (
    <span className="rb-quota">
      {quotas.map((line) => {
        const name = labels?.get(line.provider) ?? formatProviderDisplayName(line.provider, t);
        const quota = line.quota;
        return (
          <span key={line.provider} className="rb-quota-item">
            <span className="rb-quota-provider">
              {line.accounts !== undefined && line.accounts.active > 0
                ? t("routeBoard.quota.accounts", { provider: name, count: line.accounts.active })
                : name}
              {line.accounts !== undefined && line.accounts.paused > 0 && (
                <span className="rb-quota-muted"> {t("routeBoard.quota.paused", { count: line.accounts.paused })}</span>
              )}
            </span>
            {quota.kind === "windows" && quota.windows.map((window) => (
              <span key={window.id} className={`rb-quota-window rb-tone-${window.tone}`}>
                {t("routeBoard.quota.left", {
                  window: windowName(window, t),
                  percent: Math.floor(window.remainingPercent),
                })}
              </span>
            ))}
            {quota.kind === "metered" && <span className="rb-quota-window rb-quota-muted">{t("routeBoard.quota.metered")}</span>}
            {quota.kind === "unknown" && <span className="rb-quota-window rb-quota-muted">{t("routeBoard.quota.unknown")}</span>}
          </span>
        );
      })}
    </span>
  );
}
