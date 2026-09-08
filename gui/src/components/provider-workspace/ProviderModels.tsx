/** Canonical inventory and revision-bound custom-definition operations for one provider. */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import type { ModelRow } from "../../pages/models-shared";
import { putModelVisibility } from "../../model-visibility";
import { readJsonOrThrow } from "../../fetch-json";
import { createBoundedFetch } from "../../bounded-fetch";
import { catalogRefreshPending, parseCustomModelCreated, parseCustomModelInventory, type CustomModelRecord } from "../../provider-workspace/model-inventory";
import { encodedModelIdCollides } from "../../../../src/providers/slug-codec";
import ProviderModelChip from "./ProviderModelChip";

type Mutation = {
  revision: string;
  outcome: "saved" | "deleted" | "hidden" | "unconfirmed" | "rejected";
  refreshPending: boolean;
  created?: CustomModelRecord;
};
const CHIP_RENDER_CAP = 300;

type ProviderModelsProps = {
  item: WorkspaceItem;
  apiBase: string;
  availableModels: string[];
  hasLiveModels: boolean;
  selectedModels: string[];
  modelRows: ModelRow[] | null;
  modelRevision: string;
  modelRowsReady: boolean;
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  needsReauth?: boolean;
  onRetryModels?: () => void;
  onOpenAccounts?: () => void;
  onOpenModels: () => void;
};

export default function ProviderModels(props: ProviderModelsProps) {
  return <ProviderModelInventory key={JSON.stringify([props.apiBase, props.item.name])} {...props} />;
}

