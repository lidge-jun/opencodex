import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TFn, type TKey } from "../i18n/shared";
import { SESSION_CHANGED_EVENT } from "../api";
import { isConnectedRuntime, standaloneApiTargets } from "../api-targets";
import { ConnectPairingForm } from "../connect-pairing";
import { InlineBanner } from "../components/v2-accounts/surface";
import {
  applyCodexCliUpdate, canApply, codexCliApplyCommand, codexCliStatusCommand, CodexCliUpdateError, newCodexCliRequestId, fetchCodexCliUpdateJob, fetchCodexCliUpdatePlan, isTerminalJob,
  type CodexCliUpdateJobView, type CodexCliUpdatePlanView,
} from "../codex-cli-update-api";

/*
 * Codex CLI update (#2811): a read-only Check, then one explicitly confirmed Apply of exactly the
 * plan on screen. The server binds the planId, refuses a changed plan and owns the install; this
 * panel never re-plans, never retries an ambiguous result and never reaches another machine.
 */

const POLL_MS = 1500;
const POLL_READ_FAILURES = 5;
const PERMANENT_STORE = new Set(["store_full", "unsupported_store", "unsafe_store"]);

const PROVENANCE: Record<CodexCliUpdatePlanView["provenance"], TKey> = {
  "npm-global": "codexCliUpdate.provNpmGlobal",
  "app-bundle": "codexCliUpdate.provAppBundle",
  "version-manager": "codexCliUpdate.provVersionManager",
  "standalone-unverified": "codexCliUpdate.provStandaloneUnverified",
  unknown: "codexCliUpdate.unknown",
};
const REFUSAL: Record<string, TKey> = {
  windows_inspection_deferred: "codexCliUpdate.refusalWindowsInspectionDeferred",
  windows_apply_disabled: "codexCliUpdate.refusalWindowsApplyDisabled",
  not_managed: "codexCliUpdate.refusalNotManaged",
  installed_version_unverified: "codexCliUpdate.refusalInstalledVersionUnverified",
  install_content_unverified: "codexCliUpdate.refusalInstallContentUnverified",
  target_unresolved: "codexCliUpdate.refusalTargetUnresolved",
  already_current: "codexCliUpdate.refusalAlreadyCurrent",
  target_not_newer: "codexCliUpdate.refusalTargetNotNewer",
  blocked_active_session: "codexCliUpdate.refusalBlockedActiveSession",
  blocked_process_state_unknown: "codexCliUpdate.refusalBlockedProcessStateUnknown",
};
const JOB_STATUS: Record<CodexCliUpdateJobView["status"], TKey> = {
  queued: "codexCliUpdate.jobQueued",
  running: "codexCliUpdate.jobRunning",
  applied: "codexCliUpdate.jobApplied",
  not_applied: "codexCliUpdate.jobNotApplied",
  refused: "codexCliUpdate.jobRefused",
  ambiguous: "codexCliUpdate.jobAmbiguous",
};

function sessionLabel(plan: CodexCliUpdatePlanView, t: TFn): string {
  switch (plan.session.state) {
    case "none": return t("codexCliUpdate.sessionNone");
    case "active": return t("codexCliUpdate.sessionActive", { count: String(plan.session.matches ?? 1) });
    case "unknown": return t("codexCliUpdate.sessionUnknown");
    default: return t("codexCliUpdate.sessionNotEvaluated");
  }
}

type ApplyFailure = { code: string; retryable: boolean };
type PollFailure = "job_not_found" | "job_state_unavailable";

