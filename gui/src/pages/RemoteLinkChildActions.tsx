import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { LinkApiError, type LinkRowWire } from "../remote-link-api";
import {
  CHILD_JOB_POLL_MS, CHILD_JOB_POLL_TIMEOUT_MS, changedPolicyKeys, codexRestartNeeded, getChildJob, getChildPolicy, postChildOperation, putChildPolicy,
  chunkLinkIds, restartWithheld, rowOperable, settleOrAbort, updateAvailable,
  type ChildJobView, type ChildOp, type ChildOperationBody, type ChildOpsRowView, type ChildPolicyReadView, type ChildPolicyView,
} from "../remote-link-child-ops-api";
import { type TKey, useT } from "../i18n/shared";
import { Select } from "../ui";
import { Button } from "@/components/ui-v2/button";
import { Banner, StateBadge } from "../components/v2-startup/primitives";
import type { LinkActionErrorView } from "./RemoteLinkSheet";

const ERROR_TKEY: Record<string, TKey> = {
  invalid_job_id: "remoteLink.error.invalid_job_id",
  job_not_found: "remoteLink.error.job_not_found",
  link_not_home_initiated: "remoteLink.error.link_not_home_initiated",
  link_operation_in_progress: "remoteLink.error.link_operation_in_progress",
  no_eligible_links: "remoteLink.error.no_eligible_links",
  policy_write_failed: "remoteLink.error.policy_write_failed",
  runtime_role_client: "remoteLink.error.runtime_role_client",
};

function linkActionError(error: unknown): LinkActionErrorView {
  const key = error instanceof LinkApiError && error.code in ERROR_TKEY ? ERROR_TKEY[error.code]! : "remoteLink.error.generic";
  return { key, hint: error instanceof LinkApiError ? error.hint : null };
}

const OP_NOUN_KEY: Record<ChildOp, TKey> = {
  observe: "remoteLink.job.op.observe",
  sync: "remoteLink.job.op.sync",
  "restart-codex": "remoteLink.job.op.restartCodex",
  update: "remoteLink.job.op.update",
};

const ACTIVE_KEY: Record<ChildOp, TKey> = {
  observe: "remoteLink.job.active.observe",
  sync: "remoteLink.job.active.sync",
  "restart-codex": "remoteLink.job.active.restartCodex",
  update: "remoteLink.job.active.update",
};

/** The eight owner-action reasons 020 emits; any other token prints as code instead of a guessed sentence. */
const OWNER_ACTION_KEYS: Record<string, TKey> = {
  "legacy-ocx": "remoteLink.child.ownerAction.legacy-ocx",
  "desktop-app-owned": "remoteLink.child.ownerAction.desktop-app-owned",
  goat: "remoteLink.child.ownerAction.goat",
  "launcher-node-missing": "remoteLink.child.ownerAction.launcher-node-missing",
  "launcher-bypassed": "remoteLink.child.ownerAction.launcher-bypassed",
  "mise-managed": "remoteLink.child.ownerAction.mise-managed",
  "source-checkout": "remoteLink.child.ownerAction.source-checkout",
  "installer-unknown": "remoteLink.child.ownerAction.installer-unknown",
};

const JOB_STATE_KEYS: Record<string, TKey> = {
  queued: "remoteLink.job.state.queued",
  running: "remoteLink.job.state.running",
  succeeded: "remoteLink.job.state.succeeded",
  "up-to-date": "remoteLink.job.state.upToDate",
  busy: "remoteLink.job.state.busy",
  offline: "remoteLink.job.state.offline",
  refused: "remoteLink.job.state.refused",
  "owner-action": "remoteLink.job.state.ownerAction",
  unsupported: "remoteLink.job.state.unsupported",
  failed: "remoteLink.job.state.failed",
  uncertain: "remoteLink.job.state.uncertain",
};

/** Revision 6: the four sync states 030 emits; an unknown one renders as <code>. */
const SYNC_KEYS: Record<string, TKey> = {
  synced: "remoteLink.job.sync.synced",
  skipped: "remoteLink.job.sync.skipped",
  failed: "remoteLink.job.sync.failed",
  "timed-out": "remoteLink.job.sync.timedOut",
};

