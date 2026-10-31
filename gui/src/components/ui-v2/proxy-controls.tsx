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
 * Design system v2 proxy status capsule. While the proxy runs the card carries a faint green
 * wash and a glowing dot, so "is it on?" reads from the corner of the eye; the title and the
 * uptime sit beside it. The actions live in one joined icon tray on the right instead of loose
 * buttons: restart spins while in flight and flashes a check when it settles, and stop stays
 * quiet until hovered, when it turns red, so the destructive action never shouts at rest.
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
    <div
      className={cn(
        "ui-v2 relative flex items-center gap-2.5 overflow-hidden rounded-[14px] py-2 pr-1.5 pl-3 ring-1 ring-inset transition-colors duration-300",
        live
          ? "bg-[linear-gradient(120deg,color-mix(in_oklab,var(--ocx-success)_12%,transparent),transparent_70%)] ring-success/25"
          : "bg-surface ring-line",
        className,
      )}
    >
      <span className="relative inline-flex size-2.5 shrink-0" aria-hidden>
        {live && !reduce && <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-50" />}
        <span className={cn(
          "relative size-2.5 rounded-full",
          live ? "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--ocx-success)_22%,transparent)]" : "bg-fg-subtle",
        )} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-[18px] font-semibold tracking-[-0.01em] text-fg">{label}</span>
        <span className={cn("truncate text-[11.5px] leading-4 tabular-nums", live ? "text-success" : "text-fg-subtle")}>
          {stopping ? stoppingLabel : statusLabel}
          {!stopping && detail && <span className="text-fg-subtle"> · {detail}</span>}
        </span>
      </span>

      <span className="flex shrink-0 items-center rounded-[10px] bg-bg/70 p-0.5 ring-1 ring-inset ring-line">
        {session && (
          <>
            <TrayButton onClick={session.onClick} disabled={session.busy}
              label={session.busy ? session.busyLabel : session.label} title={session.label}>
              <IconX />
            </TrayButton>
            <Divider />
          </>
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
        <Divider />
        <TrayButton onClick={onStop} disabled={stopping} danger
          label={stopping ? stoppingLabel : stopLabel} title={stopping ? stoppingLabel : stopLabel}>
          <IconPower />
        </TrayButton>
      </span>
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
        "inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-fg-muted",
        "transition-[background-color,color,scale] duration-200 ease-soft active:scale-90",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
        danger ? "hover:bg-danger-soft hover:text-danger" : "hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-px h-3.5 w-px bg-line" aria-hidden />;
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
