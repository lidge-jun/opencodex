import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useT, type TKey } from "../../i18n/shared";
import {
  buildQuotaTable, formatCountdown,
  type AccountFlag, type PoolCell, type PoolKey, type QuotaTableAccount, type QuotaTableRow,
} from "../../provider-workspace/account-quota-table";
import "./account-quota-table.css";

const FLAG_TONE: Record<AccountFlag, "ok" | "warn" | "muted" | "danger"> = {
  banned: "danger", verify: "warn", ok: "ok", slow: "warn", stale: "muted", warning: "warn", probeFailed: "warn",
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
      <span className="aqt-bar-value">{t("acctTable.left", { percent: remaining })}</span>
      <span className="aqt-bar-reset">{countdown ? t("acctTable.resetsIn", { time: countdown }) : ""}</span>
    </div>
  );
}

/** One line in place of the quota cells: the account is refused upstream, so its numbers are moot. */
function BannedNotice({ banned }: { banned: NonNullable<QuotaTableAccount["banned"]> }) {
  const t = useT();
  const when = typeof banned.pausedAt === "number" && Number.isFinite(banned.pausedAt) ? new Date(banned.pausedAt).toLocaleString() : null;
  return (
    <details className="aqt-banned">
      <summary>
        <span className="aqt-banned-text">{t("acctTable.bannedRow")}</span>
        <span className="aqt-banned-more">{t("acctTable.bannedReason")}</span>
      </summary>
      <p>{banned.message?.trim() || t("accountPause.reason.permissionDenied")}</p>
      {(when || banned.statusCode) && (
        <p className="faint">{[when, banned.statusCode ? `HTTP ${banned.statusCode}` : null].filter(Boolean).join(" · ")}</p>
      )}
    </details>
  );
}

export interface AccountQuotaTableProps {
  accounts: readonly QuotaTableAccount[];
  /** The pool's effective strategy; the `next` marker shows only under reset-first. */
  strategy?: string;
  /** Supplies the account control, actions column, and full-width detail content for each row. */
  renderRowContent?: (row: QuotaTableRow) => { account: ReactNode; actions: ReactNode; details: ReactNode };
}

function hasContent(node: ReactNode): boolean {
  if (node === null || node === undefined || node === false || node === "") return false;
  return !Array.isArray(node) || node.some(hasContent);
}

/**
 * The one account list of a multi-account provider: plan, each quota pool's 5-hour and weekly
 * remaining with a reset countdown, a status flag and, when the caller passes them, the row's
 * controls and a detail line. Below a container width the rows stack instead of scrolling, so
 * the controls never leave the screen.
 */
export function AccountQuotaTable({ accounts, strategy, renderRowContent }: AccountQuotaTableProps) {
  const t = useT();
  const now = useMinuteClock();
  const table = buildQuotaTable(accounts, now, strategy);
  if (table.rows.length === 0) return null;
  const flagText = (row: QuotaTableRow) => row.flag === "probeFailed"
    ? t(`acctProbe.status.${row.probeStatus}` as TKey)
    : t(`acctTable.flag.${row.flag}` as TKey);
  const poolLabel = (key: PoolKey) => t(`acctTable.pool.${key}` as TKey);
  const columns = 3 + table.pools.length + (renderRowContent ? 1 : 0);
  return (
    <div className="aqt" data-testid="account-quota-table">
      <div className="aqt-scroll">
        <table className="aqt-table" aria-label={t("acctTable.title")}>
          <thead>
            <tr>
              <th scope="col">{t("acctTable.account")}</th>
              <th scope="col">{t("acctTable.plan")}</th>
              {table.pools.map(pool => (
                <th scope="col" key={pool.key}>
                  {poolLabel(pool.key)}
                  {pool.scarce && <span className="badge badge-amber aqt-scarce">{t("acctTable.scarce")}</span>}
                </th>
              ))}
              <th scope="col">{t("acctTable.status")}</th>
              {renderRowContent && <th scope="col" className="aqt-actions-cell"><span className="sr-only">{t("acctTable.actions")}</span></th>}
            </tr>
          </thead>
          {table.rows.map(row => {
            const content = renderRowContent?.(row);
            // No pool column to carry the notice (a refused account rarely has a quota reading),
            // so it goes on the detail line instead of being lost behind the status flag.
            const bannedLine = table.pools.length === 0 && row.account.banned ? <BannedNotice banned={row.account.banned} /> : null;
            const withDetails = bannedLine !== null || hasContent(content?.details);
            return (
              <tbody key={row.account.id} className={`aqt-group${row.account.active ? " aqt-group--active" : ""}${withDetails ? " aqt-group--details" : ""}`} data-flag={row.flag}>
                <tr className="aqt-row">
                  <th scope="row" className="aqt-account">
                    {content ? content.account : <>
                      <span className={`pwi-auth-dot ${row.account.active && !row.account.paused ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      {row.account.label}
                    </>}
                  </th>
                  <td className="aqt-plan">
                    {row.plan
                      ? <span className="badge badge-green" title={row.account.plan ? t("acctTable.planSource", { tier: row.account.plan }) : undefined}>{row.plan}</span>
                      : <span className="badge badge-muted">{t("acctTable.unknownPlan")}</span>}
                  </td>
                  {table.pools.length > 0 && (row.account.banned
                    ? <td colSpan={table.pools.length} className="aqt-pool aqt-pool--banned"><BannedNotice banned={row.account.banned} /></td>
                    : Object.keys(row.cells).length === 0
                    ? <td colSpan={table.pools.length} className="aqt-pool aqt-pool--empty faint">{t("acctTable.noReading")}</td>
                    : table.pools.map(pool => {
                      const cell = row.cells[pool.key];
                      return (
                        <td key={pool.key} className="aqt-pool">
                          {/* The card layout hides the table header, so each pool names itself on its
                              own line above its 5-hour and weekly bars, as v2.100.5 stacked them. The
                              header still names the column for assistive technology. */}
                          <span className="aqt-pool-label" aria-hidden="true">{poolLabel(pool.key)}</span>
                          {cell ? <>
                            {cell.fiveHour && <PoolBar label={t("acctTable.fiveHour")} cell={cell.fiveHour} now={now} />}
                            {cell.weekly && <PoolBar label={t("acctTable.weekly")} cell={cell.weekly} now={now} />}
                            {row.next.includes(pool.key) && <span className="badge badge-primary aqt-next" title={t("acctTable.nextHint")}>{t("acctTable.next")}</span>}
                          </> : <span className="faint" title={t("acctTable.noReading")}>—</span>}
                        </td>
                      );
                    }))}
                  <td className="aqt-status"><span className={`aqt-flag aqt-flag--${FLAG_TONE[row.flag]}`}>{flagText(row)}</span></td>
                  {content && <td className="aqt-actions-cell"><div className="aqt-actions">{content.actions}</div></td>}
                </tr>
                {withDetails && (
                  <tr className="aqt-detail-row">
                    <td colSpan={columns} className="aqt-detail">{bannedLine}{content?.details}</td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}
