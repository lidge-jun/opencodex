import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/shared";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { CompatibilityApiError, readCompatibilityCertificate, readCompatibilityRuntime, readCompatibilitySnapshot, runCompatibilityAction,
  type CompatibilityAction, type CompatibilitySnapshot } from "../desktop-compatibility-api";
import { setClientResourceData, useClientResource } from "../client-resource";
import DesktopCompatibilityStartupSetting from "./desktop-compatibility-startup-setting";

const label = { prepare: "desktopCompat.prepare", trust: "desktopCompat.trust", "remove-trust": "desktopCompat.remove", renew: "desktopCompat.renew",
  start: "desktopCompat.start", stop: "desktopCompat.stop", launch: "desktopCompat.launch", observe: "desktopCompat.observe", apply: "desktopCompat.apply" } as const;
const errorLabel = { build_unverified: "desktopCompat.blockedByBuild", egress_proxy_invalid: "desktopCompat.blockedByProxy",
  renewal_required: "desktopCompat.renew",
  native_routing_unverified: "desktopCompat.routingChanged",
  connection_unavailable: "desktopCompat.connectionUnavailable", connection_invalid: "desktopCompat.connectionUnavailable", connection_changed: "desktopCompat.connectionUnavailable",
  app_running: "desktopCompat.closeApp", local_dashboard_confirmation_required: "desktopCompat.localOnly" } as const;

