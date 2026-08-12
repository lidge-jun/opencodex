/**
 * One export client, one row (devlog 260802/010).
 *
 * The row carries identity plus the two transport actions; inspection lives in
 * the dialog. Each row owns its own request, so one client's 503 cannot disable
 * the other's buttons — the failure boundary is the row, not the panel.
 */
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
import { CLIENT_LABEL_KEYS, CLIENT_MARKS, type ClientConfigEnvelope, type ExportClientId } from "./client-config-clients";

export default function ClientConfigRow({
  client,
  apiBase,
  onOpenDetails,
  onCopy,
  onDownload,
}: {
  client: ExportClientId;
  apiBase: string;
  /** Passed the trigger element so the dialog can restore focus on close. */
  onOpenDetails: (client: ExportClientId, envelope: ClientConfigEnvelope, json: string, trigger: HTMLButtonElement | null) => void;
  onCopy: (client: ExportClientId, json: string) => void;
  onDownload: (client: ExportClientId, envelope: ClientConfigEnvelope, json: string) => void;
}) {
  const t = useT();
  /** Bumped by retry so the same client refetches without a fake client change. */
  const [attempt, setAttempt] = useState(0);
  /**
   * `apiBase` is part of the identity, not just a dependency: without it a result
   * fetched from the previous origin still matched the key after the origin
   * changed, leaving stale bytes copyable while the replacement was in flight.
   */
  const requestKey = [apiBase, client, String(attempt)].join("|");
  /**
   * Every settled result carries the request it belongs to, and `loading` is
   * derived from that tag rather than reset in the effect body — otherwise a
   * superseded response can land on top of a newer one.
   */
  const [result, setResult] = useState<
    { key: string; data: ClientConfigEnvelope | null; failed: boolean } | null
  >(null);

  useEffect(() => {
    const controller = new AbortController();
    // `cancelled` is what actually gates the setters; abort only stops the
    // request. Both stay, because a reader cannot tell from the setter call
    // that a superseded run can no longer write.
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/client-config?client=${encodeURIComponent(client)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        const envelope = await res.json() as ClientConfigEnvelope;
        if (cancelled) return;
        setResult({ key: requestKey, data: envelope, failed: false });
      } catch {
        if (cancelled) return;
        // A flag, not a message: the row renders its own localized sentence, so
        // parsing the body only pulled `t` into the deps and refetched on every
        // locale change for a string nothing displayed.
        setResult({ key: requestKey, data: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBase, client, requestKey]);

  const settled = result !== null && result.key === requestKey ? result : null;
  const data = settled?.data ?? null;
  const failed = settled?.failed ?? false;
  const loading = settled === null;

  const label = t(CLIENT_LABEL_KEYS[client]);
  const mark = CLIENT_MARKS[client];
  // The server renders the client's own format; re-serializing as JSON here
  // would hand a TOML or YAML client bytes its parser cannot read.
  const json = data?.text ?? "";

  const openDetails = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (data) onOpenDetails(client, data, json, event.currentTarget);
  }, [client, data, json, onOpenDetails]);

  return (
    <li className="awi-clientconfig-row">
      <span className="awi-clientconfig-mark" aria-hidden="true">
        {mark
          ? <img src={mark} alt="" width={20} height={20} />
          : <span className="awi-clientconfig-monogram">{label.slice(0, 1)}</span>}
      </span>

      <span className="awi-clientconfig-identity">
        <span className="awi-clientconfig-name">{label}</span>
        <span className="muted text-label awi-clientconfig-meta">
          {loading
            ? t("api.clientConfig.loading")
            : failed || !data
              ? <span role="alert">{t("api.clientConfig.rowError", { client: label })}</span>
              : t("api.clientConfig.rowMeta", { destination: data.destination, count: data.modelCount })}
        </span>
      </span>

      <span className="awi-clientconfig-row-actions">
        {failed && !loading ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttempt(n => n + 1)}>
            {t("common.retry")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              aria-label={t("api.clientConfig.copyAria", { client: label })}
              disabled={!data}
              onClick={() => { if (data) onCopy(client, json); }}
            >
              {t("api.clientConfig.copy")}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={t("api.clientConfig.downloadAria", { client: label })}
              disabled={!data}
              onClick={() => { if (data) onDownload(client, data, json); }}
            >
              {t("api.clientConfig.download")}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t("api.clientConfig.detailsAria", { client: label })}
              disabled={!data}
              onClick={openDetails}
            >
              {t("api.clientConfig.details")}
            </button>
          </>
        )}
      </span>
    </li>
  );
}
