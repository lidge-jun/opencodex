import { cn } from "@/lib/utils";
import type { RequestOutcomeClass } from "../../../../src/usage/request-outcome";

const TONE: Record<RequestOutcomeClass, string> = {
  completed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  incomplete: "bg-warning-soft text-warning",
  aborted: "bg-surface-2 text-fg-muted",
};

/*
 * A request's HTTP status as a soft pill (React Bits support-5). The tone follows the shared
 * outcome class, not the number alone, so an incomplete 200 never reads as a clean success; the
 * number and the outcome in the title carry the meaning, never the colour by itself.
 */
export function StatusPill({ status, outcome, label, announce = true, className }: {
  status: number;
  outcome: RequestOutcomeClass;
  /** The outcome in words, announced and shown on hover. */
  label: string;
  /** False where the outcome is already written out beside the pill (the detail dialog). */
  announce?: boolean;
  className?: string;
}) {
  return (
    <span
      title={label}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 font-mono text-[12px] font-semibold tabular-nums",
        TONE[outcome],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {status}
      {announce && <span className="sr-only">{label}</span>}
    </span>
  );
}
