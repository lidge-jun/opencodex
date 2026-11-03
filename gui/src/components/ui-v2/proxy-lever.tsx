import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

interface ProxyLeverProps {
  /** Accessible name and tooltip, e.g. "Stop". */
  label: string;
  /** True once the stop is under way: the lever stays down and no longer moves. */
  down: boolean;
  /** Called when the lever is thrown. May resolve after a confirmation; the lever rises again unless `down` is set by then. */
  onThrow: () => void | Promise<unknown>;
}

// The arm swings about the pivot from UP (running) to DOWN (stopped). Positive is clockwise in SVG.
const UP = -40;
const DOWN = 40;
// A drag commits once the arm is past this angle; short of it the lever springs back.
const COMMIT = 12;
// Pixels of downward drag that sweep the whole arc.
const TRAVEL = 24;
const PIVOT = { x: 8, y: 14 };
const ARM = 14;

/*
 * The proxy stop control as a pull-down lever, like a generator's main switch: grab the knob and
 * pull it down (or click it, or press Enter/Space) to stop. A short drag that is let go above the
 * commit angle springs back, so brushing it does nothing. The stop itself still asks for
 * confirmation; the lever rests down only while that is pending or once the stop is under way.
 */
export function ProxyLever({ label, down, onThrow }: ProxyLeverProps) {
  const [pulled, setPulled] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const lowered = down || pulled;
  const angle = drag ?? (lowered ? DOWN : UP);

  const fire = () => {
    if (lowered) return;
    setPulled(true);
    void Promise.resolve(onThrow()).finally(() => setPulled(false));
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (lowered || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { y: event.clientY, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const from = start.current;
    if (!from) return;
    const dy = event.clientY - from.y;
    if (Math.abs(dy) > 3) from.moved = true;
    if (from.moved) setDrag(Math.min(DOWN, Math.max(UP, UP + (dy / TRAVEL) * (DOWN - UP))));
  };
  const onPointerUp = () => {
    const from = start.current;
    start.current = null;
    if (!from?.moved) return;
    suppressClick.current = true;
    const committed = (drag ?? UP) >= COMMIT;
    setDrag(null);
    if (committed) fire();
  };
  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    fire();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      fire();
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={down}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null; setDrag(null); }}
      className={cn(
        "group inline-flex h-[var(--ocx-control-h-sm)] w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-[6px] bg-transparent text-fg-subtle",
        "transition-[background-color,color] duration-150 ease-soft active:cursor-grabbing",
        "hover:bg-danger-soft hover:text-danger",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
        "disabled:pointer-events-none disabled:opacity-60",
      )}
    >
      <svg viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden>
        {/* The knob's path with a stop at each end of the throw, and the hub housing the pivot. */}
        <circle cx={PIVOT.x} cy={PIVOT.y} r={ARM} stroke="var(--ocx-line-strong)" strokeWidth={1.5} strokeLinecap="round"
          strokeDasharray={`${SWEEP} ${2 * Math.PI * ARM - SWEEP}`} strokeDashoffset={SWEEP / 2} />
        {[UP, DOWN].map(deg => <line key={deg} {...stop(deg)} stroke="var(--ocx-line-strong)" strokeWidth={1.5} strokeLinecap="round" />)}
        <circle cx={PIVOT.x} cy={PIVOT.y} r={5} fill="var(--ocx-line-strong)" />
        <g
          style={{
            transform: `rotate(${angle}deg)`,
            transformBox: "view-box",
            transformOrigin: `${PIVOT.x}px ${PIVOT.y}px`,
            transition: drag === null ? "transform 260ms cubic-bezier(0.34, 1.36, 0.64, 1)" : "none",
          }}
        >
          <line x1={PIVOT.x} y1={PIVOT.y} x2={PIVOT.x + ARM} y2={PIVOT.y} stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />
          <circle cx={PIVOT.x + ARM} cy={PIVOT.y} r={3.5} fill="currentColor" />
        </g>
        <circle cx={PIVOT.x} cy={PIVOT.y} r={2.2} fill="currentColor" />
      </svg>
    </button>
  );
}

/** Length of the arc the knob travels along; the throw is symmetric about 3 o'clock, where a circle's stroke starts. */
const SWEEP = ((DOWN - UP) / 180) * Math.PI * ARM;

/** A short radial stop across the knob's path at `deg`. */
function stop(deg: number) {
  const cos = Math.cos((deg * Math.PI) / 180);
  const sin = Math.sin((deg * Math.PI) / 180);
  return {
    x1: PIVOT.x + (ARM - 2.5) * cos, y1: PIVOT.y + (ARM - 2.5) * sin,
    x2: PIVOT.x + (ARM + 2.5) * cos, y2: PIVOT.y + (ARM + 2.5) * sin,
  };
}