function CodexCliUpdatePanel({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<CodexCliUpdatePlanView | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [job, setJob] = useState<CodexCliUpdateJobView | null>(null);
  const [applyFailure, setApplyFailure] = useState<ApplyFailure | null>(null);
  const [pollFailure, setPollFailure] = useState<PollFailure | null>(null);
  const [pairing, setPairing] = useState(false);
  // One generation per Check: a response from an older Check, apply or poll is dropped.
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  // Minted on the first confirmed Apply of a plan; reused only to resend that same request.
  const requestId = useRef<string | null>(null);

  const track = useCallback(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  }, []);
  const abortAll = useCallback(() => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  }, []);

  useEffect(() => {
    // A changed session (pairing, sign-out) withdraws the operator's confirmation.
    const onSession = () => setConfirmed(false);
    const gen = generation;
    window.addEventListener(SESSION_CHANGED_EVENT, onSession);
    return () => { window.removeEventListener(SESSION_CHANGED_EVENT, onSession); gen.current++; abortAll(); };
  }, [abortAll]);

  const poll = useCallback(async (first: CodexCliUpdateJobView, gen: number) => {
    let current = first;
    let failures = 0;
    while (!isTerminalJob(current)) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      if (generation.current !== gen) return;
      const controller = track();
      try {
        current = await fetchCodexCliUpdateJob(apiBase, current.jobId, controller.signal);
        failures = 0;
        if (generation.current === gen) setJob(current);
      } catch (error) {
        if (generation.current !== gen || controller.signal.aborted) return;
        const code = error instanceof CodexCliUpdateError ? error.code : "job_state_unavailable";
        if (code === "job_not_found") { setPollFailure("job_not_found"); return; }
        if (++failures >= POLL_READ_FAILURES) { setPollFailure("job_state_unavailable"); return; }
      } finally {
        controllers.current.delete(controller);
      }
    }
  }, [apiBase, track]);

  const check = useCallback(async () => {
    const gen = ++generation.current;
    abortAll();
    setChecking(true); setPlan(null); setPlanError(null); setConfirmed(false); setJob(null);
    setApplyFailure(null); setPollFailure(null); setPairing(false); setApplying(false);
    requestId.current = null;
    const controller = track();
    try {
      const next = await fetchCodexCliUpdatePlan(apiBase, controller.signal);
      if (generation.current === gen) setPlan(next);
    } catch (error) {
      if (generation.current === gen && !controller.signal.aborted) {
        setPlanError(error instanceof CodexCliUpdateError ? error.code : "plan_unavailable");
      }
    } finally {
      controllers.current.delete(controller);
      if (generation.current === gen) setChecking(false);
    }
  }, [apiBase, abortAll, track]);

  const apply = useCallback(async () => {
    if (!plan || !canApply(plan, confirmed) || applying || job) return;
    const gen = generation.current;
    requestId.current ??= newCodexCliRequestId();
    if (!requestId.current) { setApplyFailure({ code: "request_id_unavailable", retryable: false }); return; }
    setApplying(true); setApplyFailure(null);
    const controller = track();
    try {
      const admitted = await applyCodexCliUpdate(apiBase, { requestId: requestId.current, planId: plan.planId! }, controller.signal);
      if (generation.current !== gen) return;
      setJob(admitted);
      setApplying(false);
      await poll(admitted, gen);
    } catch (error) {
      if (generation.current !== gen || controller.signal.aborted) return;
      const failure = error instanceof CodexCliUpdateError
        ? { code: error.code, retryable: error.retryable }
        : { code: "network", retryable: true };
      setApplyFailure(failure);
      if (failure.code === "local_dashboard_confirmation_required") setPairing(true);
      setApplying(false);
    } finally {
      controllers.current.delete(controller);
    }
  }, [apiBase, plan, confirmed, applying, job, poll, track]);

  const refusalKey = plan?.refusal ? REFUSAL[plan.refusal] : undefined;
  const busy = checking || applying;
  const settled = job ? isTerminalJob(job) : false;
  const applyCommand = codexCliApplyCommand(plan?.planId ?? null);

  return (
    <section className="panel acc-desktop relative flex flex-col gap-4" aria-labelledby="codex-cli-update-title">
      <div className="flex flex-col gap-1">
        <h2 id="codex-cli-update-title">{t("codexCliUpdate.title")}</h2>
        <p className="muted text-body">{t("codexCliUpdate.description")}</p>
        <p className="muted text-control">{t("codexCliUpdate.checkHint")}</p>
      </div>
      <div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (!!job && !settled && !pollFailure)} aria-busy={checking || undefined} onClick={() => void check()}>
          {checking ? t("codexCliUpdate.checking") : t("codexCliUpdate.check")}
        </button>
      </div>
      {planError && (
        <InlineBanner tone="err" role="alert">
          <p className="m-0">{t("codexCliUpdate.errPlanUnavailable")}</p>
          <code className="text-[12px] text-fg-muted">{planError}</code>
        </InlineBanner>
      )}
      {plan && (
        <dl className="acc-desktop__status" data-testid="codex-cli-update-plan">
          <div className="acc-desktop__stat"><dt>{t("codexCliUpdate.fieldProvenance")}</dt><dd>{t(PROVENANCE[plan.provenance])}</dd></div>
          <div className="acc-desktop__stat"><dt>{t("codexCliUpdate.fieldManaged")}</dt><dd>{plan.managed ? t("codexCliUpdate.yes") : t("codexCliUpdate.no")}</dd></div>
          <div className="acc-desktop__stat"><dt>{t("codexCliUpdate.fieldInstalled")}</dt><dd><code>{plan.installedVersion ?? t("codexCliUpdate.unknown")}</code></dd></div>
          <div className="acc-desktop__stat"><dt>{t("codexCliUpdate.fieldTarget")}</dt><dd><code>{plan.targetVersion ?? t("codexCliUpdate.unknown")}</code></dd></div>
          <div className="acc-desktop__stat"><dt>{t("codexCliUpdate.fieldSession")}</dt><dd>{sessionLabel(plan, t)}</dd></div>
          {plan.location && <div className="acc-desktop__stat"><dt>{t("codexCliUpdate.fieldLocation")}</dt><dd><code style={{ overflowWrap: "anywhere" }}>{plan.location}</code></dd></div>}
          {plan.command && <div className="acc-desktop__stat"><dt>{t("codexCliUpdate.fieldCommand")}</dt><dd><code style={{ overflowWrap: "anywhere" }}>{plan.command.join(" ")}</code></dd></div>}
        </dl>
      )}
      {plan && plan.refusal && (
        <InlineBanner tone={plan.refusal === "already_current" ? "ok" : "warn"} role="status">
          <p className="m-0">{refusalKey ? t(refusalKey) : plan.refusal}</p>
          {!refusalKey && <code className="text-[12px] text-fg-muted">{plan.refusal}</code>}
        </InlineBanner>
      )}
      {plan && canApply(plan, true) && !job && (
        <fieldset className="acc-desktop__confirm" disabled={busy}>
          <legend>{t("codexCliUpdate.apply")}</legend>
          <p className="m-0">{t("codexCliUpdate.ready")}</p>
          <label className="row">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
            {t("codexCliUpdate.confirm")}
          </label>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={!canApply(plan, confirmed) || applying || (!!applyFailure && !applyFailure.retryable)} onClick={() => void apply()}>
              {applying ? t("codexCliUpdate.applying") : applyFailure?.retryable ? t("codexCliUpdate.retry") : t("codexCliUpdate.apply")}
            </button>
          </div>
        </fieldset>
      )}
      {applyFailure && (
        <InlineBanner tone="err" role="alert">
          <p className="m-0">{
            applyFailure.code === "local_dashboard_confirmation_required" ? t("codexCliUpdate.errLocalOnly")
              : applyFailure.code === "idempotency_conflict" ? t("codexCliUpdate.errIdempotencyConflict")
                : PERMANENT_STORE.has(applyFailure.code) ? t("codexCliUpdate.errStore")
                  : applyFailure.retryable ? t("codexCliUpdate.errRetry") : t("codexCliUpdate.errApplyFailed")
          }</p>
          {applyFailure.code === "local_dashboard_confirmation_required" && <code style={{ overflowWrap: "anywhere" }}>{applyCommand}</code>}
          <code className="text-[12px] text-fg-muted">{applyFailure.code}</code>
        </InlineBanner>
      )}
      {pairing && (
        <div className="acc-desktop__card">
          <ConnectPairingForm local target={standaloneApiTargets(apiBase).machine}
            onConnected={() => undefined}
            onCommitted={() => { setPairing(false); setApplyFailure(null); setConfirmed(false); }} />
        </div>
      )}
      {job && (
        <InlineBanner tone={job.status === "applied" && settled ? "ok" : settled ? "warn" : "info"} role="status">
          <p className="m-0">{t(JOB_STATUS[settled ? job.status : job.status === "queued" ? "queued" : "running"])}</p>
          {settled && job.reason === "owner_state_unknown" && <p className="m-0">{t("codexCliUpdate.reasonOwnerStateUnknown")}</p>}
          {settled && job.reason && <p className="m-0 text-[12px] text-fg-muted">{t("codexCliUpdate.reasonLabel")}: <code>{job.reason}</code></p>}
        </InlineBanner>
      )}
      {pollFailure && job && (
        <InlineBanner tone="warn" role="alert">
          <p className="m-0">{pollFailure === "job_not_found" ? t("codexCliUpdate.errJobNotFound") : t("codexCliUpdate.errJobUnreadable")}</p>
          {pollFailure === "job_state_unavailable" && <code>{codexCliStatusCommand(job.jobId)}</code>}
        </InlineBanner>
      )}
    </section>
  );
}

export default function CodexCliUpdate({ apiBase, connected = false }: { apiBase: string; connected?: boolean }) {
  const t = useT();
  // A connected Child's machine listener refuses the Codex update routes, and its shared base is the Home: the
  // wrong machine. Updates run only on the dashboard of the computer that owns the installation.
  if (connected || isConnectedRuntime()) {
    return (
      <section className="panel acc-desktop flex flex-col gap-4">
        <h2>{t("codexCliUpdate.title")}</h2>
        <InlineBanner tone="warn">{t("codexCliUpdate.connectedUnavailable")}</InlineBanner>
      </section>
    );
  }
  // Never carry a plan or a confirmation to another server.
  return <CodexCliUpdatePanel key={apiBase} apiBase={apiBase} />;
}
