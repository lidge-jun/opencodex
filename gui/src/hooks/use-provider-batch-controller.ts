import { useCallback, useEffect, useRef, useState } from "react";

export interface ProviderBatchController {
  /** Whether a batch is currently in progress. */
  batchTesting: boolean;
  /** Start a new batch. Ownership transfers to the returned controller. */
  startBatch: () => AbortController;
  /** Cancel an in-flight batch: abort signal + set batchTesting false. */
  cancelMountedBatch: () => void;
  /** Clean up batch resources on unmount without touching state. */
  abortBatchOnUnmount: () => void;
  /** Check whether a controller is still the active batch. */
  isActiveBatch: (controller: AbortController) => boolean;
}

/**
 * Manages a single in-flight provider connection-test batch.
 *
 * Production callers:
 * - testAllProviders() calls startBatch() to acquire the controller,
 *   then iterates providers and passes signal to each probe.
 * - apiBase change effect calls cancelMountedBatch().
 * - config-generation change effect calls cancelMountedBatch().
 * - unmount effect calls abortBatchOnUnmount().
 *
 * Internal state (refs) keeps cancellation consistent across re-renders.
 */
export function useProviderBatchController(): ProviderBatchController {
  /** Monotonically increasing batch counter. Never resets. */
  const nextBatchIdRef = useRef(0);
  /** Identity of the currently-active batch; stale callbacks see a mismatch and bail out. */
  const activeBatchRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const batchTestingRef = useRef(false);
  const [batchTestingState, setBatchTestingState] = useState(false);

  const cancelMountedBatch = useCallback(() => {
    const active = activeBatchRef.current;
    if (!active) return;
    active.controller.abort();
    activeBatchRef.current = null;
    batchTestingRef.current = false;
    setBatchTestingState(false);
  }, []);

  const abortBatchOnUnmount = useCallback(() => {
    activeBatchRef.current?.controller.abort();
    activeBatchRef.current = null;
  }, []);

  const startBatch = useCallback((): AbortController => {
    // Cancel any in-flight batch (ownership transfers to the new batch).
    activeBatchRef.current?.controller.abort();
    const batchId = ++nextBatchIdRef.current;
    const controller = new AbortController();
    activeBatchRef.current = { id: batchId, controller };
    batchTestingRef.current = true;
    setBatchTestingState(true);
    return controller;
  }, []);

  // Cancel batch on unmount — no state updates (component may be gone).
  useEffect(() => {
    return () => { abortBatchOnUnmount(); };
  }, [abortBatchOnUnmount]);

  const isActiveBatch = useCallback((controller: AbortController) => {
    return activeBatchRef.current?.controller === controller;
  }, []);

  return { batchTesting: batchTestingState, startBatch, cancelMountedBatch, abortBatchOnUnmount, isActiveBatch };
}
