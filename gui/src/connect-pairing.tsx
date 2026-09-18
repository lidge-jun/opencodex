import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { ApiTarget } from "./api-targets";
import { useT } from "./i18n/shared";
import { PairingError, submitConnectPairing } from "./connect-pairing-transport";
import { useCopyFeedback } from "./components/use-copy-feedback";

export function ConnectPairingForm({
  target,
  onConnected,
}: {
  target: ApiTarget;
  onConnected: () => void;
}) {
  const t = useT();
  const [grant, setGrant] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairingError["kind"] | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const copyFeedback = useCopyFeedback<string>();
  const command = `ocx gui pair --origin "${window.location.origin}"`;
  const copied = copyFeedback.outcomeFor(command);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      await submitConnectPairing(target, grant, undefined, controller.signal);
      if (!controller.signal.aborted) onConnected();
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof PairingError ? failure.kind : "unreachable");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  };

  return <section className="card connect-pairing" aria-labelledby="connect-pairing-title">
    <h2 id="connect-pairing-title">{t("connection.pairing.title")}</h2>
    <p>{t("connection.pairing.hub")}: <code>{target.serverOrigin}</code></p>
    <p>{t("connection.pairing.getCode")}</p>
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><code>{command}</code></pre>
    <button type="button" className="btn btn-ghost" onClick={() => copyFeedback.copy(command, command)}>
      {t(copied === "copied" ? "startup.copied" : "startup.copy")}
    </button>
    {copied === "unavailable" && <p role="status">{t("prov.linkCopyUnavailable")}</p>}
    <p>{t("connection.pairing.askOperator")}</p>
    <p>{t("connection.pairing.notApiKey")}</p>
    <form onSubmit={submit} className="api-form-row">
      <label htmlFor="connect-pairing-code" className="field-label">{t("connection.pairing.code")}</label>
      <input id="connect-pairing-code" name="pairingCode" value={grant}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setGrant(event.currentTarget.value)}
        autoComplete="off" spellCheck={false} disabled={busy} className="input mono"
        aria-invalid={Boolean(error) || undefined} aria-describedby={error ? "connect-pairing-error" : undefined} />
      <button type="submit" className="btn btn-primary" disabled={busy || !grant.trim()}>
        {t(busy ? "connection.pairing.submitting" : "connection.pairing.submit")}
      </button>
      {error && <p id="connect-pairing-error" className="alert alert-err" role="alert">
        {t(error === "invalid-code" ? "connection.pairing.notApiKey"
          : error === "unreachable" ? "connection.pairing.networkError"
          : error === "request-failed" ? "connection.pairing.requestError"
          : error === "invalid-response" ? "connection.pairing.responseError" : "connection.pairing.error")}
      </p>}
    </form>
    {target.transport === "relay" && <p className="text-muted">{t("connection.pairing.relayWarning")}</p>}
  </section>;
}
