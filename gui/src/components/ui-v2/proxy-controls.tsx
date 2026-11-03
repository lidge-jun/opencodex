import { useEffect, useRef, useState, type ReactNode } from "react";
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
 * Design system v2 proxy status, as one sidebar row: a static status dot, the title and how
 * long it has been up, then restart and stop as bare icons (a soft plate on hover; stop's turns
 * red). No panel, beam or pulse: the row reads like the navigation above it. Restart spins while
 * in flight and shows a check for a moment when it settles. The status word stays available to
 * assistive tech and as the row's tooltip.
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
  const done = useSettledFlash(restarting);
  const live = !stopping;
  const status = stopping ? stoppingLabel : statusLabel;

  return (
    <div className={cn("ui-v2 flex h-[var(--ocx-control-h)] items-center gap-2 pr-1 pl-2.5", className)} title={detail ? `${status} · ${detail}` : status}>
      <span className={cn("size-2 shrink-0 rounded-full", live ? "bg-success" : "bg-fg-subtle")} aria-hidden />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px] leading-5">
        <span className="shrink-0 font-medium text-fg">{label}</span>
        <span className="sr-only">{status}</span>
        <span className="min-w-0 truncate text-xs text-fg-subtle tabular-nums" aria-hidden={!stopping && !!detail ? undefined : true}>
          {stopping ? stoppingLabel : detail ?? statusLabel}
        </span>
      </span>
      {session && (
        <TrayButton onClick={session.onClick} disabled={session.busy}
          label={session.busy ? session.busyLabel : session.label} title={session.label}>
          <IconX />
        </TrayButton>
      )}
      <TrayButton onClick={onRestart} disabled={restarting}
        label={restarting ? restartingLabel : restartLabel} title={restartLabel}>
        {done ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}
            strokeLinecap="round" strokeLinejoin="round" className="text-success" aria-hidden>
            <path d="M5 12l5 5L20 7" />
          </svg>
        ) : (
          <span className={cn("inline-flex", restarting && "animate-spin")}>
            <IconRefresh />
          </span>
        )}
      </TrayButton>
      <TrayButton onClick={onStop} disabled={stopping} danger
        label={stopping ? stoppingLabel : stopLabel} title={stopping ? stoppingLabel : stopLabel}>
        <IconPower />
      </TrayButton>
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
        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] bg-transparent text-fg-subtle",
        "transition-[background-color,color] duration-150 ease-soft",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
        danger ? "hover:bg-danger-soft hover:text-danger" : "hover:bg-accent-soft hover:text-fg",
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
