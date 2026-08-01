/**
 * Client config export panel (devlog 260731_client_config_export/040).
 *
 * Renders what `GET /api/client-config` returns — it never builds a config locally, so the
 * bytes shown here are the bytes `ocx export` writes. Five states per 003 §4: loading,
 * ready, degraded (models without context limits), empty-key (informational, never
 * blocking), and error (retry, base URL stays visible, no partial JSON).
 */
import { useCallback, useEffect, useState } from "react";
import { DataSurfaceSkeleton } from "../data-surface";
import { useT } from "../../i18n/shared";
import { apiErrorMessage } from "../../api-error";
import { CopyableExample } from "../../pages/api-keys-copy";

/** Both clients the route serves. Kept in sync with EXPORT_CLIENT_IDS in src/clients/config-export.ts. */
const CLIENTS = ["opencode", "pi"] as const;
type ClientId = (typeof CLIENTS)[number];

/** The `/api/client-config` 200 envelope, read off the route rather than the design doc. */
interface ClientConfigEnvelope {
  client: ClientId;
  /** Download filename. Server-owned: the panel must never name the file itself (003 §5). */
  filename: string;
  destination: string;
  apiKeyEnv: string;
  exportHint: string;
  modelCount: number;
  modelsWithoutLimits: number;
  config: unknown;
}

const CLIENT_LABEL_KEYS = {
  opencode: "api.clientConfig.clientOpencode",
  pi: "api.clientConfig.clientPi",
} as const;

export default function ClientConfigPanel({
  apiBase,
  baseUrl,
  hasKeys,
}: {
  apiBase: string;
  /** Known independently of the catalog, so an error state can still show it (003 §4). */
  baseUrl: string;
  hasKeys: boolean;
}) {
  const t = useT();
  const [client, setClient] = useState<ClientId>("opencode");
  /** Bumped by retry so the same client refetches without a fake client change. */
  const [attempt, setAttempt] = useState(0);
  /**
   * Every settled result and announcement carries the request it belongs to, and `loading`
   * is derived from that tag rather than reset in the effect body. Clearing state
   * synchronously on each client switch was a cascading render, and it also left a window
   * where a stale payload could be copied under the newly selected client.
   */
  const requestKey = `${client}:${attempt}`;
  const [result, setResult] = useState<
    { key: string; data: ClientConfigEnvelope | null; error: string | null } | null
  >(null);
  const [announced, setAnnounced] = useState<{ key: string; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/client-config?client=${encodeURIComponent(client)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await apiErrorMessage(res, t("api.clientConfig.loadFailed")));
        const envelope = await res.json() as ClientConfigEnvelope;
        if (controller.signal.aborted) return;
        setResult({ key: requestKey, data: envelope, error: null });
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error && cause.message ? cause.message : t("api.clientConfig.loadFailed");
        setResult({ key: requestKey, data: null, error: message });
      }
    })();
    return () => controller.abort();
  }, [apiBase, client, requestKey, t]);

  const settled = result !== null && result.key === requestKey ? result : null;
  const loading = settled === null;
  const data = settled?.data ?? null;
  const error = settled?.error ?? null;
  const announcement = announced !== null && announced.key === requestKey ? announced.text : "";

  // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- file content newline, not UI text
  const json = data ? `${JSON.stringify(data.config, null, 2)}\n` : "";

  const copyJson = useCallback(async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(json);
      setAnnounced({ key: requestKey, text: t("api.clientConfig.copiedAnnounce") });
    } catch {
      setAnnounced({ key: requestKey, text: t("api.clientConfig.copyFailed") });
    }
  }, [data, json, requestKey, t]);

  const downloadJson = useCallback(() => {
    if (!data) return;
    // Mechanics per ClaudeDesktop.exportProfile: the anchor is an implementation detail of a
    // real <button>, and the filename comes from the envelope so it matches the destination
    // file's own name.
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = data.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    // "Downloaded", never "applied": a file in ~/Downloads changed nothing yet (003 §5).
    setAnnounced({
      key: requestKey,
      text: t("api.clientConfig.downloadedAnnounce", {
        filename: data.filename,
        destination: data.destination,
      }),
    });
  }, [data, json, requestKey, t]);

  return (
    <section className="panel api-panel awi-clientconfig-panel">
      <div className="api-panel-head awi-clientconfig-head">
        <h3 className="panel-title">{t("api.clientConfig.title")}</h3>
        <span className="awi-clientconfig-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => { void copyJson(); }}
            disabled={!data}
          >
            {t("api.clientConfig.copy")}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={downloadJson}
            disabled={!data}
          >
            {t("api.clientConfig.download")}
          </button>
        </span>
      </div>

      <div className="segmented awi-clientconfig-segmented" role="radiogroup" aria-label={t("api.clientConfig.clientLabel")}>
        {CLIENTS.map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={client === option}
            className={`btn btn-sm${client === option ? " btn-primary" : " btn-ghost"}`}
            onClick={() => setClient(option)}
          >
            {t(CLIENT_LABEL_KEYS[option])}
          </button>
        ))}
      </div>

      {loading ? (
        // Owns the only live region for this transition; the announcement region below is not
        // rendered while cold (data-surface.tsx header rule).
        <DataSurfaceSkeleton label={t("api.clientConfig.loading")} rows={4} className="awi-clientconfig-skeleton" />
      ) : error !== null || !data ? (
        <div className="awi-clientconfig-error">
          {/* No partial JSON here: without the model list the config cannot be produced honestly. */}
          <p className="muted small" role="alert">{error ?? t("api.clientConfig.loadFailed")}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttempt(n => n + 1)}>
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <>
          <pre
            className="api-code api-example-pre awi-clientconfig-json"
            tabIndex={0}
            role="group"
            aria-label={t("api.clientConfig.jsonLabel", { client: t(CLIENT_LABEL_KEYS[client]) })}
          >{json}</pre>
          <p className="muted small awi-clientconfig-count">
            {t("api.clientConfig.modelCount", { count: data.modelCount })}
          </p>
          {data.modelsWithoutLimits > 0 && (
            <p className="muted small awi-clientconfig-degraded">
              {t("api.clientConfig.missingLimits", { count: data.modelsWithoutLimits, total: data.modelCount })}
            </p>
          )}
          {!hasKeys && (
            // Informational, never blocking: an agent may legitimately want the shape first,
            // so both actions stay enabled (003 §3).
            <p className="muted small awi-clientconfig-nokey">
              {t("api.clientConfig.noKeyYet", { env: data.apiKeyEnv })}
            </p>
          )}
          <div className="awi-clientconfig-line">
            <span className="muted text-label">{t("api.clientConfig.destination")}</span>
            <CopyableExample text={data.destination} />
          </div>
          <div className="awi-clientconfig-line">
            <span className="muted text-label">{t("api.clientConfig.envHint")}</span>
            <CopyableExample text={data.exportHint} />
          </div>
          <p className="muted small awi-clientconfig-merge">{t("api.clientConfig.mergeWarning")}</p>
        </>
      )}

      <div className="awi-clientconfig-line">
        {/* Known without the catalog, so it survives the error state. */}
        <span className="muted text-label">{t("api.baseUrl")}</span>
        <CopyableExample text={baseUrl} />
      </div>

      <details className="awi-clientconfig-where">
        <summary className="muted text-label">{t("api.clientConfig.whereDisclosure")}</summary>
        <p className="muted small">{t("api.clientConfig.whereBody")}</p>
      </details>

      {/* Copy/download announcements only once the surface is ready, so the skeleton and this
          region never speak for the same transition. */}
      {!loading && data !== null && (
        <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      )}
    </section>
  );
}
