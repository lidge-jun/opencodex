import type { ReactNode } from "react";
import { LazyMotion, m, useReducedMotion } from "motion/react";

/*
 * The selected plate of a segmented track. It slides from the old option to the new one on a
 * spring (a shared layout animation keyed by `layoutId`), so the selection reads as one thing
 * moving rather than two backgrounds repainting. The layout-animation features load on first
 * use instead of shipping with every page; until they arrive the plate simply jumps.
 */

const loadLayoutFeatures = () => import("./segment-thumb-features").then(mod => mod.default);
const SPRING = { type: "spring", stiffness: 420, damping: 36 } as const;
const INSTANT = { duration: 0 } as const;

/** Wraps a segmented track so its thumbs can animate between options. */
export function SegmentThumbGroup({ children }: { children: ReactNode }) {
  return <LazyMotion features={loadLayoutFeatures}>{children}</LazyMotion>;
}

/** Render inside the selected option only; every option of one track shares `layoutId`. */
export function SegmentThumb({ layoutId }: { layoutId: string }) {
  const reduce = useReducedMotion();
  return (
    <m.span
      layoutId={layoutId}
      aria-hidden
      transition={reduce ? INSTANT : SPRING}
      className="absolute inset-0 rounded-[inherit] bg-raised shadow-sm ring-1 ring-line dark:bg-surface-2"
    />
  );
}
