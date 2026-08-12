/**
 * Shared loading indicators (WP2 / 010_loading_contract.md).
 *
 * One live region per loading transition. A skeleton owns the announcement while a surface is
 * cold; a status line owns it during revalidation, and steps down to visual-only when an error
 * notice is already announcing. Rendering two live regions for one transition makes screen
 * readers repeat themselves, which is what the per-page ad-hoc loaders used to do.
 */

import type { CSSProperties, ReactNode } from "react";

/**
 * Lets a page mirror its ready geometry without exposing placeholder values to assistive
 * technology. The surrounding skeleton owns the single announced sentence.
 */
function DataSurfaceSkeletonBlock({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={className ? `data-surface-skeleton__block ${className}` : "data-surface-skeleton__block"}
      style={style}
    />
  );
}

/**
 * Keeps a cold surface non-empty from its first commit. This is the only live region for a cold
 * transition, so callers must not render a live status line beside it.
 */
export function DataSurfaceSkeleton({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  const count = Math.max(1, Math.floor(rows));
  return (
    <div
      className={className ? `data-surface-skeleton ${className}` : "data-surface-skeleton"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <div className="data-surface-skeleton__row" key={index} aria-hidden="true">
          <DataSurfaceSkeletonBlock />
        </div>
      ))}
    </div>
  );
}

/**
 * Announces a revalidation without replacing visible stale content. Pass `live={false}` where an
 * error notice already owns the announcement for this transition.
 */
export function DataSurfaceStatus({
  children,
  busy = true,
  live = true,
  className,
}: {
  children: ReactNode;
  busy?: boolean;
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      className={className ? `data-surface-status ${className}` : "data-surface-status"}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      aria-atomic={live ? "true" : undefined}
      aria-busy={busy || undefined}
    >
      {busy && <span className="spin" aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}
