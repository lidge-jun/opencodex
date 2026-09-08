import type { ReactNode } from "react";
import type { DataSurfaceState } from "../../data-surface";
import {
  DataSurfaceSkeleton,
  DataSurfaceStatus,
} from "../../components/data-surface";
import { EmptyState, Notice } from "../../ui";

function surfaceErrorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SurfaceFrame<T>({
  state,
  loading,
  failed,
  empty,
  emptyTitle,
  onRetry,
  retryLabel,
  children,
}: {
  state: DataSurfaceState<T>;
  loading: string;
  failed: string;
  empty?: boolean;
  emptyTitle?: string;
  onRetry?: () => void;
  retryLabel?: string;
  children: ReactNode;
}) {
  if (state.showSkeleton) return <DataSurfaceSkeleton label={loading} rows={5} />;
  if (state.kind === "failed-cold") {
    return (
      <EmptyState title={failed}>
        <p>{surfaceErrorText(state.error, failed)}</p>
        {onRetry && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            {retryLabel}
          </button>
        )}
      </EmptyState>
    );
  }
  return (
    <>
      {state.refreshing && <DataSurfaceStatus live={!state.showError}>{loading}</DataSurfaceStatus>}
      {state.showError && <Notice tone="err">{surfaceErrorText(state.error, failed)}</Notice>}
      {empty ? <EmptyState title={emptyTitle ?? failed} /> : children}
    </>
  );
}
