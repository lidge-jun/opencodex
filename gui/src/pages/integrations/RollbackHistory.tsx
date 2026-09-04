/**
 * The rollback journal, rendered so it cannot swamp the page it sits on.
 *
 * Both Integrations surfaces used to map the whole journal response into a flat
 * list of individually bordered rows: the overview showed the global journal and
 * every client tab showed the same journal filtered, so a user with a few dozen
 * toggles behind them got fifty bordered strips stacked under the real controls,
 * twice. The server caps the response at 50 rows and keeps only 10 restorable
 * snapshots per client, so most of what that list showed could not be undone.
 *
 * Three things fix it. The newest row stays visible, because it is the one a
 * user reaches for after a mistake. The rest go behind a collapsed disclosure,
 * revealed six at a time, the same page size ClaudeDesktop's lane uses. And the
 * rows share one boundary with separators instead of a border each, which is
 * what produced the stacked-strip texture.
 *
 * No total is displayed: the payload is capped and carries neither a total nor a
 * hasMore, so any number shown would be a claim we cannot support.
 */
import { useState } from "react";
import { useT } from "../../i18n/shared";
import type { IntegrationJournalRow } from "./integration-api";
import { JOURNAL_KIND_KEY } from "./overview-clients";

/** Matches LANE_PAGE in claude-desktop-lane.ts, the local precedent. */
const PAGE = 6;

export function RollbackRow({
  row,
  showClient,
  onRestore,
  onDelete,
}: {
  row: IntegrationJournalRow;
  /** The overview names the client; a client tab would only repeat its heading. */
  showClient?: boolean;
  onRestore: (row: IntegrationJournalRow) => void;
  /** Optional: a surface that cannot refresh the journal must not offer it. */
  onDelete?: (row: IntegrationJournalRow) => void;
}) {
  const t = useT();
  return (
    <li className="integration-history-row">
      <span className="integration-history-kind">{t(JOURNAL_KIND_KEY[row.kind])}</span>
      {showClient && <span className="integration-history-client">{row.clientId}</span>}
      <span className="integration-history-at">{new Date(row.at).toLocaleString()}</span>
      {row.snapshot === "expired" ? (
        // The only genuinely impossible case: the bytes are gone.
        <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRestore(row)}>
          {/*
            `undoable` chooses the WORDING, not whether the action exists.
            Disabling everything else made the drift confirmation unreachable: an
            older row, or one whose file changed since, is exactly what a user
            reaches for, and the server accepts it after an explicit confirm.
          */}
          {row.undoable ? t("integrations.action.undo") : t("integrations.action.restorePoint")}
        </button>
      )}
      {/*
        Delete sits AFTER restore, and only when the server says so. An expired
        row keeps its badge and gains this button -- that pairing is the point of
        the feature: a row whose bytes are gone was previously a dead entry with
        no action at all.
      */}
      {row.deletable && onDelete && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onDelete(row)}
          aria-label={t("integrations.rollback.deleteAria", { at: new Date(row.at).toLocaleString() })}
        >
          {t("integrations.rollback.delete")}
        </button>
      )}
    </li>
  );
}

export function RollbackHistory({
  rows,
  showClient,
  onRestore,
  onDelete,
}: {
  rows: readonly IntegrationJournalRow[];
  showClient?: boolean;
  onRestore: (row: IntegrationJournalRow) => void;
  onDelete?: (row: IntegrationJournalRow) => void;
}) {
  const t = useT();
  const [shown, setShown] = useState(PAGE);
  const [newest, ...older] = rows;
  if (!newest) return null;

  const visible = older.slice(0, shown);
  const remaining = older.length - visible.length;

  return (
    <div className="integration-history">
      <ul className="integration-history-list">
        {/*
          The newest row gets the prop too. The server answers `deletable: false`
          for it, so no button appears -- but withholding the prop here would make
          that rule depend on an omission rather than on the data.
        */}
        <RollbackRow row={newest} showClient={showClient} onRestore={onRestore} onDelete={onDelete} />
      </ul>
      {older.length > 0 && (
        <details className="integration-history-older">
          <summary>{t("integrations.rollback.older")}</summary>
          <ul className="integration-history-list">
            {visible.map(row => (
              <RollbackRow key={row.opId} row={row} showClient={showClient} onRestore={onRestore} onDelete={onDelete} />
            ))}
          </ul>
          {remaining > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm integration-history-more"
              onClick={() => setShown(count => count + PAGE)}
            >
              {t("integrations.rollback.showMore", { n: String(Math.min(remaining, PAGE)) })}
            </button>
          )}
        </details>
      )}
    </div>
  );
}
