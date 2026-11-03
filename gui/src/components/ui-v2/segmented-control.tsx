import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SegmentThumb, SegmentThumbGroup } from "./segment-thumb";

export interface SegmentedItem<V extends string> {
  value: V;
  label: ReactNode;
  /** Accessible name and tooltip; required when `label` is only an icon. */
  title?: string;
}

interface SegmentedControlProps<V extends string> {
  items: ReadonlyArray<SegmentedItem<V>>;
  value: V;
  onChange: (value: V) => void;
  "aria-label": string;
  size?: "sm" | "md";
  className?: string;
}

/*
 * Design system v2 segmented control: a recessed track whose selected thumb
 * slides between options on a spring (shared layout animation), instead of
 * each option repainting its own background. Radio semantics with roving
 * focus: arrows / Home / End move the selection like a native radio group.
 */
export function SegmentedControl<V extends string>({
  items,
  value,
  onChange,
  "aria-label": ariaLabel,
  size = "md",
  className,
}: SegmentedControlProps<V>) {
  // Shared-layout id for the sliding thumb, unique per control instance.
  const thumbId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = Math.max(0, items.findIndex(item => item.value === value));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (active + step + items.length) % items.length;
    onChange(items[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "ui-v2 relative inline-flex items-center gap-0.5 rounded-control bg-surface p-0.5 ring-1 ring-inset ring-line",
        className,
      )}
    >
      <SegmentThumbGroup>
        {items.map((item, i) => {
          const selected = i === active;
          return (
            <button
              key={item.value}
              ref={el => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={item.title}
              title={item.title}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.value)}
              className={cn(
                "relative inline-flex cursor-pointer items-center justify-center rounded-[calc(var(--radius-control)-2px)] font-medium",
                "transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
                "[&_svg]:size-3.5",
                // Track padding is 2px a side, so the track is exactly one control height.
                size === "sm" ? "h-[calc(var(--ocx-control-h-sm)-4px)] min-w-7 px-2 text-xs" : "h-[calc(var(--ocx-control-h)-4px)] min-w-8 px-3 text-[13px]",
                selected ? "text-fg" : "text-fg-subtle hover:text-fg-muted",
              )}
            >
              {selected && <SegmentThumb layoutId={thumbId} />}
              <span className="relative inline-flex items-center gap-1.5">{item.label}</span>
            </button>
          );
        })}
      </SegmentThumbGroup>
    </div>
  );
}
