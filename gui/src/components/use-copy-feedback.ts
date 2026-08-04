import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../oauth-health-display";

const FEEDBACK_MS = 2500;

export type CopyOutcome = "copied" | "unavailable";

/**
 * One copy protocol for every copy affordance: attempt, report honestly, expire.
 *
 * Feedback carries the scope it belongs to, so a changed scope reads as idle at
 * render time rather than through an effect — `react-hooks/set-state-in-effect`
 * forbids the effect form, and a stale "copied" over a different target is a
 * false success. The timer lives in a ref because a functional-update guard
 * cannot stop the first click's timer from clearing the second click's label.
 */
export function useCopyFeedback<Scope = void>(): {
  outcomeFor: (scope: Scope) => CopyOutcome | null;
  copy: (text: string, scope: Scope) => void;
} {
  const [feedback, setFeedback] = useState<{ scope: Scope; outcome: CopyOutcome } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const outcomeFor = useCallback(
    (scope: Scope) => (feedback && Object.is(feedback.scope, scope) ? feedback.outcome : null),
    [feedback],
  );

  const copy = useCallback((text: string, scope: Scope) => {
    // Writes settle out of order: a permission prompt can delay the first
    // attempt past a second one. Without a generation the older completion
    // overwrites the newer click's result — and its timer expires the wrong
    // feedback. Same guard shape the OAuth polling paths already use.
    const generation = ++generationRef.current;
    void copyTextToClipboard(text).then((ok) => {
      if (generationRef.current !== generation) return;
      clearTimer();
      setFeedback({ scope, outcome: ok ? "copied" : "unavailable" });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (generationRef.current !== generation) return;
        setFeedback(null);
      }, FEEDBACK_MS);
    });
  }, [clearTimer]);

  return { outcomeFor, copy };
}