const RESTART_KEYS: Record<string, TKey> = {
  requested: "remoteLink.job.restart.requested",
  unsupported: "remoteLink.job.restart.unsupported",
  "not-run": "remoteLink.job.restart.notRun",
  skipped: "remoteLink.job.restart.skipped",
};

const KIND_KEYS: Record<string, TKey> = {
  "desktop-app": "remoteLink.child.kind.desktopApp",
  goat: "remoteLink.child.kind.goat",
  source: "remoteLink.child.kind.source",
};

function CodeToken({ children }: { children: string }): ReactElement {
  return <code className="font-mono">{children}</code>;
}

/** The exact link ids a bulk action names; the server expands "all" past the confirmed rows. */
const linkIds = (rows: readonly LinkRowWire[]): string[] => rows.map(row => row.id);

export function ChildRowBadges({ row }: { row: ChildOpsRowView }): ReactElement {
  const t = useT();
  const version = row.installedVersion ?? row.runningVersion;
  const owner = row.update.route === "owner-action" ? row.update.reason : null;
  const ownerKey: TKey | null = owner !== null ? OWNER_ACTION_KEYS[owner] ?? null : null;
  const kindKey: TKey | null = row.installKind !== null ? KIND_KEYS[row.installKind] ?? null : null;
  const lastStateKey: TKey | null = row.lastOperation ? JOB_STATE_KEYS[row.lastOperation.state] ?? null : null;
  return (
    <span className="remote-link-child-badges flex min-w-0 flex-wrap items-center gap-1.5">
      {version && <StateBadge tone="neutral">v{version}</StateBadge>}
      {kindKey && <StateBadge tone="neutral">{t(kindKey)}</StateBadge>}
      {row.installKind !== null && !kindKey && <StateBadge tone="neutral"><CodeToken>{row.installKind}</CodeToken></StateBadge>}
      {row.childBuild && <StateBadge tone="neutral"><CodeToken>{`ocx-child ${row.childBuild}`}</CodeToken></StateBadge>}
      {row.versionSkew === "same" && <StateBadge tone="ok">{t("remoteLink.child.skew.same")}</StateBadge>}
      {row.versionSkew === "behind" && <StateBadge tone="warn">{t("remoteLink.child.skew.behind", { version: row.homeVersion })}</StateBadge>}
      {row.versionSkew === "ahead" && <StateBadge tone="warn">{t("remoteLink.child.skew.ahead")}</StateBadge>}
      {updateAvailable(row) && <StateBadge tone="warn">{t("remoteLink.child.updateAvailable", { version: row.homeVersion })}</StateBadge>}
      {row.catalog.state === "behind" && <StateBadge tone="warn">{t("remoteLink.child.catalog.behind")}</StateBadge>}
      {row.catalog.state === "current" && <StateBadge tone="ok">{t("remoteLink.child.catalog.current")}</StateBadge>}
      {codexRestartNeeded(row) && <StateBadge tone="warn">{t("remoteLink.child.codex.restartNeeded", { count: row.codex?.staleCount ?? 0 })}</StateBadge>}
      {row.codex?.appServers === "not_running" && <StateBadge tone="neutral">{t("remoteLink.child.codex.notRunning")}</StateBadge>}
      {ownerKey && <StateBadge tone="neutral">{t(ownerKey)}</StateBadge>}
      {owner && !ownerKey && <CodeToken>{owner}</CodeToken>}
      {row.activeJob && <StateBadge tone="neutral">{t(ACTIVE_KEY[row.activeJob.op])}</StateBadge>}
      {row.lastOperation && (
        <span className="text-[12px] leading-5 text-fg-muted">
          {t("remoteLink.job.last", { op: t(OP_NOUN_KEY[row.lastOperation.op]),
            state: lastStateKey ? t(lastStateKey) : row.lastOperation.state })}
          {!lastStateKey && <> <CodeToken>{row.lastOperation.state}</CodeToken></>}
          {row.lastOperation.reason && <> <CodeToken>{row.lastOperation.reason}</CodeToken></>}
        </span>
      )}
    </span>
  );
}

