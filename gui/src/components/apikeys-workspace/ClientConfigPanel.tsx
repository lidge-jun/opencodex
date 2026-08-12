/**
 * Client config export panel (devlog 260731_client_config_export/040, reshaped by
 * 260802/010).
 *
 * One compact row per export client — mark, name, destination, model count, and the
 * two transport actions. The config bytes are NOT rendered at rest: they are cargo the
 * user moves to another file, not an answer the page owes them, so inspection lives
 * behind `Details`. Both transport actions stay on the surface at all times.
 *
 * Still renders only what `GET /api/client-config` returns; it never builds a config
 * locally, so the bytes copied here are the bytes `ocx export` writes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { CopyableExample } from "../../pages/api-keys-copy";
import { CLIENTS, CLIENT_LABEL_KEYS, type ClientConfigEnvelope, type ExportClientId } from "./client-config-clients";
import ClientConfigRow from "./ClientConfigRow";
import ClientConfigDialog from "./ClientConfigDialog";

/** The open dialog. The trigger to restore focus to lives in a ref, not here. */
interface OpenDetails {
  client: ExportClientId;
  envelope: ClientConfigEnvelope;
  json: string;
}

export default function ClientConfigPanel({
  apiBase,
  baseUrl,
  hasKeys,
}: {
  apiBase: string;
  /** Known independently of the catalog, so it survives every row failing (003 §4). */
  baseUrl: string;
  hasKeys: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState<OpenDetails | null>(null);
  /** One live region for the whole panel: N rows must not mean N announcers. */
  const [announcement, setAnnouncement] = useState("");
  /**
   * Where focus goes when the dialog closes. Held in a ref rather than restored
   * inside the state updater: calling `.focus()` while the `<dialog>` is still
   * in the top layer is undone by its own close, which drops focus to `<body>`.
   * Observed in Chrome — the happy-dom test could not see it, because happy-dom
   * has no top layer. The restore therefore runs in an effect, after React has
   * unmounted the dialog.
   */
  const restoreFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open !== null) return;
    const trigger = restoreFocusRef.current;
    if (!trigger) return;
    restoreFocusRef.current = null;
    // `isConnected` guards the case where the row was replaced while the dialog
    // was open; focusing a detached node silently sends focus to <body>.
    if (trigger.isConnected) trigger.focus();
  }, [open]);

  /**
   * `qualified` distinguishes the two callers: a row announces which client it
   * copied, because two rows are on screen; the dialog does not, because its
   * title already names the client. That is why both announcement strings exist.
   */
  const copyJson = useCallback(async (client: ExportClientId, json: string, qualified: boolean) => {
    try {
      await navigator.clipboard.writeText(json);
      setAnnouncement(qualified
        ? t("api.clientConfig.copiedAnnounceClient", { client: t(CLIENT_LABEL_KEYS[client]) })
        : t("api.clientConfig.copiedAnnounce"));
    } catch {
      setAnnouncement(t("api.clientConfig.copyFailed"));
    }
  }, [t]);

  const downloadJson = useCallback((_client: ExportClientId, envelope: ClientConfigEnvelope, json: string) => {
    // Mechanics per ClaudeDesktop.exportProfile: the anchor is an implementation
    // detail of a real <button>, and the filename comes from the envelope so it
    // matches the destination file's own name.
    const url = URL.createObjectURL(new Blob([json], { type: envelope.mediaType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = envelope.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    // "Downloaded", never "applied": a file in ~/Downloads changed nothing yet.
    setAnnouncement(t("api.clientConfig.downloadedAnnounce", {
      filename: envelope.filename,
      destination: envelope.destination,
    }));
  }, [t]);

  const closeDialog = useCallback(() => setOpen(null), []);

  const openDetails = useCallback((
    client: ExportClientId,
    envelope: ClientConfigEnvelope,
    json: string,
    trigger: HTMLButtonElement | null,
  ) => {
    // Recorded on OPEN, not on close. Writing it from inside the close updater
    // was impure, and StrictMode's second invocation — which sees `null` — then
    // wiped it, dropping focus to <body>. Verified in Chrome; happy-dom has no
    // top layer and could not reproduce it.
    restoreFocusRef.current = trigger;
    setOpen({ client, envelope, json });
  }, []);

  return (
    <section className="panel api-panel awi-clientconfig-panel">
      <div className="api-panel-head awi-clientconfig-head">
        <h3 className="panel-title">{t("api.clientConfig.title")}</h3>
      </div>

      <ul className="awi-clientconfig-rows" aria-label={t("api.clientConfig.rowsLabel")}>
        {CLIENTS.map(client => (
          <ClientConfigRow
            key={client}
            client={client}
            apiBase={apiBase}
            onOpenDetails={openDetails}
            onCopy={(c, json) => { void copyJson(c, json, true); }}
            onDownload={downloadJson}
          />
        ))}
      </ul>

      <div className="awi-clientconfig-line">
        {/* Known without the catalog, so it survives every row failing. */}
        <span className="muted text-label">{t("api.baseUrl")}</span>
        <CopyableExample text={baseUrl} />
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

      {open && (
        <ClientConfigDialog
          client={open.client}
          envelope={open.envelope}
          json={open.json}
          hasKeys={hasKeys}
          onClose={closeDialog}
          onCopy={() => { void copyJson(open.client, open.json, false); }}
          onDownload={() => downloadJson(open.client, open.envelope, open.json)}
        />
      )}
    </section>
  );
}
