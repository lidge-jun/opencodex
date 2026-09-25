/**
 * `#providers?provider=<name>` opens that provider's settings tab. The plan preview links here
 * (protocol-deep-links.ts) so "which wire does this candidate receive" lands on the panel that
 * answers it.
 *
 * The hash is the source of truth: it is read on mount and on every hashchange/popstate, so
 * Back/Forward re-apply it. A name that is not configured (yet) waits for the provider list and
 * is ignored if it never appears. Selecting another provider, or closing this one, drops the
 * query with a passive replace, so a refresh does not reopen a provider the user moved away from.
 */
import { useEffect, useRef, useState } from "react";
import { replaceHash } from "../hash-routing";
import { PROVIDERS_HASH, readProviderSettingsTarget } from "../protocol-deep-links";

export interface ProviderSettingsFocus {
  /** Increases each time a deep link asks for `provider`'s settings. */
  token: number;
  provider: string | null;
}

/**
 * `select` must be a state setter of the component calling this hook: a matching link is
 * applied while that component renders (React's "adjust state when a prop changes"), so the
 * provider and its Settings tab appear in the same paint.
 */
export function useProviderSettingsDeepLink(
  providerNames: readonly string[] | null,
  selected: string | null,
  select: (name: string) => void,
): ProviderSettingsFocus {
  // `seq` makes a repeated hash event for the same name a new request.
  const [request, setRequest] = useState(() => ({ name: readProviderSettingsTarget(), seq: 0 }));
  const [applied, setApplied] = useState<{ seq: number; provider: string } | null>(null);
  const previousSelectedRef = useRef<string | null>(selected);

  useEffect(() => {
    const sync = () => setRequest(current => ({ name: readProviderSettingsTarget(), seq: current.seq + 1 }));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // A name that is not configured (yet) waits here until the provider list contains it.
  if (request.name && applied?.seq !== request.seq && providerNames?.includes(request.name)) {
    setApplied({ seq: request.seq, provider: request.name });
    select(request.name);
  }

  useEffect(() => {
    const previous = previousSelectedRef.current;
    previousSelectedRef.current = selected;
    // Only a selection change can move away; a new request alone must not drop its own hash.
    if (previous === selected) return;
    const linked = readProviderSettingsTarget();
    if (!linked || applied?.seq !== request.seq || request.name !== linked) return;
    const movedAway = selected !== null ? selected !== linked : previous === linked;
    if (movedAway) replaceHash(PROVIDERS_HASH);
  }, [applied, request, selected]);

  return applied ? { token: applied.seq + 1, provider: applied.provider } : { token: 0, provider: null };
}
