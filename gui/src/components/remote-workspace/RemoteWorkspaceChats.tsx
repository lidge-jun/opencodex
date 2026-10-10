import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { IconArrowDown, IconChevron, IconGrip, IconX } from "../../icons";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { EVENT_TKEY, PROFILE_LABEL, STATUS_TKEY, type RemoteDevice, type RemoteSession } from "./types";
import { MAX_PANES, openPane, paneIds, parseLayout, reconcileLayout, removePane, resizeSplit, splitPane, type PaneLayout, type SplitEdge } from "./split-layout";
import { useSessionActions } from "./use-session-actions";

const DRAG_TYPE = "application/x-opencodex-session";
const EDGES: SplitEdge[] = ["left", "right", "up", "down"];

function SplitBranch({ node, renderPane, resize }: {
  node: PaneLayout; renderPane: (id: string) => ReactNode; resize: (id: string, ratio: number) => void;
}) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  if (node.type === "pane") return renderPane(node.sessionId);
  return <div ref={container} className={`remote-split-branch remote-split-branch--${node.axis}`} style={{ "--split-ratio": node.ratio } as CSSProperties}>
    <div className="remote-split-child"><SplitBranch node={node.first} renderPane={renderPane} resize={resize} /></div>
    <div role="separator" tabIndex={0} className="remote-split-divider" aria-label={t("remote.split.resize")}
      aria-orientation={node.axis === "row" ? "vertical" : "horizontal"} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(node.ratio * 100)}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => {
        if (!dragging.current || !container.current) return;
        const rect = container.current.getBoundingClientRect();
        const size = node.axis === "row" ? rect.width : rect.height;
        if (size > 0) resize(node.id, (node.axis === "row" ? event.clientX - rect.left : event.clientY - rect.top) / size);
      }}
      onPointerUp={event => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { dragging.current = false; }} onLostPointerCapture={() => { dragging.current = false; }}
      onKeyDown={event => {
        const backward = node.axis === "row" ? "ArrowLeft" : "ArrowUp", forward = node.axis === "row" ? "ArrowRight" : "ArrowDown";
        if (![backward, forward, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        resize(node.id, event.key === "Home" ? 0.2 : event.key === "End" ? 0.8 : node.ratio + (event.key === backward ? -0.05 : 0.05));
      }} />
    <div className="remote-split-child"><SplitBranch node={node.second} renderPane={renderPane} resize={resize} /></div>
  </div>;
}

export function RemoteWorkspaceChats({ apiBase, sessions, devices, selectedSessionId, stale, refresh }: {
  apiBase: string; sessions: RemoteSession[]; devices: RemoteDevice[]; selectedSessionId: string; stale: boolean; refresh: () => unknown;
}) {
  const t = useT();
  const storageKey = `ocx-remote-workspace-layout:${apiBase}`;
  const [layout, setLayout] = useState<PaneLayout | null>(() => {
    try { return parseLayout(localStorage.getItem(storageKey)); } catch { return null; }
  });
  const [active, setActive] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: SplitEdge } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  const [lastSelection, setLastSelection] = useState(selectedSessionId);
  const host = useRef<HTMLElement>(null);
  const actions = useSessionActions(apiBase, sessions, devices, stale, refresh);
  const ids = actions.sessions.map(session => session.id);
  const fallback = [...actions.sessions].reverse().find(session => session.status !== "stopped")?.id ?? ids.at(-1);
  const effectiveLayout = reconcileLayout(layout, ids, fallback);
  const visible = paneIds(effectiveLayout);
  const activeId = visible.includes(active) ? active : visible[0] ?? "";

  if (lastSelection !== selectedSessionId) {
    setLastSelection(selectedSessionId);
    if (selectedSessionId && ids.includes(selectedSessionId)) {
      setLayout(openPane(effectiveLayout, selectedSessionId, activeId));
      setActive(selectedSessionId);
    }
  } else if (layout !== effectiveLayout) setLayout(effectiveLayout);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(effectiveLayout)); } catch { /* The workspace remains usable without storage. */ }
  }, [effectiveLayout, storageKey]);
  useEffect(() => {
    if (!focusRequest) return;
    const heading = [...(host.current?.querySelectorAll<HTMLElement>("[data-pane-heading]") ?? [])].find(element => element.dataset.paneHeading === focusRequest.id);
    heading?.focus();
  }, [focusRequest]);

  const open = (id: string) => { setLayout(openPane(effectiveLayout, id, activeId)); setActive(id); };
  const split = (id: string, target: string, edge: SplitEdge) => {
    if (!ids.includes(id)) return;
    const next = splitPane(effectiveLayout, id, target, edge);
    setLayout(next);
    if (paneIds(next).includes(id)) setActive(id);
    setDragged(null); setDropTarget(null);
  };
  const close = (id: string) => {
    const next = removePane(effectiveLayout, id);
    const nextId = paneIds(next)[0] ?? "";
    setLayout(next); setActive(nextId); setFocusRequest({ id: nextId });
  };
  const startDrag = (event: DragEvent, id: string) => { event.dataTransfer.setData(DRAG_TYPE, id); event.dataTransfer.effectAllowed = "move"; setDragged(id); };
  const endDrag = () => { setDragged(null); setDropTarget(null); };
  const canSplit = (id: string, target: string) => id !== target && (visible.includes(id) || visible.length < MAX_PANES);

  const renderPane = (id: string) => {
    const session = actions.sessions.find(value => value.id === id);
    if (!session) return null;
    const disabled = session.status === "stopped" || (session.status === "failed" && session.resumable === false);
    return <section key={id} className={`remote-chat-pane remote-console-panel${id === activeId ? " is-active" : ""}`} data-session-id={id}
      aria-label={`${PROFILE_LABEL[session.profile]} · ${session.deviceName}/${session.rootLabel}`} onFocusCapture={() => setActive(id)} onPointerDown={() => setActive(id)}>
      <header className="remote-chat-pane-head">
        <div tabIndex={-1} data-pane-heading={id} className="remote-chat-pane-name" draggable onDragStart={event => startDrag(event, id)} onDragEnd={endDrag}>
          <IconGrip /><div><strong>{PROFILE_LABEL[session.profile]}</strong><small>{session.deviceName}/{session.rootLabel}</small></div>
        </div>
        <span className={`remote-status remote-status--${session.status}`}>{t(STATUS_TKEY[session.status])}</span>
        <button type="button" className="btn btn-ghost btn-sm remote-pane-close" aria-label={t("remote.split.close")} title={t("remote.split.close")} disabled={visible.length === 1} onClick={() => close(id)}><IconX /></button>
      </header>
      <small className="remote-chat-access">{session.accessMode === "read-only" ? t("remote.access.readOnly") : session.capabilities.includes("workspace.exec") ? t("remote.access.workspace") : t("remote.access.workspaceFilesOnly")}</small>
      <div className="remote-events" aria-live="polite" aria-label={t("remote.events")}>
        {session.events.length === 0 ? <p className="remote-empty">{t("remote.noEvents")}</p> : session.events.map(event => <div key={event.sequence} className={`remote-event remote-event--${event.type}`}>
          <span>{event.type === "assistant" ? PROFILE_LABEL[session.profile] : t(EVENT_TKEY[event.type])}</span><p>{event.text}</p>
        </div>)}
      </div>
      {session.status === "failed" && session.resumable === false ? <Notice tone="err">{t("remote.notResumable")}</Notice> : null}
      {actions.errors[id] ? <Notice tone="err">{actions.errors[id]}</Notice> : null}
      <label className="remote-composer"><span className="field-label">{t("remote.prompt")}</span>
        <textarea className="input" rows={3} value={actions.drafts[id] ?? ""} onChange={event => actions.setDraft(id, event.target.value)} placeholder={t("remote.promptPlaceholder")} disabled={disabled}
          onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void actions.send(session); } }} />
      </label>
      <div className="remote-console-actions">
        <button type="button" className="btn btn-primary" disabled={!actions.canSend(session)} onClick={() => void actions.send(session)}>{t("remote.send")}</button>
        <button type="button" className="btn btn-danger" disabled={actions.pending[id]?.stop || session.status === "stopped"} onClick={() => void actions.stop(session)}>{t("remote.stop")}</button>
      </div>
      {dragged && canSplit(dragged, id) ? <div className="remote-pane-drop-targets">{EDGES.map(edge => <div key={edge} className={`remote-pane-drop remote-pane-drop--${edge}${dropTarget?.id === id && dropTarget.edge === edge ? " is-over" : ""}`}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget({ id, edge }); }}
        onDrop={event => { event.preventDefault(); const source = event.dataTransfer.getData(DRAG_TYPE); if (source === dragged) split(source, id, edge); else endDrag(); }}>
        {t(`remote.split.${edge}`)}
      </div>)}</div> : null}
    </section>;
  };

  return <section ref={host} className="remote-chats-workspace" aria-label={t("remote.split.title")}>
    <div className="remote-chats-toolbar"><h3>{t("remote.sessions")}</h3><p>{t("remote.split.hint")}</p></div>
    <div className="remote-chats-layout">
      <aside className="remote-session-rail" aria-label={t("remote.sessions")}>
        {actions.sessions.map(session => <div key={session.id} className={`remote-session-row${activeId === session.id ? " is-active" : ""}`} draggable onDragStart={event => startDrag(event, session.id)} onDragEnd={endDrag}>
          <button type="button" className="remote-session-open" data-session-open={session.id} aria-pressed={activeId === session.id} title={t("remote.split.open")} onClick={() => open(session.id)}>
            <IconGrip /><span><strong>{PROFILE_LABEL[session.profile]} · {session.rootLabel}</strong><small>{session.deviceName} · {t(STATUS_TKEY[session.status])}</small></span>
          </button>
          <div className="remote-session-split-actions">
            <button type="button" className="btn btn-ghost btn-sm" title={t("remote.split.right")} aria-label={t("remote.split.right")} disabled={!activeId || !canSplit(session.id, activeId)} onClick={() => split(session.id, activeId, "right")}><IconChevron /></button>
            <button type="button" className="btn btn-ghost btn-sm" title={t("remote.split.down")} aria-label={t("remote.split.down")} disabled={!activeId || !canSplit(session.id, activeId)} onClick={() => split(session.id, activeId, "down")}><IconArrowDown /></button>
          </div>
        </div>)}
        {visible.length >= MAX_PANES ? <p className="remote-split-limit">{t("remote.split.limit")}</p> : null}
      </aside>
      <div className="remote-pane-surface">{effectiveLayout ? <SplitBranch node={effectiveLayout} renderPane={renderPane} resize={(id, ratio) => setLayout(resizeSplit(effectiveLayout, id, ratio))} /> : <p className="remote-empty remote-empty--console">{t("remote.noSessions")}</p>}</div>
    </div>
  </section>;
}
