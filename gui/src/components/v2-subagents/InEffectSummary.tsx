/*
 * "In effect now": the three answers people open this page for, before any control — what
 * Codex offers first, which model it calls first, and whether Claude Code is pinned. Each
 * tile jumps to the place that changes it. It summarises; it never lists the order twice.
 */
import type { ReactNode } from "react";
import { IconChevron } from "../../icons";
import { useT } from "../../i18n/shared";
import { modelLabel } from "../../model-display";
import { cn } from "@/lib/utils";

interface Props {
  chosen: string[];
  max: number;
  /** Label of the delegation model, or "" when none is set. */
  firstModel: string;
  firstEffort: string;
  /** Committed Claude Code pin: null = off, undefined = still loading. */
  pin: string | null | undefined;
  onJump: (target: "featured" | "delegation" | "pin") => void;
}

export function InEffectSummary({ chosen, max, firstModel, firstEffort, pin, onJump }: Props) {
  const t = useT();
  const top = chosen[0];
  return (
    <section aria-label={t("subagentsV2.nowTitle")} className="flex flex-col gap-2">
      <h3 className="m-0 text-[12px] font-medium text-fg-subtle">{t("subagentsV2.nowTitle")}</h3>
      <div className="grid gap-3 md:grid-cols-3">
        <Tile
          label={t("subagentsV2.nowOrder")}
          value={top ? modelLabel(top) : t("subagentsV2.nowOrderNone")}
          mono={!!top}
          muted={!top}
          caption={t("subagentsV2.nowOrderCaption", { n: chosen.length, max })}
          onClick={() => onJump("featured")}
        />
        <Tile
          label={t("sub.delegation.model")}
          value={firstModel || t("dash.injectionNone")}
          mono={!!firstModel}
          muted={!firstModel}
          caption={!firstModel ? t("subagentsV2.firstNoneCaption")
            : `${t("dash.injectionEffortLabel")} · ${firstEffort || t("dash.injectionEffortNone")}`}
          onClick={() => onJump("delegation")}
        />
        <Tile
          label={t("subagentsV2.nowPin")}
          value={pin === undefined ? "—" : pin ?? t("subagentsV2.off")}
          mono={!!pin}
          muted={!pin}
          on={!!pin}
          caption={pin ? t("subagentsV2.pinOnCaption") : t("subagentsV2.pinOffCaption")}
          onClick={() => onJump("pin")}
        />
      </div>
    </section>
  );
}

function Tile({ label, value, caption, mono, muted, on, onClick }: {
  label: string;
  value: ReactNode;
  caption: string;
  mono?: boolean;
  muted?: boolean;
  on?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "ui-v2 group flex min-w-0 cursor-pointer flex-col gap-1 rounded-[12px] bg-surface px-4 py-3.5 text-left ring-1 ring-inset ring-line",
        "transition-colors duration-200 hover:bg-raised hover:ring-line-strong",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
      )}
    >
      <span className="flex items-center gap-2 text-[12px] font-medium text-fg-subtle">
        {on !== undefined && (
          <span className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-fg-subtle")} aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="inline-flex items-center gap-0.5 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {t("subagentsV2.change")}
          <IconChevron className="size-3" aria-hidden="true" />
        </span>
      </span>
      <span className={cn(
        "truncate text-[16px] leading-6 font-semibold tracking-[-0.01em]",
        mono && "font-mono text-[15px]",
        muted ? "text-fg-muted" : "text-fg",
      )}>{value}</span>
      <span className="truncate text-[12px] text-fg-muted">{caption}</span>
    </button>
  );
}