function ProviderModelInventory({ item, apiBase, availableModels, selectedModels,
  modelRows, modelRevision, modelRowsReady, modelsLoading = false, modelsLoadFailed = false,
  needsReauth = false, onRetryModels, onOpenAccounts, onOpenModels,
}: ProviderModelsProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [ownershipEpoch, setOwnershipEpoch] = useState(0);
  const ownershipKey = JSON.stringify([apiBase, item.name, modelRevision, ownershipEpoch]);
  const [ownership, setOwnership] = useState<{ key: string; rows: CustomModelRecord[] } | null>(null);
  const [ownershipError, setOwnershipError] = useState<string | null>(null);
  const [requestPending, setRequestPending] = useState(false);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyReset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flight = useRef(false);
  const active = useRef(true);
  const currentRevision = useRef(modelRevision);
  const searchRef = useRef<HTMLInputElement>(null);
  const recoveryRef = useRef<HTMLButtonElement>(null);
  const focusIntent = useRef<{ button: HTMLButtonElement; retained: boolean } | null>(null);
  const ownershipReady = ownership?.key === ownershipKey && ownershipError !== ownershipKey;
  const ready = modelRows !== null && modelRowsReady && !modelsLoading && !modelsLoadFailed && ownershipReady;
  const reconciled = ready && (!mutation || modelRevision !== mutation.revision);
  const busy = requestPending || (!!mutation && !reconciled);
  const rows = (modelRows ?? []).filter(row => row.provider === item.name);
  const pendingSelection = rows.some(row => row.initialSelectionPending);
  const actionsBlocked = !ready || busy || pendingSelection;
  const customModels = ownership?.rows.filter(row => row.provider === item.name) ?? [];
  const selectedSet = new Set(selectedModels);
  // Full raw inputs retain duplicate/collision protection. Native-only DTO ids are not definitions.
  const known = [...availableModels, ...(item.models ?? []), ...customModels.map(row => row.modelId), ...(item.defaultModel ? [item.defaultModel] : [])];
  const modelId = draft.trim();
  const duplicate = !!modelId && (known.includes(modelId) || encodedModelIdCollides(modelId, known));
  const visible = rows.filter(row => !row.disabled);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = visible.filter(row => [row.id, row.namespaced].some(value => value.toLowerCase().includes(normalizedQuery)));
  const labels = new Map<string, number>();
  for (const row of visible) labels.set(row.id, (labels.get(row.id) ?? 0) + 1);

  useEffect(() => { currentRevision.current = modelRevision; }, [modelRevision]);
  useEffect(() => {
    active.current = true;
    const onFocus = (event: FocusEvent) => {
      if (focusIntent.current && event.target !== focusIntent.current.button && event.target !== document.body) {
        focusIntent.current.retained = false;
      }
    };
    document.addEventListener("focusin", onFocus);
    return () => {
      active.current = false;
      document.removeEventListener("focusin", onFocus);
      if (copyReset.current !== null) clearTimeout(copyReset.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bounded = createBoundedFetch(20_000);
    void fetch(`${apiBase}/api/custom-models`, { signal: bounded.signal })
      .then(readJsonOrThrow).then(parseCustomModelInventory)
      .then(records => {
        if (cancelled) return;
        setOwnership({ key: ownershipKey, rows: records });
        setOwnershipError(null);
      }).catch(() => { if (!cancelled) setOwnershipError(ownershipKey); })
      .finally(() => bounded.clear());
    return () => { cancelled = true; bounded.controller.abort(); bounded.clear(); };
  }, [apiBase, ownershipKey]);

  useEffect(() => {
    if (!requestPending && reconciled) flight.current = false;
    const focus = focusIntent.current;
    if (focus && !focus.button.isConnected) {
      if (focus.retained && document.activeElement === document.body) (searchRef.current ?? recoveryRef.current)?.focus();
      focusIntent.current = null;
    }
  }, [requestPending, reconciled, modelRows]);

  const retry = () => {
    setOwnershipEpoch(epoch => epoch + 1);
    onRetryModels?.();
  };
  const copyModel = async (row: ModelRow) => {
    try {
      await navigator.clipboard.writeText((labels.get(row.id) ?? 0) > 1 ? row.namespaced : row.id);
      if (!active.current) return;
      setCopiedId(row.namespaced);
      if (copyReset.current !== null) clearTimeout(copyReset.current);
      copyReset.current = setTimeout(() => setCopiedId(null), 1200);
    } catch { /* Clipboard availability does not affect inventory authority. */ }
  };
  const owns = (row: ModelRow) => row.custom === true && row.native !== true && customModels.some(custom =>
    custom.id === row.customId && custom.provider === row.provider && custom.modelId === row.id);
  const actionFor = (row: ModelRow): "delete" | "hide" | null => {
    if (!ready || row.initialSelectionPending) return null;
    if (row.custom) return owns(row) ? "delete" : null;
    // A new stored override with an old DTO is not authority to hide the old representation.
    if (row.native !== true && customModels.some(custom => custom.modelId === row.id)) return null;
    return "hide";
  };
  const finish = (result: Omit<Mutation, "revision">) => {
    // A completed write still invalidates the parent if its provider tab was closed meanwhile.
    if (!active.current) { onRetryModels?.(); return; }
    // Reconciliation must observe a revision started AFTER the response, not a concurrent old read.
    setMutation({ ...result, revision: currentRevision.current });
    setRequestPending(false);
    retry();
  };

  const addCustomModel = async () => {
    if (actionsBlocked || flight.current || !modelId || duplicate) return;
    flight.current = true;
    setRequestPending(true);
    setMutation(null);
    const bounded = createBoundedFetch(60_000);
    let result: Omit<Mutation, "revision"> = { outcome: "unconfirmed", refreshPending: false };
    try {
      const response = await fetch(`${apiBase}/api/custom-models`, {
        method: "POST", signal: bounded.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: item.name, modelId }),
      });
      if (response.status === 201) {
        const body = await readJsonOrThrow(response);
        const created = parseCustomModelCreated(body, item.name, modelId);
        if (ownership?.rows.some(row => row.id === created.id)) throw new Error("Reused custom identity");
        result = { outcome: "saved", created, refreshPending: catalogRefreshPending(body) };
        if (active.current) setDraft("");
      } else if (response.status >= 400 && response.status < 500) {
        result = { outcome: "rejected", refreshPending: false };
      }
    } catch { /* Transport/invalid acknowledgement cannot prove a rollback. */ }
    finally { bounded.clear(); finish(result); }
  };

  const removeModel = async (row: ModelRow, button: HTMLButtonElement) => {
    const action = actionFor(row);
    if (actionsBlocked || flight.current || !action) return;
    if (!window.confirm(t(action === "delete" ? "models.customDeleteConfirm" : "models.hideConfirm", { name: row.namespaced }))) return;
    flight.current = true;
    setRequestPending(true);
    setMutation(null);
    focusIntent.current = { button, retained: document.activeElement === button };
    const bounded = createBoundedFetch(60_000);
    let result: Omit<Mutation, "revision"> = { outcome: "unconfirmed", refreshPending: false };
    try {
      const response = action === "delete"
        ? await fetch(`${apiBase}/api/custom-models/${encodeURIComponent(row.customId!)}`, { method: "DELETE", signal: bounded.signal })
        : await putModelVisibility(apiBase, "models", row.provider, [{ id: row.id, native: row.native === true }], false,
          (input, init) => fetch(input, { ...init, signal: bounded.signal }));
      if (response.ok) {
        const body = await readJsonOrThrow<unknown>(response);
        if (body && typeof body === "object" && !Array.isArray(body) && "ok" in body && body.ok === true) {
          result = { outcome: action === "delete" ? "deleted" : "hidden", refreshPending: catalogRefreshPending(body) };
        }
      } else if (response.status >= 400 && response.status < 500) {
        result = { outcome: "rejected", refreshPending: false };
      }
    } catch { /* Re-read both resources even when the write acknowledgement was lost. */ }
    finally { bounded.clear(); finish(result); }
  };

  const savedHidden = mutation?.created && reconciled && rows.some(row => row.customId === mutation.created?.id && row.disabled);
  const refreshFailed = mutation && (mutation.refreshPending || modelsLoadFailed || ownershipError === ownershipKey);
  const feedback = !mutation ? null
    : mutation.outcome === "unconfirmed" ? t("pws.modelMutationUnconfirmed")
    : mutation.outcome === "rejected" ? t("models.customSaveFailed")
    : mutation.outcome === "saved" ? t(refreshFailed ? "pws.modelSavedRefreshPending" : savedHidden ? "pws.modelSavedHidden" : "pws.modelSaved")
    : refreshFailed ? t("pws.modelRemovedRefreshPending")
    : t(mutation.outcome === "deleted" ? "pws.modelDefinitionDeleted" : "pws.modelHidden");

  return (
    <div className="pws-section">
      <div className="pws-section-head">
        <h3 className="pws-section-title">{t("pws.tab.models")}</h3>
        {modelRows !== null && <span className="muted">{t("pws.modelsAvailable", { count: visible.length })}</span>}
      </div>
      <div className="row">
        <button ref={recoveryRef} type="button" className="btn btn-ghost btn-sm" onClick={onOpenModels}>{t("pws.manageModelVisibility")}</button>
      </div>
      {needsReauth && <div className="pws-inline-error" role="status">
        <span>{t("pws.modelsNeedsReauth")}</span>
        {onOpenAccounts && <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAccounts}>{t("pws.tab.accounts")}</button>}
      </div>}
      {modelRowsReady && availableModels.length === 0 && visible.length > 0 && (item.models?.length ?? 0) > 0 && !needsReauth &&
        <p className="muted text-label">{t("pws.modelsConfiguredFallback")}</p>}
      {pendingSelection && <p role="status" className="muted">{t("pws.modelSelectionPending")}</p>}
      <label className="text-label pws-custom-model-label" htmlFor={`pws-custom-model-${item.name}`}>{t("models.customAdd")}</label>
      <div className="row pws-custom-model-row">
        <input id={`pws-custom-model-${item.name}`} className="input" value={draft}
          onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void addCustomModel(); }}
          placeholder={t("models.customFieldModelIdPlaceholder")} aria-label={t("models.customAdd")} disabled={requestPending} />
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { void addCustomModel(); }}
          disabled={actionsBlocked || !modelId || duplicate}>{requestPending ? t("models.customSaving") : t("models.customAddBtn")}</button>
      </div>
      {duplicate && <p className="muted text-label" role="status">{t("pws.modelKnown")}</p>}
      {feedback && <p className={mutation?.outcome === "unconfirmed" || mutation?.outcome === "rejected" ? "pws-inline-error" : "muted text-label"}
        role={mutation?.outcome === "unconfirmed" || mutation?.outcome === "rejected" ? "alert" : "status"}>{feedback}</p>}
      {savedHidden && refreshFailed && <p className="muted text-label" role="status">{t("pws.modelSavedHidden")}</p>}
      {mutation?.refreshPending && <p className="muted text-label" role="status">{t("codexAuth.catalogRefreshPending")}</p>}
      {(modelsLoadFailed || ownershipError === ownershipKey) ? <div className="pws-inline-error" role="alert">
        <span>{t(modelsLoadFailed ? "pws.modelsLoadFailed" : "pws.modelOwnershipFailed")}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={retry} disabled={requestPending}>{t("common.retry")}</button>
      </div> : (!ready || busy) && <p className="muted" role="status">{t(!modelRowsReady || modelsLoading ? "pws.modelsLoading" : "pws.modelOwnershipLoading")}</p>}
      {mutation && (mutation.outcome === "unconfirmed" || mutation.refreshPending) && !modelsLoadFailed && ownershipError !== ownershipKey &&
        <button type="button" className="btn btn-ghost btn-sm" onClick={retry} disabled={requestPending}>{t("common.retry")}</button>}
      <input ref={searchRef} type="search" className="input pws-model-search" placeholder={t("pws.modelSearchPlaceholder")}
        value={query} onChange={event => setQuery(event.target.value)} aria-label={t("pws.modelSearchPlaceholder")} />
      {modelRows !== null && visible.length === 0 ? <p className="muted">{t("pws.noModels")}</p>
        : filtered.length === 0 && modelRows !== null ? <p className="muted" role="status">{t("pws.noModelMatch")}</p>
        : <ul className="pws-model-list">{filtered.slice(0, CHIP_RENDER_CAP).map(row => <ProviderModelChip key={row.namespaced}
          row={row} disambiguate={(labels.get(row.id) ?? 0) > 1} copied={copiedId === row.namespaced}
          isDefault={row.id === item.defaultModel} selected={row.native !== true && selectedSet.has(row.id)}
          action={actionFor(row)} disabled={actionsBlocked} onCopy={() => { void copyModel(row); }}
          onRemove={button => { void removeModel(row, button); }} />)}</ul>}
      {filtered.length > CHIP_RENDER_CAP && <p className="muted text-label" style={{ marginTop: 10 }}>
        {t("pws.modelsTruncated", { shown: String(CHIP_RENDER_CAP), total: String(filtered.length) })}
      </p>}
    </div>
  );
}
