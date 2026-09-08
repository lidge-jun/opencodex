import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { readJsonOrThrow } from "../fetch-json";
import { IconArrowDown, IconArrowUp, IconGrip } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import {
  customPickerRows, isPickerOrderSaved, isPickerOrderSettings, movePickerBefore,
  pickerSnapshotSignature, stepPickerOrder, type PickerModelIdentity, type PickerOrderSaved,
} from "../model-picker-order";

type Receipt = PickerOrderSaved & { catalogRefresh?: unknown };
type Snapshot = { signature: string; identities: string; order: string[]; fixed: string[] };
const DRAG_TYPE = "application/x-ocx-picker-order";
let dragSequence = 0;
/** Local drag identity, not a security token. Like newClientId, supports LAN HTTP. */
function newDragToken(): string {
  const sequence = ++dragSequence;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try { return `${sequence}:${crypto.randomUUID()}`; }
    catch { /* Some browsers expose randomUUID but reject it outside secure contexts. */ }
  }
  return `picker-${Date.now().toString(36)}-${sequence}`;
}

export default function ModelPickerOrderEditor({ apiBase, active, identities, onAccepted, onBusyChange }: {
  apiBase: string; active: boolean; identities: readonly PickerModelIdentity[];
  onAccepted: (receipt: Receipt) => void; onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<TKey | null>(null);
  const [error, setError] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const lifetime = useRef({
    generation: 0,
    flight: null as BoundedFetch | null,
    drag: null as { id: string; token: string } | null,
  });
  const [activation, setActivation] = useState({ apiBase, active, onBusyChange });
  const identitySignature = JSON.stringify(identities.map(({ provider, id, namespaced }) => [provider, id, namespaced]));
  const latestIdentitySignature = useRef(identitySignature);
  useLayoutEffect(() => { latestIdentitySignature.current = identitySignature; }, [identitySignature]);
  const identityChanged = snapshot !== null && snapshot.identities !== identitySignature;
  const disabled = !active || busy || !snapshot || blocked !== null || identityChanged;
  const dirty = snapshot !== null && JSON.stringify(draft) !== JSON.stringify(snapshot.order);
  const clearDrag = useCallback(() => { lifetime.current.drag = null; setDragging(null); setOver(null); }, []);

  // Reconcile before committing children, like the existing display-name dialog.
  if (activation.apiBase !== apiBase || activation.active !== active || activation.onBusyChange !== onBusyChange) {
    setActivation({ apiBase, active, onBusyChange });
    setSnapshot(null); setDraft([]); setBlocked(null); setError(false); setBusy(false);
  }
  const [dragContext, setDragContext] = useState({ disabled, snapshot, identitySignature });
  if (dragContext.disabled !== disabled || dragContext.snapshot !== snapshot || dragContext.identitySignature !== identitySignature) {
    setDragContext({ disabled, snapshot, identitySignature });
    setDragging(null); setOver(null);
  }

  // Capture the stable holder, but always abort its CURRENT flight during cleanup.
  useLayoutEffect(() => {
    const holder = lifetime.current;
    holder.generation++;
    return () => {
      holder.generation++;
      holder.flight?.controller.abort(); holder.flight?.clear(); holder.flight = null;
      holder.drag = null; onBusyChange(false);
    };
  }, [apiBase, active, onBusyChange]);
  useLayoutEffect(() => { lifetime.current.drag = null; }, [disabled, snapshot, identitySignature]);

  const run = async (save: boolean) => {
    if (!active || lifetime.current.flight || (save && (disabled || !dirty))) return;
    const owner = lifetime.current.generation, bounded = createBoundedFetch(15_000);
    lifetime.current.flight = bounded; setBusy(true); onBusyChange(true); setError(false); clearDrag();
    const owns = () => lifetime.current.generation === owner && lifetime.current.flight === bounded;
    const current = () => owns() && !bounded.signal.aborted
      && latestIdentitySignature.current === identitySignature;
    try {
      const response = await fetch(`${apiBase}/api/subagent-models`, { signal: bounded.signal });
      if (!current()) return;
      const settings = await readJsonOrThrow<unknown>(response);
      if (!current()) return;
      if (!isPickerOrderSettings(settings)) throw new Error("Invalid picker settings");
      const signature = pickerSnapshotSignature(apiBase, owner, settings);
      if (save && (!snapshot || signature !== snapshot.signature || identitySignature !== snapshot.identities)) {
        setBlocked("models.pickerOrder.changed"); return;
      }
      const rows = customPickerRows(settings, identities);
      if (!rows) {
        setBlocked(settings.pickerOrder.some(id => !id.includes("/"))
          ? "models.pickerOrder.nativeLocked" : settings.chosen === undefined
            ? "models.pickerOrder.unknownChosen" : "models.pickerOrder.catalogRequired");
        return;
      }
      if (!save) {
        setSnapshot({ ...rows, signature, identities: identitySignature }); setDraft(rows.order);
        setBlocked(null); setAnnouncement(""); return;
      }
      const result = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: bounded.signal,
        body: JSON.stringify({ pickerOrder: draft, pickerOrderMode: null }),
      });
      if (!current()) return;
      const receipt = await readJsonOrThrow<unknown>(result);
      if (!current()) return;
      if (!isPickerOrderSaved(receipt) || !("ok" in receipt) || receipt.ok !== true) throw new Error("Invalid picker receipt");
      setDraft(receipt.pickerOrder); setBlocked("models.pickerOrder.savedReload");
      onAccepted({ pickerOrder: receipt.pickerOrder, pickerOrderMode: receipt.pickerOrderMode,
        catalogRefresh: "catalogRefresh" in receipt ? receipt.catalogRefresh : undefined });
    } catch {
      if (owns() && latestIdentitySignature.current === identitySignature) setError(true);
      // Current-identity timeouts surface an error; stale identities retain the draft silently.
    } finally {
      bounded.clear();
      if (owns()) { lifetime.current.flight = null; setBusy(false); onBusyChange(false); }
    }
  };
  const enter = useEffectEvent(async () => {
    const holder = lifetime.current, owner = holder.generation;
    // Automatic startup is cancellable before issuing transport; event actions stay immediate.
    await Promise.resolve();
    if (active && holder.generation === owner) void run(false);
  });
  useEffect(() => { if (active) void enter(); }, [apiBase, active, onBusyChange]);

  const move = (id: string, next: string[]) => {
    if (disabled) return;
    setDraft(next);
    setAnnouncement(t("models.pickerOrder.position", { model: id, position: next.indexOf(id) + 1, total: next.length }));
    clearDrag();
  };
  const draftSet = new Set(draft);
  const fixedSet = new Set(snapshot?.fixed);
  const movable = (id: string) => !disabled && draftSet.has(id) && !fixedSet.has(id);
  const dragOver = (event: DragEvent<HTMLLIElement>, id: string) => {
    if (!lifetime.current.drag || lifetime.current.drag.id === id || !movable(lifetime.current.drag.id) || !movable(id)
      || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(id);
  };
  return <section className="picker-order-editor" aria-label={t("models.pickerOrder.custom")} aria-busy={busy}>
    <p className="muted text-label">{t("models.pickerOrder.editorHint")}</p>
    {(blocked || identityChanged) && <p role="alert">{t(blocked ?? "models.pickerOrder.changed")}</p>}
    {error && <p role="alert">{t("models.pickerOrder.requestFailed")}</p>}
    {snapshot && draft.length === 0 && <p>{t("models.pickerOrder.empty")}</p>}
    <ol className="picker-order-list">
      {draft.map((id, index) => {
        const fixed = fixedSet.has(id);
        return <li key={id} className={`picker-order-row${dragging === id ? " cwi-target-row--dragging" : ""}${over === id ? " cwi-target-row--drop" : ""}`}
          onDragOver={event => dragOver(event, id)}
          onDragLeave={() => setOver(null)}
          onDrop={event => {
            const source = lifetime.current.drag;
            if (source && source.id !== id && source.token === event.dataTransfer.getData(DRAG_TYPE) && movable(source.id) && movable(id)) {
              event.preventDefault(); move(source.id, movePickerBefore(draft, source.id, id, snapshot?.fixed ?? []));
            }
            clearDrag();
          }} onDragEnd={clearDrag}>
          <button type="button" className="cwi-target-grip" disabled={disabled || fixed} draggable={!disabled && !fixed}
            aria-label={t("models.pickerOrder.dragModel", { model: id })}
            onDragStart={event => {
              if (!movable(id)) { event.preventDefault(); return; }
              const token = newDragToken(); lifetime.current.drag = { id, token }; setDragging(id);
              event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(DRAG_TYPE, token);
            }}><IconGrip width={14} height={14} aria-hidden="true" /></button>
          <code className="picker-order-name">{id}</code>
          {fixed && <span className="muted text-caption">{t("models.pickerOrder.featured")}</span>}
          <span className="picker-order-actions">
            <button type="button" className="btn btn-ghost btn-sm"
              disabled={disabled || fixed || index === 0 || fixedSet.has(draft[index - 1]!)}
              aria-label={t("models.pickerOrder.upModel", { model: id })}
              onClick={() => move(id, stepPickerOrder(draft, id, -1, snapshot?.fixed ?? []))}>
              <IconArrowUp width={14} height={14} aria-hidden="true" /></button>
            <button type="button" className="btn btn-ghost btn-sm"
              disabled={disabled || fixed || index === draft.length - 1 || fixedSet.has(draft[index + 1]!)}
              aria-label={t("models.pickerOrder.downModel", { model: id })}
              onClick={() => move(id, stepPickerOrder(draft, id, 1, snapshot?.fixed ?? []))}>
              <IconArrowDown width={14} height={14} aria-hidden="true" /></button>
          </span>
        </li>;
      })}
    </ol>
    <p role="status" aria-live="polite">{announcement}</p>
    <div className="row">
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !dirty} onClick={() => void run(true)}>
        {t(busy ? "models.pickerOrder.applying" : "models.pickerOrder.saveDraft")}</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!active || busy} onClick={() => void run(false)}>
        {t("models.pickerOrder.reloadDraft")}</button>
    </div>
  </section>;
}