/** The `<dialog>` shell used by the disconnect dialog, shared by the child confirmations. */
function ChildConfirmDialog(props: { open: boolean; title: string; body: string; confirm: string; onCancel(): void; onConfirm(): void }): ReactElement {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) { if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog ref={ref} aria-labelledby="remote-link-child-confirm-title" onCancel={event => { event.preventDefault(); props.onCancel(); }}
      className="remote-link-confirm-dialog m-auto w-[min(440px,calc(100vw-24px))] rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40">
      {props.open && <>
        <div className="flex flex-col gap-2 rounded-[10px] bg-bg px-5 py-4 ring-1 ring-line">
          <h3 id="remote-link-child-confirm-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{props.title}</h3>
          <p className="m-0 text-[14px] leading-[21px] text-fg-muted">{props.body}</p>
        </div>
        <div className="flex justify-end gap-2 px-2 py-2">
          <Button variant="ghost" onClick={props.onCancel}>{t("link.cancel")}</Button>
          <Button variant="danger" autoFocus onClick={props.onConfirm}>{props.confirm}</Button>
        </div>
      </>}
    </dialog>
  );
}

function RestartCodexBody(props: { alias: string; onCancel(): void;
  onConfirm(scope: "app-server" | "codex"): void }): ReactElement {
  const t = useT();
  // The body unmounts with the dialog, so every open starts from the per-click default scope.
  const [scope, setScope] = useState<"app-server" | "codex">("app-server");
  return <>
    <div className="flex flex-col gap-2 rounded-[10px] bg-bg px-5 py-4 ring-1 ring-line">
      <h3 id="remote-link-restart-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{t("remoteLink.child.restartCodex")}</h3>
      <label className="flex items-start gap-2 text-[13px] leading-5">
        <input type="radio" name="ocx-restart-scope" checked={scope === "app-server"} onChange={() => setScope("app-server")} className="mt-1" />
        <span><strong>{t("remoteLink.restart.scope.appServer")}</strong><span className="mt-0.5 block text-fg-muted">{t("remoteLink.restart.scope.appServerBody")}</span></span>
      </label>
      <label className="flex items-start gap-2 text-[13px] leading-5">
        <input type="radio" name="ocx-restart-scope" checked={scope === "codex"} onChange={() => setScope("codex")} className="mt-1" />
        <span><strong>{t("remoteLink.restart.scope.codex")}</strong><span className="mt-0.5 block text-fg-muted">{t("remoteLink.restart.scope.codexBody", { alias: props.alias })}</span></span>
      </label>
    </div>
    <div className="flex justify-end gap-2 px-2 py-2">
      <Button variant="ghost" onClick={props.onCancel}>{t("link.cancel")}</Button>
      <Button variant="danger" onClick={() => props.onConfirm(scope)}>{t("remoteLink.restart.confirm")}</Button>
    </div>
  </>;
}

export function RestartCodexDialog(props: { alias: string; open: boolean; onCancel(): void;
  onConfirm(scope: "app-server" | "codex"): void }): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) { if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog ref={ref} aria-labelledby="remote-link-restart-title" onCancel={event => { event.preventDefault(); props.onCancel(); }}
      className="remote-link-confirm-dialog m-auto w-[min(440px,calc(100vw-24px))] rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40">
      {props.open && <RestartCodexBody alias={props.alias} onCancel={props.onCancel} onConfirm={props.onConfirm} />}
    </dialog>
  );
}