function CompatibilityPanel({ apiBase, active }: { apiBase: string; active: boolean }) {
  const { t, locale } = useI18n();
  const [needsRefresh, setNeedsRefresh] = useState(false), [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null), [done, setDone] = useState(false);
  const [choice, setChoice] = useState<CompatibilityAction | null>(null), [acknowledged, setAcknowledged] = useState(false);
  const lifecycle = useRef({ alive: true, pending: false, generation: 0, operations: new Set<BoundedFetch>() });
  const certificateKey = `desktop-compatibility-certificate:${apiBase}`, runtimeKey = `desktop-compatibility-runtime:${apiBase}`;
  const certificate = useClientResource(certificateKey, signal => readCompatibilityCertificate(apiBase, signal), { enabled: active, deadlineMs: 15000, staleAfterMs: 0 });
  const runtime = useClientResource(runtimeKey, signal => readCompatibilityRuntime(apiBase, signal), { enabled: active, deadlineMs: 10000, staleAfterMs: 0, pollMs: 5000 });
  const snapshot: CompatibilitySnapshot | null = certificate.data && runtime.data ? { certificate: certificate.data, runtime: runtime.data } : null;
  const fresh = !needsRefresh && certificate.lastAttemptOk && runtime.lastAttemptOk && !certificate.refreshing && !runtime.refreshing;
  const busy = mutating || certificate.loading || runtime.loading;
  const readError = certificate.error ?? runtime.error;
  const error = actionError ?? (readError ? readError instanceof CompatibilityApiError ? readError.code : "connection_unconfirmed" : null);
  useEffect(() => {
    const current = lifecycle.current; current.alive = true;
    return () => { current.alive = false; current.generation++; current.pending = false;
      for (const op of current.operations) { op.controller.abort(); op.clear(); } current.operations.clear(); };
  }, []);
  const execute = useCallback(async (action?: CompatibilityAction) => {
    const current = lifecycle.current;
    if (current.pending) return;
    current.pending = true; const generation = ++current.generation;
    setMutating(true); setActionError(null); setDone(false); setNeedsRefresh(true);
    const op = createBoundedFetch(action ? 140000 : 15000); current.operations.add(op);
    try {
      if (action) await runCompatibilityAction(apiBase, action, op.signal);
      const value = await readCompatibilitySnapshot(apiBase, op.signal);
      if (current.alive && current.generation === generation) {
        setClientResourceData(certificateKey, value.certificate); setClientResourceData(runtimeKey, value.runtime);
        setNeedsRefresh(false); setDone(!!action); setChoice(null); setAcknowledged(false);
      }
    } catch (cause) {
      if (current.alive && current.generation === generation) { setActionError(cause instanceof CompatibilityApiError ? cause.code : "connection_unconfirmed"); setChoice(null); setAcknowledged(false); }
    } finally {
      current.operations.delete(op); op.clear();
      if (current.generation === generation) { current.pending = false; if (current.alive) setMutating(false); }
    }
  }, [apiBase, certificateKey, runtimeKey]);

  const available = !!snapshot?.certificate.supported && !!snapshot.runtime.supported;
  const idle = snapshot?.runtime.phase === "off" && !snapshot.certificate.busy;
  const running = snapshot?.runtime.phase === "running";
  const actions: CompatibilityAction[] = [];
  if (snapshot && available) {
    const cert = snapshot.certificate;
    if (idle && cert.state === "missing") actions.push({ target: "certificate", action: "prepare" });
    if (idle && cert.fingerprint) {
      if (cert.state === "prepared") actions.push({ target: "certificate", action: "trust", fingerprint: cert.fingerprint });
      // Unknown trust may still need fingerprint-verified cleanup; invalid keys cannot be acted on.
      if (["trusted", "expired", "renewal-required", "unknown"].includes(cert.state)) actions.push({ target: "certificate", action: "remove-trust", fingerprint: cert.fingerprint });
      if (["prepared", "trusted", "expired", "renewal-required"].includes(cert.state)) actions.push({ target: "certificate", action: "renew", fingerprint: cert.fingerprint });
    }
    if (idle && cert.state === "trusted") actions.push({ target: "runtime", action: "start" });
    if (running) actions.push({ target: "runtime", action: "launch" }, { target: "runtime", action: "observe" }, { target: "runtime", action: "apply" });
    if (running || snapshot.runtime.phase === "cleanup-required") actions.push({ target: "runtime", action: "stop" });
  }
  return <section className="panel">
    <h2>{t("desktopCompat.title")}</h2>
    <p className="muted text-body">{t("desktopCompat.description")}</p>
    <p className="muted text-control">{t("desktopCompat.localOnly")}</p>
    <DesktopCompatibilityStartupSetting apiBase={apiBase} active={active} />
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void execute()}>{busy ? t("common.loading") : t("desktopCompat.refresh")}</button>
    {error && <div className="notice-err" role="alert"><p>{t(error in errorLabel ? errorLabel[error as keyof typeof errorLabel] : "desktopCompat.error")}</p><code>{error}</code></div>}
    {done && <p className="notice-ok" role="status">{t("desktopCompat.done")}</p>}
    {snapshot && <>
      {!available && <p className="notice-warn">{t("desktopCompat.unsupported")}</p>}
      <dl>
        <dt>{t("desktopCompat.certificate")}</dt><dd><code>{snapshot.certificate.state}</code></dd>
        {snapshot.certificate.fingerprint && <dd className="mono text-label" style={{ overflowWrap: "anywhere" }}>{snapshot.certificate.fingerprint}</dd>}
        {snapshot.certificate.expiresAt !== undefined && <><dt>{t("desktopCompat.expiry")}</dt><dd>{new Date(snapshot.certificate.expiresAt).toLocaleString(locale)}</dd></>}
        <dt>{t("desktopCompat.runtime")}</dt><dd><code>{snapshot.runtime.phase}</code>{snapshot.runtime.usage && <> · <code>{snapshot.runtime.usage.mode}</code></>}</dd>
      </dl>
      {snapshot.certificate.renewalDue && <p className="notice-warn">{t("desktopCompat.renewalDue")}</p>}
      {snapshot.runtime.usage?.mode === "apply" && <p className="notice-warn">{t("desktopCompat.trialRisk")}</p>}
      {snapshot.runtime.usage?.mode === "observe" && snapshot.runtime.usage.phase.endsWith("awaiting-original-response") && <p className="notice-warn" role="status">{t("desktopCompat.cacheRefreshHint")}</p>}
      {snapshot.runtime.contextFailure && <p className="notice-warn" role="status">{t(errorLabel[snapshot.runtime.contextFailure])}</p>}
      {running && <p className="muted text-control">{t("desktopCompat.reconnectHint")}</p>}
      {snapshot.runtime.usage?.observation && <p className="muted text-control" role="status">{t("desktopCompat.observation", {
        json: snapshot.runtime.usage.observation.jsonSnapshots, sse: snapshot.runtime.usage.observation.streamSnapshots,
        streams: snapshot.runtime.usage.observation.validatedActiveStreams,
      })}</p>}
    </>}
    <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
      {actions.map(action => <button key={action.action} type="button" className="btn btn-ghost" disabled={busy || !fresh}
        onClick={() => {
          if (["trust", "remove-trust", "renew", "apply"].includes(action.action)) { setChoice(action); setAcknowledged(false); setDone(false); }
          else void execute(action);
        }}>{t(label[action.action])}</button>)}
    </div>
    {choice && <fieldset disabled={busy}>
      <legend>{t(label[choice.action])}</legend>
      <p className="notice-warn">{t(choice.action === "apply" ? "desktopCompat.trialRisk" : "desktopCompat.risk")}</p>
      {choice.action === "apply" && <p className="muted text-control">{t("desktopCompat.cacheRefreshHint")}</p>}
      {choice.target === "certificate" && choice.fingerprint && <code style={{ overflowWrap: "anywhere" }}>{choice.fingerprint}</code>}
      <label className="row"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{t("desktopCompat.acknowledge")}</label>
      <div className="row" style={{ gap: "var(--space-2)" }}>
        <button type="button" className="btn btn-primary" disabled={!acknowledged || !fresh} onClick={() => void execute(choice)}>{t("desktopCompat.confirm")}</button>
        <button type="button" className="btn btn-ghost" onClick={() => { setChoice(null); setAcknowledged(false); }}>{t("common.cancel")}</button>
      </div>
    </fieldset>}
  </section>;
}

export default function CodexDesktopCompatibility(props: { apiBase: string; active: boolean; connected?: boolean }) {
  const { t } = useI18n();
  if (props.connected) return <section className="panel"><h2>{t("desktopCompat.title")}</h2><p className="notice-warn">{t("desktopCompat.connectedUnavailable")}</p></section>;
  // Never carry a certificate fingerprint or outstanding confirmation to another host.
  return <CompatibilityPanel key={props.apiBase} {...props} />;
}
