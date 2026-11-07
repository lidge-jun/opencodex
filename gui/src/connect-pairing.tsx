import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { ApiTarget } from "./api-targets";
import { useT } from "./i18n/shared";
import { PairingError, submitConnectPairing } from "./connect-pairing-transport";
import { useCopyFeedback } from "./components/use-copy-feedback";
import { Button } from "@/components/ui-v2/button";

export function ConnectPairingForm({
  target,
  onConnected,
  onCommitted,
  onPairingStart,
  local = false,
  focusOnMount = false,
}: {
  target: ApiTarget;
  onConnected: (signal: AbortSignal) => void | Promise<void>;
  /** Update a surface that may unmount this form only after its handoff commits. */
  onCommitted?: () => void;
  /** Let a secret-bearing surface expire its previous disclosure lifetime. */
  onPairingStart?: () => void;
  /** Explicit local pairing for standalone operator actions; never an automatic bootstrap. */
  local?: boolean;
  focusOnMount?: boolean;
}) {
  const t = useT();
  const [grant, setGrant] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PairingError["kind"] | null>(null);
  const [validationPending, setValidationPending] = useState(false);
  const pendingHandoff = useRef<Awaited<ReturnType<typeof submitConnectPairing>> | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusOnMount) codeInput.current?.focus(); }, [focusOnMount]);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => {
    activeRequest.current?.abort();
    pendingHandoff.current?.rollback();
  }, []);
  const copyFeedback = useCopyFeedback<string>();
  const command = `ocx gui pair --origin "${window.location.origin}"`;
  const copied = copyFeedback.outcomeFor(command);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (activeRequest.current) return;
    if (!pendingHandoff.current) onPairingStart?.();
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      if (!pendingHandoff.current) {
        pendingHandoff.current = await submitConnectPairing(target, grant, undefined, controller.signal);
        if (controller.signal.aborted) {
          pendingHandoff.current.rollback();
          pendingHandoff.current = null;
          controller.signal.throwIfAborted();
        }
        setGrant("");
        setValidationPending(true);
      }
      if (!controller.signal.aborted) {
        await onConnected(controller.signal);
        controller.signal.throwIfAborted();
        pendingHandoff.current?.commit();
        pendingHandoff.current = null;
        setValidationPending(false);
        onCommitted?.();
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const kind = failure instanceof PairingError ? failure.kind : "unreachable";
        if (kind === "refused" || kind === "remote-link-unauthorized" || kind === "remote-link-forbidden") {
          pendingHandoff.current?.rollback();
          pendingHandoff.current = null;
          setValidationPending(false);
        }
        setError(kind);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  };

  // A v2 form card (React Bits `app-dialog-3` form framing): where to get the code, the code.
  return <section className="connect-pairing flex min-w-0 flex-col rounded-[12px] bg-surface p-1 font-sans text-fg ring-1 ring-line" aria-labelledby="connect-pairing-title">
    <div className="flex flex-col gap-1 px-4 pt-3 pb-3">
      <h2 id="connect-pairing-title" className="m-0 text-[15px] leading-6 font-semibold tracking-[-0.01em]">{t(local ? "connection.pairing.code" : "connection.pairing.title")}</h2>
      <p className="m-0 text-[13px] leading-5 text-fg-muted">{!local && <>{t("connection.pairing.hub")}: </>}<code className="font-mono text-fg">{target.serverOrigin}</code></p>
    </div>
    <div className="flex min-w-0 flex-col gap-3 rounded-[8px] bg-bg p-4 text-[13px] leading-5 text-fg-muted ring-1 ring-line">
      {!local && <p className="m-0">{t("connection.pairing.getCode")}</p>}
      <div className="flex min-w-0 items-start gap-1 rounded-[8px] bg-surface py-1 pr-1 pl-3 ring-1 ring-line">
        <pre className="m-0 min-w-0 flex-1 py-1.5 font-mono text-[12.5px] leading-[18px] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"><code>{command}</code></pre>
        <Button variant="ghost" size="sm" onClick={() => copyFeedback.copy(command, command)}>
          {t(copied === "copied" ? "startup.copied" : "startup.copy")}
        </Button>
      </div>
      {copied === "unavailable" && <p className="m-0" role="status">{t("prov.linkCopyUnavailable")}</p>}
      {!local && <p className="m-0">{t("connection.pairing.askOperator")}</p>}
      <p className="m-0">{t("connection.pairing.notApiKey")}</p>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="connect-pairing-code" className="text-[13px] font-semibold text-fg">{t("connection.pairing.code")}</label>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input ref={codeInput} id="connect-pairing-code" name="pairingCode" value={grant}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setGrant(event.currentTarget.value)}
            autoComplete="off" spellCheck={false} disabled={busy || validationPending} className="input mono min-w-0 flex-1 font-mono"
            aria-invalid={Boolean(error) || undefined} aria-describedby={error ? "connect-pairing-error" : undefined} />
          <Button type="submit" variant="primary" disabled={busy || (!validationPending && !grant.trim())}>
            {t(busy ? "connection.pairing.submitting" : validationPending ? "connection.pairing.retryValidation" : "connection.pairing.submit")}
          </Button>
        </div>
        {error && <p id="connect-pairing-error" className="m-0 text-[13px] text-danger" role="alert">
        {t(validationPending ? "connection.pairing.validationPending"
          : error === "invalid-code" ? "connection.pairing.notApiKey"
          : error === "unreachable" ? "connection.pairing.networkError"
          : error === "request-failed" ? "connection.pairing.requestError"
          : error === "origin-denied" ? "connection.pairing.originDenied"
          : error === "cloudflare-challenge" ? "connection.pairing.cloudflareChallenge"
          : error === "remote-link-unauthorized" || error === "remote-link-forbidden" ? "connection.pairing.sessionNotAuthorized"
          : error === "client-state-changed" ? "connection.clientStateChanged"
          : error === "invalid-response" ? "connection.pairing.responseError" : "connection.pairing.error")}
        </p>}
      </form>
      {target.transport === "relay" && <p className="m-0 text-fg-subtle">{t("connection.pairing.relayWarning")}</p>}
    </div>
  </section>;
}
