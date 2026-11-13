import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useT, type TKey } from "../../i18n/shared";
import {
  buildQuotaTable, formatCountdown,
  type AccountFlag, type PoolCell, type PoolKey, type QuotaTableAccount, type QuotaTableRow,
} from "../../provider-workspace/account-quota-table";
import "./account-quota-table.css";

const FLAG_TONE: Record<AccountFlag, "ok" | "warn" | "muted"> = {
  ok: "ok", slow: "warn", stale: "muted", warning: "warn", probeFailed: "warn",
  rateLimited: "warn", quotaLimited: "warn", reauth: "warn", paused: "muted",
};

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function PoolBar({ label, cell, now }: { label: string; cell: PoolCell; now: number }) {
  const t = useT();
  const remaining = Math.round(cell.remaining);
  const tone = remaining <= 20 ? "bar-warn" : "bar-green";
  const countdown = cell.resetAt === undefined ? null : formatCountdown(cell.resetAt, now);
  return (
    <div className="aqt-bar" title={cell.resetAt === undefined ? undefined : new Date(cell.resetAt).toLocaleString()}>
      <span className="aqt-bar-label">{label}</span>
      <div className="bar"><div className={`bar-fill ${tone}`} style={{ "--bar-scale": remaining / 100 } as CSSProperties} /></div>
      <span className="aqt-bar-value">{remaining}%</span>
      <span className="aqt-bar-reset">{countdown ? t("acctTable.resetsIn", { time: countdown }) : ""}</span>
    </div>
  );
}

export interface AccountQuotaTableProps {
  accounts: readonly QuotaTableAccount[];
  /** Pause/resume through the provider's existing account API; omitted hides the button. */
  onTogglePause?: (accountId: string, paused: boolean) => void;
  pauseDisabled?: boolean;
  /** Per-account probe button (the existing read-only probe), when the provider supports it. */
  renderProbe?: (account: QuotaTableAccount) => ReactNode;
}

/**
 * Every account of one provider side by side: plan, each quota pool's 5-hour and weekly
 * remaining with a reset countdown, and one status flag. Actions reuse the existing account
 * APIs; the table adds no endpoint.
 */
export function AccountQuotaTable({ accounts, onTogglePause, pauseDisabled, renderProbe }: AccountQuotaTableProps) {
  const t = useT();
  const now = useMinuteClock();
  const table = buildQuotaTable(accounts, now);
  if (table.rows.length === 0 || table.pools.length === 0) return null;
  const flagText = (row: QuotaTableRow) => row.flag === "probeFailed"
    ? t(`acctProbe.status.${row.probeStatus}` as TKey)
    : t(`acctTable.flag.${row.flag}` as TKey);
  const poolLabel = (key: PoolKey) => t(`acctTable.pool.${key}` as TKey);
  return (
    <div className="aqt" data-testid="account-quota-table">
      <p className="aqt-policy faint">{t("acctTable.policy")}</p>
      <div className="aqt-scroll">
        <table className="aqt-table">
          <thead>
            <tr>
              <th scope="col">{t("acctTable.account")}</th>
              <th scope="col">{t("acctTable.plan")}</th>
              {table.pools.map(pool => (
                <th scope="col" key={pool.key}>
                  {poolLabel(pool.key)}
                  {pool.scarce && <span className="aqt-scarce">{t("acctTable.scarce")}</span>}
                </th>
              ))}
              <th scope="col">{t("acctTable.status")}</th>
              {(onTogglePause || renderProbe) && <th scope="col">{t("acctTable.actions")}</th>}
            </tr>
          </thead>
          <tbody>
            {table.rows.map(row => (
              <tr key={row.account.id} className={row.account.active ? "aqt-row--active" : undefined} data-flag={row.flag}>
                <th scope="row" className="aqt-account">
                  <span className={`pwi-auth-dot ${row.account.active && !row.account.paused ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                  {row.account.label}
                </th>
                <td>
                  {row.plan
                    ? <span className="badge badge-green" title={row.account.plan ? t("acctTable.planSource", { tier: row.account.plan }) : undefined}>{row.plan}</span>
                    : <span className="badge badge-muted">{t("acctTable.unknownPlan")}</span>}
                </td>
                {table.pools.map(pool => {
                  const cell = row.cells[pool.key];
                  return (
                    <td key={pool.key} className="aqt-pool">
                      {cell ? <>
                        {cell.fiveHour && <PoolBar label={t("acctTable.fiveHour")} cell={cell.fiveHour} now={now} />}
                        {cell.weekly && <PoolBar label={t("acctTable.weekly")} cell={cell.weekly} now={now} />}
                        {row.next.includes(pool.key) && <span className="badge badge-primary aqt-next" title={t("acctTable.nextHint")}>{t("acctTable.next")}</span>}
                      </> : <span className="faint">{t("acctTable.noReading")}</span>}
                    </td>
                  );
                })}
                <td><span className={`aqt-flag aqt-flag--${FLAG_TONE[row.flag]}`}>{flagText(row)}</span></td>
                {(onTogglePause || renderProbe) && (
                  <td className="aqt-actions">
                    {onTogglePause && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={pauseDisabled}
                        aria-label={`${t(row.account.paused ? "codexAuth.resume" : "codexAuth.pause")} — ${row.account.label}`}
                        onClick={() => onTogglePause(row.account.id, !row.account.paused)}>
                        {t(row.account.paused ? "codexAuth.resume" : "codexAuth.pause")}
                      </button>
                    )}
                    {renderProbe?.(row.account)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
