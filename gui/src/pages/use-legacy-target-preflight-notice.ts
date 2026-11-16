import { useEffect, useLayoutEffect, useRef } from "react";
import { TARGET_PREFLIGHT_LEGACY_EVENT } from "../api";

/**
 * One notice per logical target when a relay answers a mutation with the legacy
 * preflight instead of the expected-target header.
 *
 * The event names the capture's target, not the live one: a downgrade observed by an
 * action that started on A must not be reported as B's problem. The callback is read
 * through a ref so a changing `onNotice` does not re-subscribe the listener.
 */
export function useLegacyTargetPreflightNotice(targetKey: string | undefined, onNotice: () => void): void {
  const targetKeyRef = useRef(targetKey);
  useLayoutEffect(() => { targetKeyRef.current = targetKey; }, [targetKey]);
  const onNoticeRef = useRef(onNotice);
  useLayoutEffect(() => { onNoticeRef.current = onNotice; });
  const notifiedRef = useRef(new Set<string>());
  useEffect(() => {
    const onLegacyPreflight = (event: Event) => {
      const detail = (event as CustomEvent<{ targetKey?: string }>).detail;
      const key = detail?.targetKey;
      if (!key || key !== targetKeyRef.current || notifiedRef.current.has(key)) return;
      notifiedRef.current.add(key);
      onNoticeRef.current();
    };
    window.addEventListener(TARGET_PREFLIGHT_LEGACY_EVENT, onLegacyPreflight);
    return () => window.removeEventListener(TARGET_PREFLIGHT_LEGACY_EVENT, onLegacyPreflight);
  }, []);
}
