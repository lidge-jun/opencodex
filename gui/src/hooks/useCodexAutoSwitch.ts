import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_AUTO_SWITCH_THRESHOLD,
  autoSwitchThresholdReadDisposition,
  extractAutoSwitchThresholdPayload,
  normalizeAutoSwitchThreshold,
  parseEnabledAutoSwitchThreshold,
  planAutoSwitchToggleWrite,
  putAutoSwitchThreshold,
} from "../codex-auto-switch";
import type { AutoSwitchFeedback } from "../components/CodexAutoSwitchSetting";

export interface CodexAutoSwitchController {
  /** Always a number — seeded with the default so the card never waits on /active. */
  threshold: number;
  draft: string;
  /** False until /active (or hydrate) confirms server state — blocks writes of the seed default. */
  hydrated: boolean;
  saving: boolean;
  loadError: boolean;
  feedback: AutoSwitchFeedback;
  beginServerRead(): number;
  acceptServerRead(value: unknown, startedRevision: number): void;
  hydrateServerValue(value: unknown): void;
  rejectServerRead(): void;
  setDraft(value: string): void;
  setEditing(editing: boolean): void;
  commit(): Promise<boolean>;
  cancel(): void;
  toggle(): Promise<boolean>;
  retry(): void;
}

export function useCodexAutoSwitch(
  apiBase: string,
  messages: {
    updated: string;
    updateFailed: string;
    invalid: string;
  },
): CodexAutoSwitchController {
  // Seed immediately — paint chrome with the default, but block writes until /active confirms.
  const [threshold, setThreshold] = useState(DEFAULT_AUTO_SWITCH_THRESHOLD);
  const [draft, setDraftState] = useState(String(DEFAULT_AUTO_SWITCH_THRESHOLD));
  const [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<AutoSwitchFeedback>(null);
  const thresholdRef = useRef(DEFAULT_AUTO_SWITCH_THRESHOLD);
  const hydratedRef = useRef(false);
  const lastEnabledRef = useRef(DEFAULT_AUTO_SWITCH_THRESHOLD);
  const editingRef = useRef(false);
  const savingRef = useRef(false);
  const cancelledDraftRef = useRef(false);
  const revisionRef = useRef(0);
  const deferredServerValueRef = useRef<number | null>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);

  const apply = useCallback((next: number) => {
    thresholdRef.current = next;
    hydratedRef.current = true;
    setHydrated(true);
    setThreshold(next);
    if (next > 0) lastEnabledRef.current = next;
    setDraftState(String(next > 0 ? next : lastEnabledRef.current));
  }, []);

  const queueOrApply = useCallback((next: number) => {
    if (editingRef.current || savingRef.current) {
      deferredServerValueRef.current = next;
      return;
    }
    deferredServerValueRef.current = null;
    apply(next);
  }, [apply]);

  const reconcileDeferred = useCallback((): boolean => {
    const deferred = deferredServerValueRef.current;
    if (deferred === null) return false;
    deferredServerValueRef.current = null;
    apply(deferred);
    return true;
  }, [apply]);

  const clearFeedback = useCallback(() => {
    if (feedbackTimeoutRef.current !== null) {
      window.clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
    setFeedback(null);
  }, []);

  const showFeedback = useCallback((message: string, error: boolean) => {
    if (feedbackTimeoutRef.current !== null) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
    setFeedback({ tone: error ? "err" : "ok", message });
    feedbackTimeoutRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimeoutRef.current = null;
    }, 5000);
  }, []);

  useEffect(() => () => {
    if (feedbackTimeoutRef.current !== null) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
  }, []);

  const beginServerRead = useCallback((): number => {
    if (!hydratedRef.current) setLoadError(false);
    return revisionRef.current;
  }, []);

  const acceptServerRead = useCallback((value: unknown, startedRevision: number) => {
    setLoadError(false);
    const thresholdValue = extractAutoSwitchThresholdPayload(value);
    const disposition = autoSwitchThresholdReadDisposition(
      editingRef.current,
      savingRef.current,
      startedRevision,
      revisionRef.current,
    );
    if (disposition === "defer") {
      deferredServerValueRef.current = normalizeAutoSwitchThreshold(thresholdValue);
    } else if (disposition === "apply") {
      queueOrApply(normalizeAutoSwitchThreshold(thresholdValue));
    }
  }, [queueOrApply]);

  /**
   * Seed from a value another surface already fetched. Applies ONLY while
   * uninitialized, so it can never disturb a draft, a pending save, or a newer read.
   */
  const hydrateServerValue = useCallback((value: unknown) => {
    if (hydratedRef.current) return;
    if (editingRef.current || savingRef.current) return;
    setLoadError(false);
    apply(normalizeAutoSwitchThreshold(extractAutoSwitchThresholdPayload(value)));
  }, [apply]);

  const rejectServerRead = useCallback(() => {
    if (!hydratedRef.current) setLoadError(true);
  }, []);

  const save = useCallback(async (
    next: number,
    previous: number,
    showSuccess = true,
  ): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    editingRef.current = false;
    clearFeedback();
    setSaving(true);
    revisionRef.current += 1;
    try {
      const ok = await putAutoSwitchThreshold(apiBase, next);
      revisionRef.current += 1;
      if (ok) {
        deferredServerValueRef.current = null;
        apply(next);
        if (showSuccess) showFeedback(messages.updated, false);
      } else {
        if (!reconcileDeferred()) apply(previous);
        showFeedback(messages.updateFailed, true);
      }
      return ok;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  // oxlint-disable-next-line react/react-compiler -- preserve existing callback dependency semantics during Oxlint migration
  }, [apiBase, apply, clearFeedback, messages.updateFailed, messages.updated, reconcileDeferred, showFeedback]);

  const rejectDraft = useCallback(() => {
    editingRef.current = false;
    const current = thresholdRef.current;
    if (!reconcileDeferred()) {
      setDraftState(String(current > 0 ? current : lastEnabledRef.current));
    }
    showFeedback(messages.invalid, true);
  }, [messages.invalid, reconcileDeferred, showFeedback]);

  const cancel = useCallback(() => {
    editingRef.current = false;
    cancelledDraftRef.current = true;
    clearFeedback();
    const current = thresholdRef.current;
    if (!reconcileDeferred()) {
      setDraftState(String(current > 0 ? current : lastEnabledRef.current));
    }
  }, [clearFeedback, reconcileDeferred]);

  const commit = useCallback(async (): Promise<boolean> => {
    if (cancelledDraftRef.current) {
      cancelledDraftRef.current = false;
      return true;
    }
    // Never PUT the paint-time default before /active confirms the real value.
    if (!hydratedRef.current || savingRef.current) return false;
    const current = thresholdRef.current;
    editingRef.current = false;
    const next = parseEnabledAutoSwitchThreshold(draft);
    if (next === null) {
      rejectDraft();
      return false;
    }
    if (next === current) {
      if (!reconcileDeferred()) setDraftState(String(next));
      return true;
    }
    return save(next, current);
  }, [draft, reconcileDeferred, rejectDraft, save]);

  const toggle = useCallback(async (): Promise<boolean> => {
    if (!hydratedRef.current || savingRef.current) return false;
    const current = thresholdRef.current;
    editingRef.current = false;
    const plan = planAutoSwitchToggleWrite(current, draft, lastEnabledRef.current);
    const ok = await save(plan.threshold, current);
    if (!ok) return false;
    lastEnabledRef.current = plan.lastEnabled;
    if (plan.threshold === 0) setDraftState(String(plan.lastEnabled));
    return ok;
  }, [draft, save]);

  const setDraft = useCallback((value: string) => {
    if (!hydratedRef.current) return;
    editingRef.current = true;
    cancelledDraftRef.current = false;
    clearFeedback();
    setDraftState(value);
  }, [clearFeedback]);

  const setEditing = useCallback((editing: boolean) => {
    editingRef.current = editing;
  }, []);

  const retry = useCallback(() => {
    setLoadError(false);
    clearFeedback();
  }, [clearFeedback]);

  return {
    threshold,
    draft,
    hydrated,
    saving,
    loadError,
    feedback,
    beginServerRead,
    acceptServerRead,
    hydrateServerValue,
    rejectServerRead,
    setDraft,
    setEditing,
    commit,
    cancel,
    toggle,
    retry,
  };
}
