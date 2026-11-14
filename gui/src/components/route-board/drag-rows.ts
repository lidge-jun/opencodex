/*
 * Pointer row sorter, adapted from Magpie's `dragRows`, `dragScroll`, `dragListen` and `tapLike`
 * (internal/gui/assets/app.js in https://github.com/yetone/magpie).
 *
 * MIT License
 *
 * Copyright (c) 2026 yetone
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Changes from the original: TypeScript; the target slot goes through `dragSlot` (the row
 * midpoints from layout, plus a few pixels of hysteresis at each boundary) instead of the plain
 * midpoint walk, so a pointer resting on a boundary cannot make the rows flip back and forth.
 */
import { dragSlot } from "../../route-board-model";

/** The box a drag scrolls, and how fast a pointer at y scrolls it. */
function dragScroll(list: HTMLElement) {
  let scroll: HTMLElement | null = list.parentElement;
  while (scroll && !/(auto|scroll)/.test(window.getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
  const box = scroll ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  const bounds = box.getBoundingClientRect();
  const edge = 36;
  return {
    scroll: box,
    speedAt: (y: number) => y < bounds.top + edge ? -Math.min(1, (bounds.top + edge - y) / edge)
      : y > bounds.bottom - edge ? Math.min(1, (y - bounds.bottom + edge) / edge) : 0,
  };
}

/** A drag's listeners: letting go saves; Escape, blur, resize and a lost capture cancel. */
function dragListen(handle: HTMLElement, move: (ev: PointerEvent) => void, finish: (save: boolean, ev?: PointerEvent) => void) {
  const cancel = (ev: Event) => finish(false, ev as PointerEvent);
  const on: Array<[EventTarget, string, EventListener, AddEventListenerOptions | boolean | undefined]> = [
    [document, "pointermove", move as EventListener, { passive: false }],
    [document, "pointerup", ((ev: PointerEvent) => finish(true, ev)) as EventListener, undefined],
    [document, "pointercancel", cancel, undefined],
    [handle, "lostpointercapture", cancel, undefined],
    [window, "blur", cancel, undefined],
    [window, "resize", cancel, undefined],
    [document, "keydown", ((ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); finish(false); }
    }) as EventListener, true],
  ];
  for (const [target, name, listener, options] of on) target.addEventListener(name, listener, options);
  return () => { for (const [target, name, listener, options] of on) target.removeEventListener(name, listener, options); };
}

/**
 * A tap on a trackpad can slide a few pixels between press and lift: let go within 300ms and
 * under 12px from where it came down is a click, not a drag.
 */
const tapLike = (t0: number, x0: number, y0: number, ev?: PointerEvent) =>
  ev?.type === "pointerup" && performance.now() - t0 < 300 && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 12;

const frameRequest = (callback: FrameRequestCallback) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(() => callback(performance.now()), 16) as unknown as number;
const frameCancel = (id: number) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); else clearTimeout(id);
};

/**
 * The row itself follows the pointer (a transform, no copy and no placeholder); the rows it
 * passes slide a row's height out of the way; one `commit(to)` on release. Returns false when the
 * press does not start a drag.
 */
export function dragRows(
  e: PointerEvent,
  handle: HTMLElement,
  row: HTMLElement,
  list: HTMLElement,
  rows: HTMLElement[],
  commit: (to: number) => void,
): boolean {
  if (e.button !== 0 || e.isPrimary === false || rows.length < 2) return false;
  const from = rows.indexOf(row);
  if (from < 0) return false;
  const base = () => list.getBoundingClientRect().top - list.scrollTop - rows[0]!.offsetTop;
  const lift = rows[0]!.getBoundingClientRect().top - base() - rows[0]!.offsetTop;
  const grab = e.clientY - row.getBoundingClientRect().top;
  const { scroll, speedAt } = dragScroll(list);
  let dragging = false;
  let ended = false;
  let to = from;
  let y = e.clientY;
  let frame = 0;
  let lastTime = 0;
  const y0 = y;
  const x0 = e.clientX;
  const t0 = performance.now();
  const pointer = e.pointerId;

  const paint = (time: number) => {
    frame = 0;
    if (!rows.every((r) => r.isConnected)) { finish(false); return; }
    if (!dragging) return;
    const dt = Math.min(32, lastTime ? time - lastTime : 16);
    lastTime = time;
    const speed = speedAt(y);
    if (speed) scroll.scrollTop += speed * dt * 0.6;
    const b = base() + lift;
    const tops = rows.map((r) => b + r.offsetTop);
    const heights = rows.map((r) => r.offsetHeight);
    const h = heights[from]!;
    const lo = tops[0]! - tops[from]!;
    const hi = tops.at(-1)! + heights.at(-1)! - h - tops[from]!;
    const d = Math.max(lo, Math.min(hi, y - grab - tops[from]!));
    Object.assign(row.style, { transform: `translateY(${d}px)` });
    to = dragSlot(tops.map((top, i) => top + heights[i]! / 2), from, tops[from]! + d + h / 2, to);
    // Held at the top or the foot, it goes there even if the end row's middle is out of reach.
    if (d <= lo && from > 0) to = 0;
    else if (d >= hi && from < rows.length - 1) to = rows.length - 1;
    rows.forEach((r, i) => {
      if (i === from) return;
      const shift = i > from && i <= to ? -h : i < from && i >= to ? h : 0;
      Object.assign(r.style, { transform: shift ? `translateY(${shift}px)` : "" });
    });
    frame = frameRequest(paint);
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointer) return;
    if (!row.isConnected || !handle.isConnected) { finish(false, ev); return; }
    y = ev.clientY;
    if (!dragging) {
      if (Math.abs(y - y0) < 4) return;
      dragging = true;
      list.classList.add("sorting");
      row.classList.add("dragging");
      window.getSelection()?.removeAllRanges();
      handle.setPointerCapture?.(pointer);
    }
    ev.preventDefault();
    if (!frame) frame = frameRequest(paint);
  };
  const finish = (save: boolean, ev?: PointerEvent) => {
    if (ended || (ev?.pointerId != null && ev.pointerId !== pointer)) return;
    if (save && dragging && tapLike(t0, x0, y0, ev)) save = false;
    if (save && dragging && ev) {
      y = ev.clientY;
      frameCancel(frame);
      paint(performance.now());
    }
    if (ended) return;
    ended = true;
    frameCancel(frame);
    off();
    if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
    list.classList.remove("sorting");
    row.classList.remove("dragging");
    rows.forEach((r) => { r.style.transform = ""; });
    if (save && dragging && to !== from) commit(to);
  };
  const off = dragListen(handle, move, finish);
  return true;
}
