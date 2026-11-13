import { formatProviderDisplayName } from "../../provider-icons";
import { useT, type TFn, type TKey } from "../../i18n/shared";
import type { ProviderQuotaLine, QuotaWindowView } from "../../route-board-model";

const WINDOW_NAME_KEYS: Partial<Record<TKey, TKey>> = {
  "quota.weeklyLimit": "routeBoard.window.weekly",
  "quota.fiveHourLimit": "routeBoard.window.fiveHour",
  "quota.monthlyLimit": "routeBoard.window.monthly",
};

function windowName(window: QuotaWindowView, t: TFn): string {
  const key = window.labelKey ? WINDOW_NAME_KEYS[window.labelKey] ?? window.labelKey : undefined;
  return key ? t(key) : window.label ?? window.id;
}

/** "Anthropic (2 accounts): weekly 51% left · 5h 83% left · Anthropic API: metered" */
export function QuotaLine({ quotas, labels }: { quotas: readonly ProviderQuotaLine[]; labels?: ReadonlyMap<string, string> }) {
  const t = useT();
  return (
    <p className="rb-quota">
      {quotas.map((line) => {
        const name = labels?.get(line.provider) ?? formatProviderDisplayName(line.provider, t);
        const quota = line.quota;
        return (
          <span key={line.provider} className="rb-quota-item">
            <span className="rb-quota-provider">
              {quota.kind === "windows" && quota.accounts !== undefined
                ? t("routeBoard.quota.accounts", { provider: name, count: quota.accounts })
                : name}
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
    </p>
  );
}