export function ChildRowActions(props: { apiBase: string; link: LinkRowWire; disabled: boolean;
  onJob(job: ChildJobView): void; onError(error: LinkActionErrorView | null): void;
  onDialog(open: boolean): void; onRun(running: { linkId: string; op: ChildOp } | null): void }): ReactElement | null {
  const t = useT();
  const [restarting, setRestarting] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const row = props.link.child ?? null;
  if (!rowOperable(props.link.direction, row)) return null;
  // A job holding the link is the only global hold. Restart and update are withheld while the link is busy
  // (030's runner refuses without SSH); observe and sync are allowed to try and report the server's own verdict.
  // Revision 6: the idle-after window gates automatic actions only; a manual action waits on inFlight alone.
  const held = props.disabled || row!.activeJob !== null;
  const busy = held || row!.activity.inFlight > 0;
  const run = async (body: ChildOperationBody) => {
    props.onError(null);
    props.onRun({ linkId: props.link.id, op: body.op });
    try { props.onJob(await postChildOperation(props.apiBase, body)); }
    catch (error) { props.onError(linkActionError(error)); }
    finally { props.onRun(null); }
  };
  const single = (op: ChildOp, restart?: "app-server" | "codex") =>
    void run({ op, linkIds: [props.link.id], ...(restart ? { restart } : {}) });
  const canUpdate = updateAvailable(row!);
  return (
    <span className="remote-link-child-actions flex shrink-0 flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" onClick={() => single("observe")} disabled={held}>{t("remoteLink.child.check")}</Button>
      <Button variant="ghost" size="sm" onClick={() => single("sync")} disabled={held}>{t("remoteLink.child.syncNow")}</Button>
      <Button variant="ghost" size="sm" onClick={() => { setRestarting(true); props.onDialog(true); }} disabled={busy}>{t("remoteLink.child.restartCodex")}</Button>
      <Button variant="primary" size="sm" onClick={() => { setConfirmUpdate(true); props.onDialog(true); }} disabled={busy || !canUpdate}
        title={canUpdate ? undefined : t("remoteLink.child.upToDate")}>{t("remoteLink.child.update")}</Button>
      <RestartCodexDialog alias={props.link.alias} open={restarting}
        onCancel={() => { setRestarting(false); props.onDialog(false); }}
        onConfirm={scope => { setRestarting(false); props.onDialog(false); single("restart-codex", scope); }} />
      <ChildConfirmDialog open={confirmUpdate} title={t("remoteLink.child.update")}
        body={t("remoteLink.child.updateConfirm", { alias: props.link.alias, version: row!.homeVersion })}
        confirm={t("remoteLink.child.update")}
        onCancel={() => { setConfirmUpdate(false); props.onDialog(false); }}
        onConfirm={() => { setConfirmUpdate(false); props.onDialog(false); single("update"); }} />
    </span>
  );
}

export function ChildBulkBar(props: { apiBase: string; rows: readonly LinkRowWire[];
  onJob(job: ChildJobView): void; onError(error: LinkActionErrorView | null): void;
  onRun(running: { linkId: "all"; op: ChildOp } | null): void }): ReactElement | null {
  const t = useT();
  const [confirming, setConfirming] = useState<null | "all">(null);
  const operable = props.rows.filter(row => rowOperable(row.direction, row.child ?? null));
  const updatable = operable.filter(row => updateAvailable(row.child!));
  if (operable.length === 0) return null;
  const homeVersion = updatable[0]?.child?.homeVersion ?? operable[0]?.child?.homeVersion ?? "";
  // The server expands "all" to every stored link and runs a pinned sync before it decides currency, so a
  // link outside the confirmation could still be reached. Both bulk actions name exactly the rows they cover:
  // update the updatable ones the dialog counts, observe the operable ones in the bar's own list.
  // The route takes at most 64 ids per body, so a larger list goes out as one job per group. The groups are
  // independent: each accepted group is tracked as its own job, and the first refusal's error shows.
  const run = async (op: ChildOp, ids: readonly string[]) => {
    props.onError(null);
    props.onRun({ linkId: "all", op });
    try {
      const results = await Promise.allSettled(chunkLinkIds(ids).map(group => postChildOperation(props.apiBase, { op, linkIds: group })));
      for (const result of results) if (result.status === "fulfilled") props.onJob(result.value);
      const refused = results.find(result => result.status === "rejected");
      if (refused) props.onError(linkActionError(refused.reason));
    }
    finally { props.onRun(null); }
  };
  return (
    <div className="remote-link-child-bulk flex flex-wrap items-center gap-2 px-1 py-2">
      <Button variant="ghost" size="sm" onClick={() => void run("observe", linkIds(operable))}>{t("remoteLink.child.checkAll")}</Button>
      <Button variant="outline" size="sm" disabled={updatable.length === 0}
        onClick={() => setConfirming("all")}>{t("remoteLink.child.updateAll")}</Button>
      <ChildConfirmDialog open={confirming === "all"} title={t("remoteLink.child.updateAll")}
        body={t("remoteLink.child.updateAllConfirm", { count: updatable.length, version: homeVersion })}
        confirm={t("remoteLink.child.updateAll")} onCancel={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); void run("update", linkIds(updatable)); }} />
    </div>
  );
}

