import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

interface ProxyLeverProps {
  /** Action at the middle notch, e.g. "Reload Codex models". */
  restartLabel: string;
  /** Action at the bottom, e.g. "Stop Proxy". */
  stopLabel: string;
  /** Tooltip and accessible description that says how far to pull for each action. */
  hint: string;
  /** True while the reload runs: the handle rests in the middle notch. */
  restarting: boolean;
  /** True for a moment after a reload settles: the handle flashes the success colour. */
  settled?: boolean;
  /** True once the stop is under way: the handle stays at the bottom and no longer moves. */
  stopping: boolean;
  onRestart: () => void;
  /** May resolve after a confirmation; the handle rises again unless `stopping` is set by then. */
  onStop: () => void | Promise<unknown>;
}

// Handle travel in px inside the slot, and how far the pointer moves for the full throw.
const TRAVEL = 14;
const DRAG = 26;
// Release zones as a fraction of the throw: below RESTART springs back, below STOP reloads.
const RESTART = 0.3;
const STOP = 0.82;

type Zone = "rest" | "restart" | "stop";
const zoneOf = (pos: number): Zone => (pos >= STOP ? "stop" : pos >= RESTART ? "restart" : "rest");

/*
 * The proxy row's one control: a slot lever with three stops, like a generator's main switch.
 * Pull it to the middle notch and let go to reload Codex models (it springs back up when the
 * reload settles); pull it all the way down to stop the proxy, which still asks to confirm.
 * A short pull springs back and does nothing. A click or Enter/Space is the middle notch, the
 * harmless one; End (or a full drag) is the stop. While dragging, the handle takes the colour of
 * the action it will fire on release.
 */
export function ProxyLever({ restartLabel, stopLabel, hint, restarting, settled = false, stopping, onRestart, onStop }: ProxyLeverProps) {
  const [pulled, setPulled] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; from: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const down = stopping || pulled;
  const rest = down ? 1 : restarting ? 0.5 : 0;
  const pos = drag ?? rest;
  const zone = drag === null ? (down ? "stop" : restarting ? "restart" : "rest") : zoneOf(drag);

  const stop = () => {
    if (down) return;
    setPulled(true);
    void Promise.resolve(onStop()).finally(() => setPulled(false));
  };
  const restart = () => {
    if (!down && !restarting) onRestart();
  };
  const release = (at: number) => {
    const target = zoneOf(at);
    if (target === "stop") stop();
    else if (target === "restart") restart();
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (down || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { y: event.clientY, from: rest, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const from = start.current;
    if (!from) return;
    const dy = event.clientY - from.y;
    if (Math.abs(dy) > 3) from.moved = true;
    if (from.moved) setDrag(Math.min(1, Math.max(from.from, from.from + dy / DRAG)));
  };
  const onPointerUp = () => {
    const from = start.current;
    start.current = null;
    if (!from?.moved) return;
    suppressClick.current = true;
    const at = drag ?? from.from;
    setDrag(null);
    release(at);
  };
  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    restart();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "End" || event.key === "PageDown") {
      event.preventDefault();
      stop();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      restart();
    }
  };

  return (
    <button
      type="button"
      aria-label={`${restartLabel} · ${stopLabel}`}
      aria-description={hint}
      aria-keyshortcuts="ArrowDown End"
      title={hint}
      disabled={stopping}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null; setDrag(null); }}
      className={cn(
        "group relative inline-flex h-[var(--ocx-control-h-sm)] w-7 shrink-0 cursor-grab touch-none justify-center rounded-[6px] bg-transparent",
        "transition-[background-color] duration-150 ease-soft hover:bg-accent-soft active:cursor-grabbing",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
        "disabled:pointer-events-none disabled:opacity-60",
      )}
    >
      {/* The slot, with a notch mark at each of the three stops. */}
      <span className="pointer-events-none absolute top-[4px] h-5 w-[5px] rounded-full bg-line-strong" aria-hidden />
      {[0, 0.5, 1].map(at => (
        <span key={at} className="pointer-events-none absolute left-[21px] h-px w-[3px] bg-line-strong" style={{ top: 7 + at * TRAVEL }} aria-hidden />
      ))}
      {/* The handle: a grip bar across the slot. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-[5px] h-[5px] w-3 rounded-[2px] shadow-sm",
          zone === "stop" ? "bg-danger" : zone === "restart" ? "bg-fg" : settled ? "bg-success" : "bg-fg-muted group-hover:bg-fg",
        )}
        style={{
          transform: `translateY(${pos * TRAVEL}px)`,
          transition: drag === null ? "transform 240ms cubic-bezier(0.34, 1.4, 0.64, 1), background-color 150ms" : "background-color 150ms",
        }}
      />
    </button>
  );
}
