/**
 * Bound a fetch with AbortSignal.timeout when available; otherwise a manual
 * timer that must be cleared after settlement / unmount.
 */

export type BoundedFetch = {
  controller: AbortController;
  signal: AbortSignal;
  clear: () => void;
};

export function createBoundedFetch(ms: number): BoundedFetch {
  const controller = new AbortController();
  if (
    typeof AbortSignal !== "undefined"
    && typeof AbortSignal.any === "function"
    && typeof AbortSignal.timeout === "function"
  ) {
    return {
      controller,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]),
      clear: () => undefined,
    };
  }
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}
