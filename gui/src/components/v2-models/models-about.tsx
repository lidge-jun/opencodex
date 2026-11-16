import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n/shared";
import { cn } from "@/lib/utils";

/*
 * The "?" beside the Models page title. The page lead is one plain line; the full
 * description (and, on the catalog, how a saved change reaches Codex) opens here as a
 * non-modal disclosure: Escape or a click elsewhere closes it and focus returns to the
 * trigger, so nothing in it is ever more than one click away.
 */
export function ModelsAbout({ text, children }: { text: string; children?: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const doc = wrap.current?.ownerDocument;
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    doc?.addEventListener("pointerdown", onPointer);
    doc?.addEventListener("keydown", onKey);
    return () => {
      doc?.removeEventListener("pointerdown", onPointer);
      doc?.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="ui-v2 relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t("modelsV2.about")}
        title={t("modelsV2.about")}
        onClick={() => setOpen(value => !value)}
        className={cn(
          "grid size-8 cursor-pointer place-items-center rounded-[10px] text-fg-muted transition-colors duration-200",
          "hover:bg-surface hover:text-fg aria-expanded:bg-surface aria-expanded:text-fg",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight",
        )}
      >
        <span aria-hidden="true" className="grid size-[18px] place-items-center rounded-full text-[11px] leading-none font-semibold ring-[1.5px] ring-current">?</span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-label={t("modelsV2.about")}
        hidden={!open}
        className={cn(
          "models-about absolute top-10 right-0 z-30 w-[min(460px,calc(100vw-48px))] flex-col gap-3 rounded-[12px] bg-raised p-4 text-[13px] leading-5 text-fg-muted shadow-lg ring-1 ring-line",
          open ? "flex" : "hidden",
        )}
      >
        <p className="m-0">{text}</p>
        {children}
      </div>
    </div>
  );
}
