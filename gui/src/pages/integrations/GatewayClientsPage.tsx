import { useCallback, useId, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import {
  loadGatewayClients,
  runGatewayClientAction,
  type GatewayClientAction,
  type GatewayClientActionOutcome,
  type GatewayClientState,
  type GatewayClientStatus,
} from "./gateway-clients-api";

/**
 * Antigravity and agy read their gateway from files the proxy can write, so unlike the Cursor
 * tab this one is a switch. The server owns the backup and the restore; the page only shows what
 * the status route reports and relays what an action answered.
 */

const BADGE_STATE = {
  connected: "current",
  disconnected: "absent",
  drifted: "stale",
} as const satisfies Record<GatewayClientState, "current" | "absent" | "stale">;

function GatewayClientCard({
  apiBase,
  client,
  onSettled,
}: {
  apiBase: string;
  client: GatewayClientStatus;
  onSettled: () => void;
}) {
  const t = useT();
  const [model, setModel] = useState("");
  const [pending, setPending] = useState<GatewayClientAction | null>(null);
  const [outcome, setOutcome] = useState<GatewayClientActionOutcome | null>(null);
  const modelId = useId();

  const run = async (action: GatewayClientAction) => {
    setPending(action);
    setOutcome(null);
    const result = await runGatewayClientAction(apiBase, client.id, action, action === "connect" ? model.trim() || undefined : undefined);
    setOutcome(result);
    setPending(null);
    onSettled();
  };

  return (
    <div className="cursor-card" data-gateway-client={client.id}>
      <h4>
        {client.label}{" "}
        <IntegrationStateBadge state={BADGE_STATE[client.state]} installed />
      </h4>

      {client.overrides.map(override => (
        <Notice key={`${override.source}:${override.detail}`} tone="warn">
          {t(override.source === "admin_settings" ? "gatewayClients.overrideAdmin" : "gatewayClients.overrideEnv")}{" "}
          <code>{override.detail}</code>
        </Notice>
      ))}

      <strong>{t("gatewayClients.files")}</strong>
      <ul>
        {client.files.map(file => (
          <li key={file.path}>
            <code>{file.path}</code> <span className="muted">{file.role}{file.exists ? "" : ` · ${t("gatewayClients.fileMissing")}`}</span>
          </li>
        ))}
      </ul>

      {client.notes.length > 0 && (
        <ul className="muted">
          {client.notes.map(note => <li key={note}>{note}</li>)}
        </ul>
      )}

      {client.id === "antigravity" && (
        <div className="stack">
          <label className="field-label" htmlFor={modelId}>{t("gatewayClients.model")}</label>
          <input
            id={modelId}
            className="input"
            value={model}
            onChange={event => setModel(event.target.value)}
            disabled={pending !== null}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="muted">{t("gatewayClients.modelHint")}</span>
        </div>
      )}

      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" disabled={pending !== null} onClick={() => void run("connect")}>
          {t(pending === "connect" ? "gatewayClients.working" : "gatewayClients.connect")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={pending !== null || client.state === "disconnected"}
          onClick={() => void run("disconnect")}
        >
          {t(pending === "disconnect" ? "gatewayClients.working" : "gatewayClients.disconnect")}
        </button>
      </div>

      {outcome && (
        <Notice tone={outcome.ok ? "ok" : "err"}>
          {outcome.message ?? t("gatewayClients.actionFailed")}
          {outcome.notes.map(note => <span key={note}><br />{note}</span>)}
        </Notice>
      )}
    </div>
  );
}

export default function GatewayClientsPage({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT();
  const fetchClients = useCallback(async (signal: AbortSignal) => {
    const clients = await loadGatewayClients(apiBase, signal);
    if (!clients) throw new Error("gateway client status unavailable");
    return clients;
  }, [apiBase]);
  const resource = useDataSurface<GatewayClientStatus[]>(
    `integration-gateway-clients:${apiBase}`,
    [apiBase],
    fetchClients,
    { isEmpty: () => false, enabled: active },
  );
  const clients = resource.state.data ?? null;

  return (
    <section className="integration-native-page cursor-page" aria-labelledby="gateway-clients-title">
      <h3 id="gateway-clients-title">{t("gatewayClients.title")}</h3>
      <p>{t("gatewayClients.intro")}</p>
      {resource.state.showError && <Notice tone="err">{t("gatewayClients.unavailable")}</Notice>}
      {!clients && !resource.state.showError && <DataSurfaceSkeleton label={t("gatewayClients.loading")} rows={3} />}
      {clients?.map(client => (
        <GatewayClientCard key={client.id} apiBase={apiBase} client={client} onSettled={() => resource.refresh()} />
      ))}
    </section>
  );
}
