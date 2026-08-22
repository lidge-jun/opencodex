import { useCallback, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { useT, type TKey } from "../../i18n/shared";
import { Notice, Switch } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import RestoreDialog from "./RestoreDialog";
import { describeRefusal } from "./refusal-copy";
import {
  loadIntegrationJournal,
  loadIntegrationState,
  toggleIntegration,
  type FileIntegrationClientId,
  type IntegrationJournalRow,
  type IntegrationStatus,
} from "./integration-api";

export type { FileIntegrationClientId };

const SEMANTICS_KEY: Record<FileIntegrationClientId, TKey> = {
  opencode: "integrations.semantics.opencode",
  pi: "integrations.semantics.pi",
  omp: "integrations.semantics.omp",
  hermes: "integrations.semantics.hermes",
  openclaw: "integrations.semantics.openclaw",
  kimi: "integrations.semantics.kimi",
  gajae: "integrations.semantics.gajae",
  dsh: "integrations.semantics.dsh",
  mcode: "integrations.semantics.mcode",
  zcode: "integrations.semantics.zcode",
  prime: "integrations.semantics.prime",
};

const TAB_LABEL_KEY: Record<FileIntegrationClientId, TKey> = {
  opencode: "integrations.tab.opencode",
  pi: "integrations.tab.pi",
  omp: "integrations.tab.omp",
  hermes: "integrations.tab.hermes",
  openclaw: "integrations.tab.openclaw",
  kimi: "integrations.tab.kimi",
  gajae: "integrations.tab.gajae",
  dsh: "integrations.tab.dsh",
  mcode: "integrations.tab.mcode",
  zcode: "integrations.tab.zcode",
  prime: "integrations.tab.prime",
};

const KIND_KEY: Record<IntegrationJournalRow["kind"], TKey> = {
  apply: "integrations.kind.apply",
  disable: "integrations.kind.disable",
  refresh: "integrations.kind.refresh",
  restore: "integrations.kind.restore",
};

export default function FileIntegrationPage({
  apiBase,
  client,
  active = true,
}: {
  apiBase: string;
  client: FileIntegrationClientId;
  active?: boolean;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<IntegrationJournalRow | null>(null);

  const fetchState = useCallback(
    (signal: AbortSignal) => loadIntegrationState(apiBase, client, signal),
    [apiBase, client],
  );
  const fetchHistory = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationJournal(apiBase, client, signal)).operations,
    [apiBase, client],
  );

  const stateResource = useDataSurface<IntegrationStatus>(
    `integration-state:${apiBase}:${client}`,
    [apiBase, client],
    fetchState,
    {
      isEmpty: () => false,
      enabled: active,
      sessionCacheKey: `ocx.integrations.state.v1:${apiBase}:${client}`,
    },
  );
  const historyResource = useDataSurface<IntegrationJournalRow[]>(
    `integration-journal:${apiBase}:${client}`,
    [apiBase, client],
    fetchHistory,
    {
      isEmpty: rows => rows.length === 0,
      enabled: active,
      sessionCacheKey: `ocx.integrations.client-journal.v1:${apiBase}:${client}`,
    },
  );

  const status = stateResource.state.data ?? null;
  const history = historyResource.state.data ?? [];

  const refresh = () => {
    void stateResource.refresh();
    void historyResource.refresh();
  };

  const mutate = async (enabled: boolean) => {
    if (!status || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await toggleIntegration(apiBase, client, enabled);
      refresh();
    } catch (error) {
      setFailure(describeRefusal(t, error));
    } finally {
      setPending(false);
    }
  };

  /*
   * The switch means exactly what its label says.
   *
   * `stale` also means our block is in the file, so the switch reads applied —
   * but it once sent `enabled: true` for that state, which asked the server to
   * REFRESH while the control was labelled Disable. Turning a switch off has
   * to remove the block; updating a stale block is a separate action with its
   * own button below.
   */
  const toggle = () => void mutate(!(status && (status.state === "current" || status.state === "stale")));

  if (!status) {
    return (
      <section className="integration-client-page">
        {stateResource.state.kind === "failed-cold"
          ? <Notice tone="err">{t("integrations.error.load")}</Notice>
          : <p className="page-sub">{t("common.loading")}</p>}
      </section>
    );
  }

  const applied = status.state === "current" || status.state === "stale";
  // Conflict and unsafe are never auto-resolved: the switch is locked and the
  // user is told why, because the alternative is deleting an edit we do not own.
  const locked = !status.installed || status.state === "conflict" || status.state === "unsafe";

  return (
    <section className="integration-client-page">
      <div className="integration-client-head">
        <h3>{t(TAB_LABEL_KEY[client])}</h3>
        <IntegrationStateBadge
          state={status.state}
          installed={status.installed}
          id={`integration-state-${client}`}
        />
        <Switch
          on={applied}
          onClick={toggle}
          disabled={locked || pending}
          label={applied ? t("integrations.action.disable") : t("integrations.action.apply")}
        />
      </div>

      {/*
        Updating a stale block is its own action. Folding it into the switch
        made "off" mean "refresh", which is the opposite of what the control
        said it would do.
      */}
      {status.state === "stale" && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void mutate(true)}
          disabled={pending}
        >
          {t("integrations.action.refresh")}
        </button>
      )}

      <p className="page-sub">{t(SEMANTICS_KEY[client])}</p>
      <p className="integration-path">{status.configPath}</p>

      {status.appliedAt && (
        <p className="integration-meta">
          {t("integrations.status.appliedAt")}: {new Date(status.appliedAt).toLocaleString()}
        </p>
      )}
      {status.retentionDegraded && (
        <Notice tone="err">{t("integrations.retention.degraded")}</Notice>
      )}
      {failure && <Notice tone="err">{failure}</Notice>}

      <h4>{t("integrations.rollback.title")}</h4>
      {history.length === 0 ? (
        <p className="page-sub">{t("integrations.rollback.empty")}</p>
      ) : (
        <ul className="integration-history">
          {history.map(row => (
            <li key={row.opId}>
              <span className="integration-history-kind">{t(KIND_KEY[row.kind])}</span>
              <span className="integration-history-at">{new Date(row.at).toLocaleString()}</span>
              {row.snapshot === "expired" ? (
                // The only genuinely impossible case: the bytes are gone.
                <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setRestoring(row)}
                >
                  {/*
                    `undoable` chooses the WORDING, not whether the action
                    exists. Disabling everything else made the drift
                    confirmation unreachable: an older row, or one whose file
                    changed since, is exactly what a user reaches for, and the
                    server accepts it after an explicit confirm.
                  */}
                  {row.undoable
                    ? t("integrations.action.undo")
                    : t("integrations.action.restorePoint")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {restoring && (
        <RestoreDialog
          apiBase={apiBase}
          row={restoring}
          onClose={() => setRestoring(null)}
          onRestored={refresh}
        />
      )}
    </section>
  );
}
