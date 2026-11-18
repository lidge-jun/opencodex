import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LayoutThreeColumnIcon } from "@hugeicons/core-free-icons";
import { IconCheck, IconChevron } from "../../icons";
import { cn } from "@/lib/utils";
import { quietButton } from "./classes";

export interface ColumnOption<K extends string> {
  key: K;
  label: string;
}

/*
 * Column toggles (React Bits data-table-1): a quiet trigger and a small menu of
 * menuitemcheckbox rows. Arrows / Home / End move between rows, Escape or a click outside
 * closes it and returns focus to the trigger.
 */
export function ColumnsMenu<K extends string>({ options, visible, onToggle, label, menuLabel }: {
  options: ReadonlyArray<ColumnOption<K>>;
  visible: Readonly<Record<K, boolean>>;
  onToggle: (key: K) => void;
  label: string;
  menuLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const doc = triggerRef.current?.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    doc?.addEventListener("pointerdown", onPointerDown);
    doc?.addEventListener("keydown", onKey);
    itemRefs.current[0]?.focus({ preventScroll: true });
    return () => {
      doc?.removeEventListener("pointerdown", onPointerDown);
      doc?.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const focusItem = (index: number) => {
    const count = options.length;
    itemRefs.current[(index + count) % count]?.focus({ preventScroll: true });
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex(item => item === event.currentTarget.ownerDocument.activeElement);
    if (event.key === "Tab") setOpen(false);
    else if (event.key === "ArrowDown") { event.preventDefault(); focusItem(current + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusItem(current < 0 ? options.length - 1 : current - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusItem(0); }
    else if (event.key === "End") { event.preventDefault(); focusItem(options.length - 1); }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={menuLabel}
        onClick={() => setOpen(value => !value)}
        className={quietButton}
      >
        <HugeiconsIcon icon={LayoutThreeColumnIcon} size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className="max-sm:sr-only">{label}</span>
        <IconChevron aria-hidden className={cn("size-3.5 text-fg-subtle transition-transform", open ? "-rotate-90" : "rotate-90")} />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-52 flex-col gap-0.5 rounded-[10px] bg-raised p-1 shadow-md ring-1 ring-line dark:bg-surface-2"
        >
          {options.map((option, index) => (
            <button
              key={option.key}
              ref={node => { itemRefs.current[index] = node; }}
              type="button"
              role="menuitemcheckbox"
              aria-checked={visible[option.key]}
              tabIndex={-1}
              onClick={() => onToggle(option.key)}
              className="ui-v2 flex h-[var(--ocx-control-h)] w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-fg hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
            >
              <span aria-hidden className="grid size-4 shrink-0 place-items-center text-fg">
                {visible[option.key] && <IconCheck className="size-3.5" />}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
