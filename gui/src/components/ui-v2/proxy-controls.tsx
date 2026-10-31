import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconPower, IconRefresh, IconX } from "../../icons";
import { cn } from "@/lib/utils";

interface ProxyControlsProps {
  /** Card title, e.g. "Proxy". */
  label: string;
  /** Status next to the live dot, e.g. "Online". */
  statusLabel: string;
  /** Optional second half of the status line, e.g. how long the proxy has been up. */
  detail?: string | undefined;
  stopLabel: string;
  stoppingLabel: string;
  restartLabel: string;
  restartingLabel: string;
  stopping: boolean;
  restarting: boolean;
  onStop: () => void;
  onRestart: () => void;
  /** Optional third action (end the dashboard session on a connected client). */
  session?: { label: string; busyLabel: string; busy: boolean; onClick: () => void } | undefined;
  className?: string;
}

/*
 * Design system v2 proxy panel, in the React Bits Pro application-UI form: an outer tinted
 * frame with a header line (title, live status) around an inset raised body that holds the
 * detail and the actions. While the proxy runs, a thin white beam travels the body's edge
 * (Aceternity's moving border, done in CSS so the sidebar runs no per-frame script); it stops
 * with the proxy and under reduced motion. Restart spins while in flight and flashes a check
 * when it settles; stop stays quiet until hovered, when it turns red.
 */
export function ProxyControls({
  label,
  statusLabel,
  detail,
  stopLabel,
  stoppingLabel,
  restartLabel,
  restartingLabel,
  stopping,
  restarting,
  onStop,
  onRestart,
  session,
  className,
}: ProxyControlsProps) {
  const reduce = useReducedMotion();
  const done = useSettledFlash(restarting);
  const live = !stopping;

  return (
    <div className={cn("ui-v2 relative rounded-xl bg-surface p-1 ring-1 ring-line ring-inset", className)}>
      <div className="flex items-center gap-2 px-2 pt-0.5 pb-1.5">
        <span className="min-w-0 flex-1 truncate text-xs leading-4 font-medium text-fg-muted">{label}</span>
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs leading-4 font-medium", live ? "text-success" : "text-fg-subtle")}>
          <span className="relative inline-flex size-1.5" aria-hidden>
            {live && !reduce && <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />}
            <span className={cn("relative size-1.5 rounded-full", live ? "bg-success" : "bg-fg-subtle")} />
          </span>
          {stopping ? stoppingLabel : statusLabel}
        </span>
      </div>

      <div className={cn("ocx-beam relative flex items-center gap-1 rounded-lg bg-raised py-1 pr-1 pl-2.5 shadow-sm ring-1 ring-line ring-inset", live && "ocx-beam--on")}>
        <span className="min-w-0 flex-1 truncate text-xs leading-4 text-fg-muted tabular-nums">{detail ?? label}</span>
        {session && (
          <TrayButton onClick={session.onClick} disabled={session.busy}
            label={session.busy ? session.busyLabel : session.label} title={session.label}>
            <IconX />
          </TrayButton>
        )}
        <TrayButton onClick={onRestart} disabled={restarting}
          label={restarting ? restartingLabel : restartLabel} title={restartLabel}>
          <AnimatePresence mode="popLayout" initial={false}>
            {done ? (
              <motion.svg key="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
                strokeLinecap="round" strokeLinejoin="round" className="text-success"
                initial={reduce ? false : { scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }} transition={{ type: "spring", stiffness: 500, damping: 28 }}>
                <path d="M5 12l5 5L20 7" />
              </motion.svg>
            ) : (
              <motion.span key="refresh" className={cn("inline-flex", restarting && "animate-spin")}
                initial={reduce ? false : { scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}>
                <IconRefresh />
              </motion.span>
            )}
          </AnimatePresence>
        </TrayButton>
        <TrayButton onClick={onStop} disabled={stopping} danger
          label={stopping ? stoppingLabel : stopLabel} title={stopping ? stoppingLabel : stopLabel}>
          <IconPower />
        </TrayButton>
      </div>
    </div>
  );
}

function TrayButton({ onClick, disabled, label, title, danger, children }: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className={cn(
        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md bg-bg text-fg-muted",
        "shadow-[0_1px_2px_-1px_rgb(0_0_0/0.16)] ring-1 ring-line ring-inset",
        "transition-[background-color,color,box-shadow,scale] duration-150 ease-soft active:scale-95 active:shadow-[inset_0_1px_2px_rgb(0_0_0/0.18)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
        danger ? "hover:bg-danger-soft hover:text-danger hover:ring-danger/30" : "hover:text-fg hover:ring-line-strong",
      )}
    >
      {children}
    </button>
  );
}

/** True for a moment right after `busy` falls from true to false. */
function useSettledFlash(busy: boolean, ms = 1600): boolean {
  const [flash, setFlash] = useState(false);
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy) {
      setFlash(true);
      const timer = window.setTimeout(() => setFlash(false), ms);
      was.current = busy;
      return () => window.clearTimeout(timer);
    }
    was.current = busy;
    return undefined;
  }, [busy, ms]);
  return flash;
}
