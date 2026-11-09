import { useEffect, useSyncExternalStore } from "react";
import { purgeLegacyUsageCache, USAGE_SESSION_CHANGED, usageSessionSnapshot } from "../../api";

function subscribe(listener: () => void) {
  window.addEventListener(USAGE_SESSION_CHANGED, listener);
  return () => window.removeEventListener(USAGE_SESSION_CHANGED, listener);
}

export function useUsageSession() {
  useEffect(() => { purgeLegacyUsageCache(); }, []);
  return useSyncExternalStore(subscribe, usageSessionSnapshot, usageSessionSnapshot);
}
