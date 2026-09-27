/**
 * Publishes the bar's rendered height as `--ocx-sticky-top-h` so page-level sticky elements
 * (the Models provider rail) can sit just below it. The bar wraps onto a second row on
 * narrower windows, so a constant offset would let content slide underneath it.
 * The value is a unitless pixel count; consumers apply the unit with `* 1px` in calc().
 * A React 19 callback ref: the returned cleanup runs when the bar unmounts.
 */
export function publishStickyTop(node: HTMLElement): () => void {
  const root = document.documentElement;
  const write = () => root.style.setProperty("--ocx-sticky-top-h", String(Math.ceil(node.getBoundingClientRect().height)));
  write();
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(write);
  observer?.observe(node);
  return () => {
    observer?.disconnect();
    root.style.removeProperty("--ocx-sticky-top-h");
  };
}
