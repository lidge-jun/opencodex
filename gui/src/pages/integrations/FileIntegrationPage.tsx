import { useCallback, useEffect, useRef, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { useT, type TKey } from "../../i18n/shared";
import { Notice, Switch } from "../../ui";
import ClientMark from "../../components/ClientMark";
import { markFor } from "../../components/integration-marks";
import IntegrationStateBadge from "./IntegrationStateBadge";
import ConsequenceDialog, { type ConsequenceCopy } from "./ConsequenceDialog";
import RestoreDialog from "./RestoreDialog";
import RaycastPlanNotice from "./RaycastPlanNotice";
import { RollbackHistory } from "./RollbackHistory";
import { describeRefusal } from "./refusal-copy";
import {
  loadIntegrationJournal,
  loadIntegrationState,
  previewIntegrationMutation,
  toggleIntegration,
  bindingFor,
  IntegrationApiError,
  deleteJournalEntry,
  isIntegrationPreviewUnavailable,
  isMissingJournalEntry,
  type FileIntegrationClientId,
  type IntegrationJournalRow,
  type IntegrationStatus,
  type IntegrationMutationPlan,
  type IntegrationPlanOperation,
} from "./integration-api";

export type { FileIntegrationClientId };

/*
 * Copy for the overwrite dialog, selected on WHICH conflict it is.
 *
 * Same operation, materially different thing being lost: `unowned-key` means a
 * block we did not write is in the way, `foreign-edit` means the user's own
 * change inside our block is what gets discarded. One sentence covering both
 * would have to be vague about the only part that matters.
 */
function overwriteCopy(reason: string | undefined, path: string): ConsequenceCopy {
  return {
    titleKey: "integrations.dialog.overwrite.title",
    changesKey: reason === "foreign-edit"
      ? "integrations.dialog.overwrite.changesForeign"
      : "integrations.dialog.overwrite.changesUnowned",
    breakageKey: "integrations.dialog.overwrite.breakage",
    undoKey: "integrations.dialog.overwrite.undo",
    confirmKey: "integrations.dialog.overwrite.confirm",
    vars: { path },
  };
}

const APPLY_COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.apply.title",
  changesKey: "integrations.dialog.apply.changes",
  breakageKey: "integrations.dialog.apply.breakage",
  undoKey: "integrations.dialog.apply.undo",
  confirmKey: "integrations.dialog.apply.confirm",
};

const DISABLE_COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.disable.title",
  changesKey: "integrations.dialog.disable.changes",
  breakageKey: "integrations.dialog.disable.breakage",
  undoKey: "integrations.dialog.disable.undo",
  confirmKey: "integrations.dialog.disable.confirm",
};

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
  aside: "integrations.semantics.aside",
  raycast: "integrations.semantics.raycast",
  omo: "integrations.semantics.omo",
  cline: "integrations.semantics.cline",
  kilo: "integrations.semantics.kilo",
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
  aside: "integrations.tab.aside",
  raycast: "integrations.tab.raycast",
  omo: "integrations.tab.omo",
  cline: "integrations.tab.cline",
  kilo: "integrations.tab.kilo",
};

