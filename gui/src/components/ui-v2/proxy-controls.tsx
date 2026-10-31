import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconPower, IconRefresh, IconX } from "../../icons";
import { cn } from "@/lib/utils";
import { Button } from "./button";

interface ProxyControlsProps {
  /** Group label, e.g. "Proxy". */
  label: string;
  /** Status text next to the live dot, e.g. "Online". */
  statusLabel: string;
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
 * Design system v2 proxy controls: one compact card instead of loose icon
 * orbs. A live status chip (pulsing dot) on the left, actions on the right.
 * The restart action is stateful (after Aceternity's stateful button): it
 * spins while the request is in flight and flashes a check once it settles,
 * so the result is visible without a toast.
 */
export function ProxyControls({
  label,
  statusLabel,
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
    <div className={cn("ui-v2 flex items-center gap-2 rounded-card bg-surface p-1.5 pl-3 ring-1 ring-inset ring-line", className)}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] leading-4 font-medium tracking-wide text-fg-subtle uppercase">{label}</span>
        <span className="inline-flex items-center gap-1.5 text-[13px] leading-5 font-medium text-fg">
          <span className="relative inline-flex size-2" aria-hidden>
            {live && !reduce && <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />}
            <span className={cn("relative size-2 rounded-full", live ? "bg-success" : "bg-fg-subtle")} />
          </span>
          <span className="truncate">{stopping ? stoppingLabel : statusLabel}</span>
        </span>
      </div>

      {session && (
        <Button variant="ghost" size="icon" onClick={session.onClick} disabled={session.busy}
          aria-label={session.busy ? session.busyLabel : session.label} title={session.label}>
          <IconX />
        </Button>
      )}

      <Button variant="outline" size="icon" onClick={onRestart} disabled={restarting}
        aria-label={restarting ? restartingLabel : restartLabel} title={restartLabel}>
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
      </Button>

      <Button variant="danger" size="icon" onClick={onStop} disabled={stopping}
        aria-label={stopping ? stoppingLabel : stopLabel} title={stopping ? stoppingLabel : stopLabel}>
        <IconPower />
      </Button>
    </div>
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