function useChildJob(apiBase: string, job: ChildJobView, onSnapshot?: (job: ChildJobView) => void): { job: ChildJobView; missing: boolean } {
  // Both states are keyed by job id so a new job renders its own prop without a reset effect: an effect that
  // synchronously reset them would cascade renders (react-compiler EffectSetState), and a stale snapshot would
  // otherwise leak across jobs.
  const [polled, setPolled] = useState<{ jobId: string; value: ChildJobView } | null>(null);
  const [missingFor, setMissingFor] = useState<string | null>(null);
  const snapshot = polled?.jobId === job.jobId ? polled.value : job;
  const missing = missingFor === job.jobId;
  // The page holds rows from its own job snapshot, so each poll is handed up as it lands: a finished item must
  // release its row while the rest of the job is still running, not only when the whole job ends.
  const notify = useRef(onSnapshot);
  useEffect(() => { notify.current = onSnapshot; }, [onSnapshot]);
  useEffect(() => {
    if (job.state === "done") return;
    let stopped = false;
    // The interval and the visibility listener can both fire while a request is pending, and responses need not
    // arrive in the order they were sent: skip a tick while one is in flight, and drop any response older than
    // the last applied one so a stale "running" snapshot cannot restore a hold a newer one released.
    let inFlight = false;
    let sequence = 0;
    let applied = 0;
    const controller = new AbortController();
    // The interval ticks skip while a request is pending, so a slow Home cannot pile them up; the visibility
    // listener is user-driven and may overlap one, which the sequence tag then orders.
    const tick = async (fromListener = false) => {
      if (document.visibilityState === "hidden" || (inFlight && !fromListener)) return;
      inFlight = true;
      const mine = ++sequence;
      // Each poll gets its own deadline: a GET that never settles would keep inFlight set, every interval tick
      // would then skip, and the row would stay held until the page reloads.
      const request = new AbortController();
      const stop = () => request.abort();
      controller.signal.addEventListener("abort", stop, { once: true });
      const deadline = window.setTimeout(stop, CHILD_JOB_POLL_TIMEOUT_MS);
      try {
        const next = await settleOrAbort(getChildJob(apiBase, job.jobId, request.signal), request.signal);
        if (!stopped && mine > applied) {
          applied = mine;
          setPolled({ jobId: job.jobId, value: next }); notify.current?.(next);
        }
      } catch (error) {
        if (error instanceof LinkApiError && (error.code === "job_not_found" || error.status === 404)) {
          stopped = true;                       // the Home restarted (retention is 1 h / 32 jobs)
          controller.abort();
          setMissingFor(job.jobId);
        }
      } finally {
        window.clearTimeout(deadline);
        controller.signal.removeEventListener("abort", stop);
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void tick(), CHILD_JOB_POLL_MS);
    const onVisibility = () => { if (document.visibilityState !== "hidden") void tick(true); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; inFlight = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [apiBase, job.jobId, job.state]);
  return { job: snapshot, missing };
}

export function ChildJobProgress(props: { apiBase: string; job: ChildJobView; onDone(): void; onJobUpdate?(job: ChildJobView): void }): ReactElement {
  const t = useT();
  const { job, missing } = useChildJob(props.apiBase, props.job, props.onJobUpdate);
  const done = job.state === "done" || missing;
  const fired = useRef(false);
  useEffect(() => { if (done && !fired.current) { fired.current = true; props.onDone(); } }, [done, props]);
  return (
    <section className="remote-link-job flex min-w-0 flex-col gap-1 rounded-[12px] bg-surface px-4 py-3 ring-1 ring-line" aria-live="polite">
      <h4 className="m-0 text-[13px] font-semibold">
        {t(ACTIVE_KEY[job.op])}{job.trigger === "auto" && <> · {t("remoteLink.job.automatic")}</>}
      </h4>
      {missing && <Banner tone="info">{t("remoteLink.job.notFound")}</Banner>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] leading-5">
        {job.items.map(item => {
          const state = missing && (item.state === "queued" || item.state === "running") ? "uncertain" : item.state;
          const stateKey: TKey | null = JOB_STATE_KEYS[state] ?? null;
          const syncKey: TKey | null = item.sync ? SYNC_KEYS[item.sync.state] ?? null : null;
          const restartKey: TKey | null = item.restart ? RESTART_KEYS[item.restart.outcome] ?? null : null;
          return (
            <li key={item.linkId || item.alias} className="flex min-w-0 flex-wrap items-center gap-x-2">
              <span className="font-semibold">{item.alias}</span>
              <span>{stateKey ? t(stateKey) : <CodeToken>{state}</CodeToken>}</span>
              {(item.fromVersion || item.toVersion) && <CodeToken>{`${item.fromVersion ?? "?"} → ${item.toVersion ?? "?"}`}</CodeToken>}
              {item.reason && <span className="text-fg-muted"><CodeToken>{item.reason}</CodeToken></span>}
              {item.hint && <span className="basis-full text-fg-muted remote-link-job-hint">{item.hint}</span>}
              {item.sync && <span className="text-fg-muted">{syncKey ? t(syncKey) : <CodeToken>{item.sync.state}</CodeToken>}</span>}
              {item.restart && <span className={restartWithheld(item.restart.outcome) ? "text-warning" : "text-fg-muted"}>
                {restartKey ? t(restartKey) : <CodeToken>{item.restart.outcome}</CodeToken>}
              </span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Validates the digits before converting, so an empty, partial or exponent input never enters the draft. */
function parseIdleMinutes(raw: string): number | undefined {
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 1 && value <= 60 ? value : undefined;
}

export function ChildPolicyPanel(props: { apiBase: string; busy: boolean; reloadSignal: number; onBusy(on: boolean): void;
  onError(error: LinkActionErrorView | null): void }): ReactElement | null {
  const t = useT();
  const [read, setRead] = useState<ChildPolicyReadView | null>(null);
  const [draft, setDraft] = useState<ChildPolicyView | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<LinkActionErrorView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { apiBase, reloadSignal } = props;
  // A save and a reload race on the same document. Each save bumps the generation, so a GET that began before it
  // cannot apply afterwards; and a reload only takes over the draft when nothing was edited while it was in flight.
  const generation = useRef(0);
  const saving = useRef(false);
  const draftRef = useRef<ChildPolicyView | null>(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const readRef = useRef<ChildPolicyReadView | null>(read);
  useEffect(() => { readRef.current = read; }, [read]);
  // Revision 6: load once per mount, after a save, and on an explicit page Refresh. A status poll never re-reads,
  // so an edit survives it.
  const load = useCallback(async (signal?: AbortSignal) => {
    const startedAt = generation.current;
    const startedDraft = draftRef.current;
    const startedRead = readRef.current;
    try {
      const value = await getChildPolicy(apiBase, signal);
      if (signal?.aborted) return;
      if (generation.current !== startedAt) return;   // a save started after this GET began; it owns the values now
      setRead(value);
      // The operator changed knobs while this reload ran: merge field by field, keeping exactly those they changed
      // against the baseline this GET started from and adopting the server's value for every untouched field.
      if (draftRef.current !== startedDraft && startedRead) {
        // Compare the live draft, not the one this GET started from: the operator's edit happened in between.
        const operatorChanged = changedPolicyKeys(startedRead.policy, draftRef.current!);
        setDraft({ ...value.policy, ...operatorChanged });
      } else setDraft(value.policy);
      setLoadError(null);
    } catch (error) { if (!signal?.aborted) setLoadError(linkActionError(error)); }
  }, [apiBase]);
  // Deferred a microtask so the fetch starts after mount commits; calling the loader directly trips
  // react-compiler's EffectSetState rule even though its state writes land after the await.
  useEffect(() => {
    if (saving.current) return;   // a reload never interrupts a save, including the page Refresh's policy part
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load, attempt, reloadSignal]);
  if (!draft || !read) {
    if (!loadError) return null;
    return (
      <section className="remote-link-policy flex min-w-0 flex-col gap-2 rounded-[12px] bg-surface p-4 ring-1 ring-line" aria-labelledby="remote-link-policy-title">
        <h3 id="remote-link-policy-title" className="m-0 text-[14px] font-semibold">{t("remoteLink.policy.title")}</h3>
        <Banner tone="err" action={<Button variant="outline" size="sm" onClick={() => { setLoadError(null); setAttempt(value => value + 1); }}>{t("link.retry")}</Button>}>
          {t("remoteLink.policy.loadFailed")}
        </Banner>
      </section>
    );
  }
  const changed = changedPolicyKeys(read.policy, draft);
  const damaged = read.warning === "policy-file-invalid";
  const save = async () => {
    saving.current = true;
    generation.current += 1;
    props.onBusy(true); props.onError(null); setSaved(false);
    try {
      // Over a damaged file the server merges onto FAIL_CLOSED; send every knob so the visible choices persist.
      const value = await putChildPolicy(apiBase, damaged ? draft : changed);
      setRead(value); setDraft(value.policy); setSaved(true);
    } catch (error) { props.onError(linkActionError(error)); }
    finally { saving.current = false; props.onBusy(false); }
  };
  const minutes = Math.round(draft.idleAfterMs / 60_000);
  const set = <K extends keyof ChildPolicyView>(key: K, value: ChildPolicyView[K]) => { setSaved(false); setDraft({ ...draft, [key]: value }); };
  return (
    <section className="remote-link-policy flex min-w-0 flex-col gap-2 rounded-[12px] bg-surface p-4 ring-1 ring-line" aria-labelledby="remote-link-policy-title">
      <h3 id="remote-link-policy-title" className="m-0 text-[14px] font-semibold">{t("remoteLink.policy.title")}</h3>
      {damaged && <Banner tone="warn">{t("remoteLink.policy.invalid")}</Banner>}
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span>{t("remoteLink.policy.catalogFanout")}</span>
        <Select value={draft.catalogFanout} disabled={props.busy} onChange={value => set("catalogFanout", value as ChildPolicyView["catalogFanout"])} label={t("remoteLink.policy.catalogFanout")}
          options={[{ value: "auto", label: t("remoteLink.policy.catalogFanout.auto") }, { value: "manual", label: t("remoteLink.policy.catalogFanout.manual") }]} />
      </label>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span>{t("remoteLink.policy.childCodexRestart")}</span>
        <Select value={draft.childCodexRestart} disabled={props.busy} onChange={value => set("childCodexRestart", value as ChildPolicyView["childCodexRestart"])} label={t("remoteLink.policy.childCodexRestart")}
          options={[{ value: "never", label: t("remoteLink.policy.childCodexRestart.never") }, { value: "app-server-when-idle", label: t("remoteLink.policy.childCodexRestart.whenIdle") }]} />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="flex items-center justify-between gap-3"><span>{t("remoteLink.policy.updates")}</span>
          <Select value={draft.updates} disabled={props.busy} onChange={value => set("updates", value as ChildPolicyView["updates"])} label={t("remoteLink.policy.updates")}
            options={[{ value: "off", label: t("remoteLink.policy.updates.off") }, { value: "notify", label: t("remoteLink.policy.updates.notify") },
              { value: "auto-when-idle", label: t("remoteLink.policy.updates.autoWhenIdle") }]} />
        </span>
        <span className="text-[12px] leading-5 text-fg-muted">{t("remoteLink.policy.updatesInactive")}</span>
      </label>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span>{t("remoteLink.policy.idleMinutes")}</span>
        <input type="number" className="input w-[88px]" min={1} max={60} value={minutes} disabled={props.busy} aria-label={t("remoteLink.policy.idleMinutes")}
          onChange={event => { const next = parseIdleMinutes(event.target.value); if (next !== undefined) set("idleAfterMs", next * 60_000); }} />
      </label>
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-[12px] text-success" role="status">{t("remoteLink.policy.saved")}</span>}
        <Button variant="primary" size="sm" disabled={props.busy || (Object.keys(changed).length === 0 && !damaged)} onClick={() => void save()}>
          {t("remoteLink.policy.save")}
        </Button>
      </div>
    </section>
  );
}
