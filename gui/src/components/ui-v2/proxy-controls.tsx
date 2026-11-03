import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconX } from "../../icons";
import { ProxyLever, type LeverPreview } from "./proxy-lever";
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
  /** What the status line says while the lever is hovered or pulled: the release outcome per zone. */
  leverText: { hover: string; cancel: string; restart: string; stop: string };
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
 * Design system v2 proxy status, as one sidebar row: a status dot, the title and how long it has
 * been up, then one slot lever (proxy-lever.tsx) that reloads Codex models at its middle notch and
 * stops the proxy at the bottom. While the lever is hovered or pulled, the status line says what
 * letting go will do (red for the stop). Each action has its own feel once it starts: a stop
 * brakes like a train (the row lurches and rocks back, the dot turns into a red brake light, the
 * status word slides in and pulls up, and the rails under the row slow to a standstill); a reload
 * runs a band of sky light across the row, shines its status word and charges the lever's slot,
 * and the handle flashes green when it settles. The status word stays available to assistive tech
 * and as the row's tooltip.
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
  leverText,
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
  const [preview, setPreview] = useState<LeverPreview>(null);
  const previewText = busy || preview === null ? null
    : preview === "hover" ? leverText.hover
    : preview === "rest" ? leverText.cancel
    : leverText[preview];
  // "rest", "restart" and "stop" only come from a drag in progress.
  const held = !busy && (preview === "rest" || preview === "restart" || preview === "stop");

  return (
    <div className={cn("ui-v2 relative flex h-8 items-center gap-[9px] overflow-hidden px-2.5", className)} title={detail ? `${status} · ${detail}` : status}>
      {/* While the lever is held the row already moves: rails run under it as soon as it is pulled,
          a held reload keeps a band of sky light sweeping across, and a held stop slows the rails to a
          red crawl and makes the row shudder like a braking train. Once an action starts, its own
          motion plays once: a reload sweeps the row, a stop lurches it and brings the rails to a halt. */}
      {held && <span className={cn("ocx-rails-run", preview === "stop" && "is-braking")} aria-hidden />}
      {(preview === "restart" || (restarting && !stopping)) && (
        <span className={cn("ocx-sweep", preview === "restart" && "ocx-sweep-loop")} aria-hidden />
      )}
      {stopping && <span className="ocx-rails" aria-hidden />}
      <span className={cn("relative flex min-w-0 flex-1 items-center gap-[9px]", stopping ? "ocx-halt" : preview === "stop" && "ocx-tremble")}>
      {/* The dot sits in the same 16px slot as the globe and GitHub marks below, so every label starts
          on one line. While the proxy stops it is a brake light. */}
      <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
        <span className={cn("size-2 rounded-full transition-colors duration-300",
          stopping || preview === "stop" ? "bg-danger" : preview === "restart" ? "bg-highlight" : live ? "bg-success" : "bg-fg-subtle")} />
      </span>
      {previewText !== null ? (
        <span aria-hidden className={cn(
          "min-w-0 flex-1 truncate text-[13px] leading-5",
          preview === "stop" ? "font-medium text-danger" : preview === "restart" ? "ocx-shine font-medium" : "text-fg-muted",
        )}>{previewText}</span>
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px] leading-5">
          <span className="shrink-0 font-medium text-fg">{label}</span>
          <span className="sr-only">{status}</span>
          {/* A reload in flight shines sky so it is noticed; everything else stays quiet. */}
          <span className={cn("min-w-0 truncate text-xs tabular-nums",
            stopping ? "font-medium text-danger" : restarting ? "ocx-shine font-medium" : "text-fg-subtle")}
            aria-hidden={!busy && !!detail ? undefined : true}>
            {/* The stopping word pulls into its own clipped box, so it never slides over the title. */}
            {stopping ? <span className="ocx-brake">{status}</span> : busy ? status : detail ?? statusLabel}
          </span>
        </span>
      )}
      </span>
      {session && (
        <TrayButton onClick={session.onClick} disabled={session.busy}
          label={session.busy ? session.busyLabel : session.label} title={session.label}>
          <IconX />
        </TrayButton>
      )}
      <ProxyLever restartLabel={restarting ? restartingLabel : restartLabel} stopLabel={stopping ? stoppingLabel : stopLabel}
        hint={leverHint} restarting={restarting} settled={done} stopping={stopping} onRestart={onRestart} onStop={onStop} onPreview={setPreview} />
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
