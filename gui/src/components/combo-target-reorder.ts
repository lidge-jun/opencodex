import { useLayoutEffect, useRef, type PointerEvent } from "react";
import type { ComboTarget } from "../combo-workspace-data";

type TargetDrag = {
  pointerId: number;
  from: number;
  to: number;
  startY: number;
  top: number;
  centers: number[];
  source: HTMLElement;
  marker?: HTMLElement;
  active: boolean;
};

export function useComboTargetReorder(targets: ComboTarget[], onChange: (next: ComboTarget[]) => void) {
  const listRef = useRef<HTMLOListElement>(null);
  const moveFocus = useRef<{ index: number; direction: "up" | "down" } | null>(null);
  const drag = useRef<TargetDrag | null>(null);

  function cancelDrag() {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.source.style.removeProperty("--cwi-pointer-y");
    delete current.source.dataset.dragging;
    if (current.marker) delete current.marker.dataset.dropSide;
  }

  useLayoutEffect(() => {
    const pending = moveFocus.current;
    moveFocus.current = null;
    const moved = pending && listRef.current?.children.item(pending.index);
    if (!moved) return;
    const buttons = Array.from(moved.querySelectorAll<HTMLButtonElement>("[data-cwi-move]:not(:disabled)"));
    (buttons.find(button => button.dataset.cwiMove === pending.direction) ?? buttons[0])?.focus();
  }, [targets]);

  useLayoutEffect(() => cancelDrag, [targets]);

  function reorder(from: number, to: number, direction?: "up" | "down"): void {
    if (from === to || from < 0 || to < 0 || from >= targets.length || to >= targets.length) return;
    const copy = [...targets];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved!);
    if (direction) moveFocus.current = { index: to, direction };
    onChange(copy);
  }

  function grip(from: number) {
    return {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        const list = listRef.current;
        const source = list?.children.item(from) as HTMLElement | null;
        if (!event.isPrimary || event.button !== 0 || !source || !list) return;
        cancelDrag();
        event.currentTarget.setPointerCapture(event.pointerId);
        const centers = Array.from(list.children, row => {
          const rect = row.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });
        drag.current = {
          pointerId: event.pointerId, from, to: from, startY: event.clientY,
          top: list.getBoundingClientRect().top, centers, source, active: false,
        };
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const list = listRef.current;
        const current = drag.current;
        if (!list || !current || current.pointerId !== event.pointerId) return;
        const offset = event.clientY - current.startY + current.top - list.getBoundingClientRect().top;
        if (!current.active && Math.abs(offset) < 8) return;
        current.active = true;
        current.source.dataset.dragging = "true";

        const { centers } = current;
        const center = centers[current.from]! + offset;
        const bounded = Math.min(centers[centers.length - 1]!, Math.max(centers[0]!, center));
        const resistance = (center - bounded) / (1 + Math.abs(center - bounded) / 40);
        current.source.style.setProperty("--cwi-pointer-y", String(bounded - centers[current.from]! + resistance));
        let to = current.from;
        while (to < centers.length - 1 && center > centers[to + 1]!) to++;
        while (to > 0 && center < centers[to - 1]!) to--;
        if (to === current.to) return;
        if (current.marker) delete current.marker.dataset.dropSide;
        current.to = to;
        current.marker = to === current.from ? undefined : list.children.item(to) as HTMLElement;
        if (current.marker) current.marker.dataset.dropSide = to < current.from ? "before" : "after";
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        cancelDrag();
        if (current.active) reorder(current.from, current.to);
      },
      onPointerCancel: cancelDrag,
      onLostPointerCapture: cancelDrag,
    };
  }

  return { listRef, reorder, grip };
}