export default function FileIntegrationPage({
  apiBase,
  client,
  active = true,
  profileId,
  profileLabel,
}: {
  apiBase: string;
  client: FileIntegrationClientId;
  active?: boolean;
  profileId?: number;
  profileLabel?: string;
}) {
  const t = useT();
  const scopeKey = profileId === undefined ? client : `${client}:${profileId}`;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<IntegrationJournalRow | null>(null);
  /* The row awaiting delete confirmation. */
  const [deleting, setDeleting] = useState<IntegrationJournalRow | null>(null);
  const [plannedMutation, setPlannedMutation] = useState<{
    operation: Exclude<IntegrationPlanOperation, "restore">;
    plan: IntegrationMutationPlan | null;
    loading: boolean;
    failure: string | null;
  } | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewGenerationRef = useRef(0);

  useEffect(() => () => {
    previewGenerationRef.current += 1;
    previewAbortRef.current?.abort();
  }, []);

  const fetchState = useCallback(
    (signal: AbortSignal) => loadIntegrationState(apiBase, client, signal, profileId),
    [apiBase, client, profileId],
  );
  const fetchHistory = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationJournal(apiBase, client, signal, profileId)).operations,
    [apiBase, client, profileId],
  );

  const stateResource = useDataSurface<IntegrationStatus>(
    `integration-state:${apiBase}:${scopeKey}`,
    [apiBase, client, profileId],
    fetchState,
    {
      isEmpty: () => false,
      enabled: active,
      sessionCacheKey: `ocx.integrations.state.v1:${apiBase}:${scopeKey}`,
    },
  );
  const historyResource = useDataSurface<IntegrationJournalRow[]>(
    `integration-journal:${apiBase}:${scopeKey}`,
    [apiBase, client, profileId],
    fetchHistory,
    {
      isEmpty: rows => rows.length === 0,
      enabled: active,
      sessionCacheKey: `ocx.integrations.client-journal.v1:${apiBase}:${scopeKey}`,
    },
  );

  const candidate = stateResource.state.data ?? null;
  const status = candidate && (profileId === undefined
    || (candidate.profileId === profileId && typeof candidate.enabled === "boolean")) ? candidate : null;
  const history = historyResource.state.data ?? [];

  const refresh = () => {
    void stateResource.refresh();
    void historyResource.refresh();
  };

  const requestMutation = async (operation: Exclude<IntegrationPlanOperation, "restore">) => {
    if (!status || pending || plannedMutation) return;
    const controller = new AbortController();
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    previewAbortRef.current?.abort();
    previewAbortRef.current = controller;
    setPlannedMutation({ operation, plan: null, loading: true, failure: null });
    try {
      const plan = await previewIntegrationMutation(apiBase, client, operation, controller.signal, profileId);
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      previewAbortRef.current = null;
      setPlannedMutation({ operation, plan, loading: false, failure: null });
    } catch (error) {
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      previewAbortRef.current = null;
      if (isIntegrationPreviewUnavailable(error)) {
        setPlannedMutation(null);
        refresh();
        return;
      }
      setPlannedMutation({ operation, plan: null, loading: false, failure: t("integrations.preview.failed") });
    }
  };

  const closePlannedMutation = () => {
    previewGenerationRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPlannedMutation(null);
  };

  const mutate = async (plan: IntegrationMutationPlan) => {
    if (!status || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await toggleIntegration(apiBase, client, {
        enabled: plan.operation !== "disable",
        overwriteConflict: plan.operation === "overwrite",
        profileId,
        binding: bindingFor(plan),
      });
      setPlannedMutation(null);
    } catch (error) {
      refresh();
      if (error instanceof IntegrationApiError && error.stalePlan) throw error;
      throw new Error(describeRefusal(t, error), { cause: error });
    } finally {
      refresh();
      setPending(false);
    }
  };

  /*
   * The one way past a conflict. Separate from `mutate` because it must not be
   * reachable from the switch: the switch is locked in this state precisely
   * because we cannot know what the user wants kept, and the whole point of the
   * escape hatch is that they say so.
   *
   * Errors are NOT swallowed here -- they propagate so ConsequenceDialog can
   * render them inside the dialog, where the user still has the cancel button.
   */
  /*
   * The switch means exactly what its label says.
   *
   * `stale` also means our block is in the file, so the switch reads applied —
   * but it once sent `enabled: true` for that state, which asked the server to
   * REFRESH while the control was labelled Disable. Turning a switch off has
   * to remove the block; updating a stale block is a separate action with its
   * own button below.
   */
  const toggle = () => void requestMutation(enabled ? "disable" : "apply");

  if (!status) {
    return (
      <section className="integration-client-page">
        {stateResource.state.showError
          ? <Notice tone="err">{t("integrations.error.load")}</Notice>
          : <p className="page-sub">{t("common.loading")}</p>}
      </section>
    );
  }

  const applied = status.state === "current" || status.state === "stale";
  const enabled = profileId !== undefined ? status.enabled === true : applied;
  const profileUnavailable = profileId !== undefined && (stateResource.state.showError || stateResource.state.refreshing);
  // A profile may stop future sync even when its file cannot be changed; the
  // writer still refuses unsafe deletion and reports the actual state separately.
  const locked = (!status.installed || status.state === "conflict" || status.state === "unsafe")
    && !(profileId !== undefined && enabled);

  return (
    <section className="integration-client-page">
      <div className="integration-client-head">
        <ClientMark src={markFor(client)} label={t(TAB_LABEL_KEY[client])} size={24} />
        <h3>{profileLabel ?? t(TAB_LABEL_KEY[client])}</h3>
        <IntegrationStateBadge
          state={status.state}
          installed={status.installed}
          id={`integration-state-${client}${profileId === undefined ? "" : `-${profileId}`}`}
        />
        <Switch
          on={enabled}
          onClick={toggle}
          disabled={locked || pending || profileUnavailable}
          label={enabled ? t("integrations.action.disable") : t("integrations.action.apply")}
        />
      </div>

      {profileId !== undefined && stateResource.state.showError && (
        <Notice tone="err">{t("integrations.aside.loadError")}
          <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={pending || stateResource.state.refreshing}>{t("common.retry")}</button>
        </Notice>
      )}
      {/*
        Updating a stale block is its own action. Folding it into the switch
        made "off" mean "refresh", which is the opposite of what the control
        said it would do.
      */}
      {status.state === "stale" && enabled && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void requestMutation("apply")}
          disabled={pending}
        >
          {t("integrations.action.refresh")}
        </button>
      )}

      {/*
        Conflict used to be a dead end: the switch locks, the page explains why,
        and the only way forward was to open the file and edit it by hand -- which
        is the thing a user came to a dashboard to avoid. The switch stays locked
        and this is the one way past it, behind a dialog that names the file and
        says what is lost.
      */}
      {status.installed && status.state === "conflict" && (
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void requestMutation("overwrite")}
          disabled={pending}
        >
          {t("integrations.action.overwrite")}
        </button>
      )}

      <p className="page-sub">{t(SEMANTICS_KEY[client])}</p>
      <p className="integration-path">{status.configPath}</p>
      {/* Only the raycast envelope carries this; the guard is the field, not the id. */}
      {status.raycast && <RaycastPlanNotice install={status.raycast} />}

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
      {/*
        Cold, failed and empty used to render identically, because `data ?? []`
        collapses all three into an empty array and the empty state followed. A
        user whose journal request failed was told they had no history.
      */}
      {historyResource.state.showSkeleton ? (
        <DataSurfaceSkeleton label={t("integrations.rollback.title")} rows={2} />
      ) : historyResource.state.kind === "failed-cold" ? (
        <Notice tone="err">
          {t("integrations.rollback.failed")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void historyResource.refresh()}>
            {t("common.retry")}
          </button>
        </Notice>
      ) : history.length === 0 ? (
        <p className="page-sub">{t("integrations.rollback.empty")}</p>
      ) : (
        <RollbackHistory rows={history} onRestore={setRestoring} onDelete={setDeleting} />
      )}

      {restoring && (
        <RestoreDialog
          apiBase={apiBase}
          row={restoring}
          profileId={profileId}
          onClose={() => setRestoring(null)}
          onRestored={refresh}
          onReconcile={refresh}
        />
      )}
      {deleting && (
        <ConsequenceDialog
          copy={{
            titleKey: "integrations.dialog.deleteEntry.title",
            changesKey: "integrations.dialog.deleteEntry.changes",
            breakageKey: "integrations.dialog.deleteEntry.breakage",
            undoKey: "integrations.dialog.deleteEntry.undo",
            confirmKey: "integrations.dialog.deleteEntry.confirm",
            vars: { path: deleting.configPath },
          }}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await deleteJournalEntry(apiBase, deleting.opId, undefined, profileId);
            } catch (error) {
              // The requested end state is already true when another tab
              // removed this row. Reconcile the view instead of keeping a
              // confirmation open whose only possible result is another 404.
              if (isMissingJournalEntry(error)) {
                setDeleting(null);
                await historyResource.refresh();
                return;
              }
              // Localized before it reaches the dialog, which renders
              // `error.message` as-is; see the twin block in IntegrationsOverview.
              throw new Error(describeRefusal(t, error), { cause: error });
            }
            setDeleting(null);
            await historyResource.refresh();
          }}
        />
      )}
      {plannedMutation && (
        <ConsequenceDialog
          copy={plannedMutation.operation === "overwrite"
            ? overwriteCopy(status.reason, status.configPath)
            : plannedMutation.operation === "disable" ? DISABLE_COPY : APPLY_COPY}
          plan={plannedMutation.plan}
          planLoading={plannedMutation.loading}
          planFailure={plannedMutation.failure}
          onClose={closePlannedMutation}
          onConfirm={async plan => { if (plan) await mutate(plan); }}
        />
      )}
    </section>
  );
}
