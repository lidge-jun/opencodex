import { useCallback, useId, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";
import {
  loadGatewayClients,
  runGatewayClientAction,
  type GatewayClientAction,
  type GatewayClientActionOutcome,
  type GatewayClientId,
  type GatewayClientState,
  type GatewayClientStatus,
  type GatewayNoteCode,
  type GatewayOverrideCode,
} from "./gateway-clients-api";

/**
 * Antigravity and agy read their gateway from files the proxy can write, so unlike the Cursor
 * tab this one is a switch. The server owns the backup and the restore; the page only shows what
 * the status route reports and says what an action did. Both arrive as codes, translated here.
 */

/** Badge per state, in the words of the buttons next to it rather than the file tabs' "Applied". */
const BADGE: Record<GatewayClientState, { key: TKey; className: string }> = {
  connected: { key: "gatewayClients.connected", className: "badge badge-green" },
  disconnected: { key: "gatewayClients.notConnected", className: "badge badge-muted" },
  drifted: { key: "integrations.state.stale", className: "badge badge-amber" },
};

const OVERRIDE_KEYS: Record<GatewayOverrideCode, TKey> = {
  "admin-gateway": "gatewayClients.overrideAdminGateway",
  "admin-unreadable": "gatewayClients.overrideAdminUnreadable",
  "env-gateway": "gatewayClients.overrideEnv",
};

/** `null`: the restart hint is said once, in the message after an action, not as a standing note. */
const NOTE_KEYS: Record<GatewayNoteCode, TKey | null> = {
  "restart-app": null,
  "new-terminal": null,
  "no-google-sign-in": "gatewayClients.noteNoGoogleSignIn",
  "agy-follows-app": "gatewayClients.noteAgyFollowsApp",
  "settings-not-json": "gatewayClients.noteSettingsNotJson",
  "settings-not-object": "gatewayClients.noteSettingsNotObject",
  "no-restore-record": "gatewayClients.noteNoRestoreRecord",
  "agy-version": "gatewayClients.noteAgyVersion",
  "windows-unverified": "gatewayClients.noteWindowsUnverified",
  "agy-env-exported": "gatewayClients.noteAgyEnvExported",
};

const REFUSAL_KEYS: Record<string, TKey> = {
  "requires-admission-token": "gatewayClients.refusedCredential",
  "invalid-model": "gatewayClients.refusedModel",
  "unsupported-file": "gatewayClients.refusedFile",
};

const APPLY_HINT: Record<GatewayClientId, TKey> = {
  antigravity: "gatewayClients.hintAntigravity",
  agy: "gatewayClients.hintAgy",
};

interface OutcomeView { tone: "ok" | "err"; keys: TKey[]; detail: string | null }

function describeOutcome(id: GatewayClientId, action: GatewayClientAction, outcome: GatewayClientActionOutcome): OutcomeView {
  if (!outcome.reached) return { tone: "err", keys: ["gatewayClients.actionFailed"], detail: null };
  if (!outcome.ok) {
    const known = outcome.code ? REFUSAL_KEYS[outcome.code] : undefined;
    if (known) return { tone: "err", keys: [known], detail: null };
    // The text of an I/O error is the operating system's; any other unexpected refusal is shown as sent.
    return { tone: "err", keys: [outcome.code === "io-error" ? "gatewayClients.refusedIo" : "gatewayClients.refused"], detail: outcome.message };
  }
  if (action === "connect") {
    return outcome.changed
      ? { tone: "ok", keys: ["gatewayClients.doneConnected", APPLY_HINT[id]], detail: null }
      : { tone: "ok", keys: ["gatewayClients.doneUnchanged"], detail: null };
  }
  if (outcome.restore === "exact" || outcome.restore === "path-wise") {
    const done: TKey = outcome.restore === "exact" ? "gatewayClients.doneRestored" : "gatewayClients.doneRestoredPartly";
    return { tone: "ok", keys: [done, APPLY_HINT[id]], detail: null };
  }
  return { tone: "ok", keys: ["gatewayClients.doneNothing"], detail: null };
}

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
  // `null` until the user types: the field then shows what settings.json holds right now.
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<GatewayClientAction | null>(null);
  const [result, setResult] = useState<OutcomeView | null>(null);
  const modelId = useId();
  const hintId = useId();
  const badge = BADGE[client.state];
  const notes = client.notes.flatMap(note => {
    const key = NOTE_KEYS[note.code];
    return key ? [{ code: note.code, key }] : [];
  });

  const run = async (action: GatewayClientAction) => {
    setPending(action);
    setResult(null);
    const model = action === "connect" && modelDraft !== null ? modelDraft.trim() || undefined : undefined;
    const outcome = await runGatewayClientAction(apiBase, client.id, action, model);
    setResult(describeOutcome(client.id, action, outcome));
    if (outcome.ok) setModelDraft(null);
    setPending(null);
    onSettled();
  };

  return (
    <div className="cursor-card" data-gateway-client={client.id}>
      <h4>
        {client.label}{" "}
        <span className={badge.className} data-gateway-state={client.state}>{t(badge.key)}</span>
      </h4>

      {client.overrides.map(override => (
        <Notice key={override.code} tone="warn">{t(OVERRIDE_KEYS[override.code])}</Notice>
      ))}

      <div>
        <span className="field-label">{t("gatewayClients.files")}</span>
        {client.files.map(file => (
          <p key={file.path} className="integration-path">
            {file.path}{file.exists ? "" : ` · ${t("gatewayClients.fileMissing")}`}
          </p>
        ))}
      </div>

      {notes.length > 0 && (
        <ul className="muted">
          {notes.map(note => <li key={note.code}>{t(note.key)}</li>)}
        </ul>
      )}

      {client.id === "antigravity" && (
        <div className="stack">
          <label className="field-label" htmlFor={modelId}>{t("gatewayClients.model")}</label>
          <input
            id={modelId}
            className="input gateway-client-model"
            value={modelDraft ?? client.defaultModel ?? ""}
            onChange={event => setModelDraft(event.target.value)}
            disabled={pending !== null}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={hintId}
          />
          <span id={hintId} className="muted">{t("gatewayClients.modelHint")}</span>
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

      {result && (
        <Notice tone={result.tone}>
          {result.keys.map(key => t(key)).join(" ")}
          {result.detail && <> <code>{result.detail}</code></>}
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
        <GatewayClientCard key={`${apiBase}:${client.id}`} apiBase={apiBase} client={client} onSettled={() => resource.refresh()} />
      ))}
    </section>
  );
}
