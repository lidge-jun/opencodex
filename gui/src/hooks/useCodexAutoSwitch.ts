import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_AUTO_SWITCH_THRESHOLD,
  autoSwitchThresholdReadDisposition,
  normalizeAutoSwitchThreshold,
  parseEnabledAutoSwitchThreshold,
  planAutoSwitchToggleWrite,
  putAutoSwitchThreshold,
} from "../codex-auto-switch";
import type { AutoSwitchFeedback } from "../components/CodexAutoSwitchSetting";

export interface CodexAutoSwitchController {
  threshold: number | null;
  draft: string;
  saving: boolean;
  loadError: boolean;
  feedback: AutoSwitchFeedback;
  beginServerRead(): number;
  acceptServerRead(value: unknown, startedRevision: number): void;
  rejectServerRead(): void;
  setDraft(value: string): void;
  setEditing(editing: boolean): void;
  commit(): Promise<boolean>;
  cancel(): void;
  toggle(): Promise<boolean>;
}

export function useCodexAutoSwitch(
  apiBase: string,
  messages: {
    updated: string;
    updateFailed: string;
    invalid: string;
  },
): CodexAutoSwitchController {
  const [threshold, setThreshold] = useState<number | null>(null);
  const [draft, setDraftState] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<AutoSwitchFeedback>(null);
  const thresholdRef = useRef<number | null>(null);
  const lastEnabledRef = useRef(DEFAULT_AUTO_SWITCH_THRESHOLD);
  const editingRef = useRef(false);
  const savingRef = useRef(false);
  const cancelledDraftRef = useRef(false);
  const revisionRef = useRef(0);
  const deferredServerValueRef = useRef<number | null>(null);
  const feedbackTimeoutRef = useRef<number | null>(null);

  const apply = useCallback((next: number) => {
    thresholdRef.current = next;
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
    if (thresholdRef.current === null) setLoadError(false);
    return revisionRef.current;
  }, []);

  const acceptServerRead = useCallback((value: unknown, startedRevision: number) => {
    setLoadError(false);
    const disposition = autoSwitchThresholdReadDisposition(
      editingRef.current,
      savingRef.current,
      startedRevision,
      revisionRef.current,
    );
    if (disposition === "defer") {
      deferredServerValueRef.current = normalizeAutoSwitchThreshold(value);
    } else if (disposition === "apply") {
      queueOrApply(normalizeAutoSwitchThreshold(value));
    }
  }, [queueOrApply]);

  const rejectServerRead = useCallback(() => {
    if (thresholdRef.current === null) setLoadError(true);
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
    const ok = await putAutoSwitchThreshold(apiBase, next);
    revisionRef.current += 1;
    savingRef.current = false;
    if (ok) {
      deferredServerValueRef.current = null;
      apply(next);
      if (showSuccess) showFeedback(messages.updated, false);
    } else {
      if (!reconcileDeferred()) apply(previous);
      showFeedback(messages.updateFailed, true);
    }
    setSaving(false);
    return ok;
  }, [apiBase, apply, clearFeedback, messages.updateFailed, messages.updated, reconcileDeferred, showFeedback]);

  const rejectDraft = useCallback(() => {
    editingRef.current = false;
    const current = thresholdRef.current;
    if (!reconcileDeferred() && current !== null) {
      setDraftState(String(current > 0 ? current : lastEnabledRef.current));
    }
    showFeedback(messages.invalid, true);
  }, [messages.invalid, reconcileDeferred, showFeedback]);

  const cancel = useCallback(() => {
    editingRef.current = false;
    cancelledDraftRef.current = true;
    clearFeedback();
    const current = thresholdRef.current;
    if (!reconcileDeferred() && current !== null) {
      setDraftState(String(current > 0 ? current : lastEnabledRef.current));
    }
  }, [clearFeedback, reconcileDeferred]);

  const commit = useCallback(async (): Promise<boolean> => {
    if (cancelledDraftRef.current) {
      cancelledDraftRef.current = false;
      return true;
    }
    const current = thresholdRef.current;
    if (current === null || savingRef.current) return false;
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
    const current = thresholdRef.current;
    if (current === null || savingRef.current) return false;
    editingRef.current = false;
    const plan = planAutoSwitchToggleWrite(current, draft, lastEnabledRef.current);
    if (plan === null) {
      rejectDraft();
      return false;
    }
    const ok = await save(plan.threshold, current);
    if (!ok) return false;
    lastEnabledRef.current = plan.lastEnabled;
    if (plan.threshold === 0) setDraftState(String(plan.lastEnabled));
    return ok;
  }, [draft, rejectDraft, save]);

  const setDraft = useCallback((value: string) => {
    editingRef.current = true;
    cancelledDraftRef.current = false;
    clearFeedback();
    setDraftState(value);
  }, [clearFeedback]);

  const setEditing = useCallback((editing: boolean) => {
    editingRef.current = editing;
  }, []);

  return {
    threshold,
    draft,
    saving,
    loadError,
    feedback,
    beginServerRead,
    acceptServerRead,
    rejectServerRead,
    setDraft,
    setEditing,
    commit,
    cancel,
    toggle,
  };
}
