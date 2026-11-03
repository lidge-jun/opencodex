import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconX } from "../../icons";
import { ProxyLever } from "./proxy-lever";
import { cn } from "@/lib/utils";

interface ProxyControlsProps {
  /** Card title, e.g. "Proxy". */
  label: string;
  /** Status next to the live dot, e.g. "Online". */
  statusLabel: string;
  /** Optional second half of the status line, e.g. how long the proxy has been up. */
  detail?: string | undefined;
  /** False when the proxy is not answering (health check failed): the status dot goes neutral. Default true. */
  online?: boolean | undefined;
  stopLabel: string;
  stoppingLabel: string;
  restartLabel: string;
  restartingLabel: string;
  /** How far to pull the lever for each action; the lever's tooltip and accessible description. */
  leverHint: string;
  stopping: boolean;
  restarting: boolean;
  /** May return the stop's promise so the lever can rise again if the confirmation is declined. */
  onStop: () => void | Promise<unknown>;
  onRestart: () => void;
  /** Optional third action (end the dashboard session on a connected client). */
  session?: { label: string; busyLabel: string; busy: boolean; onClick: () => void } | undefined;
  className?: string;
}

/*
 * Design system v2 proxy status, as one sidebar row: a static status dot, the title and how
 * long it has been up, then one slot lever (proxy-lever.tsx) that reloads Codex models at its
 * middle notch and stops the proxy at the bottom. No panel, beam or pulse: the row reads like the
 * navigation above it. While either action runs the status line says so, and the lever's handle
 * flashes green for a moment when a reload settles. The status word stays available to assistive
 * tech and as the row's tooltip.
 */
export function ProxyControls({
  label,
  statusLabel,
  detail,
  online = true,
  stopLabel,
  stoppingLabel,
  restartLabel,
  restartingLabel,
  leverHint,
  stopping,
  restarting,
  onStop,
  onRestart,
  session,
  className,
}: ProxyControlsProps) {
  const done = useSettledFlash(restarting);
  const live = online && !stopping;
  const status = stopping ? stoppingLabel : restarting ? restartingLabel : statusLabel;
  const busy = stopping || restarting;

  return (
    <div className={cn("ui-v2 flex h-[var(--ocx-control-h)] items-center gap-2 pr-1 pl-2.5", className)} title={detail ? `${status} · ${detail}` : status}>
      <span className={cn("size-2 shrink-0 rounded-full", live ? "bg-success" : "bg-fg-subtle")} aria-hidden />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px] leading-5">
        <span className="shrink-0 font-medium text-fg">{label}</span>
        <span className="sr-only">{status}</span>
        <span className="min-w-0 truncate text-xs text-fg-subtle tabular-nums" aria-hidden={!busy && !!detail ? undefined : true}>
          {busy ? status : detail ?? statusLabel}
        </span>
      </span>
      {session && (
        <TrayButton onClick={session.onClick} disabled={session.busy}
          label={session.busy ? session.busyLabel : session.label} title={session.label}>
          <IconX />
        </TrayButton>
      )}
      <ProxyLever restartLabel={restarting ? restartingLabel : restartLabel} stopLabel={stopping ? stoppingLabel : stopLabel}
        hint={leverHint} restarting={restarting} settled={done} stopping={stopping} onRestart={onRestart} onStop={onStop} />
    </div>
  );
}

function TrayButton({ onClick, disabled, label, title, children }: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
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
        "hover:bg-accent-soft hover:text-fg",
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
