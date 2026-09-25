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

export function useProviderSettingsDeepLink(
  providerNames: readonly string[] | null,
  selected: string | null,
  select: (name: string) => void,
): ProviderSettingsFocus {
  // `seq` makes a repeated hash event for the same name a new request.
  const [request, setRequest] = useState(() => ({ name: readProviderSettingsTarget(), seq: 0 }));
  const [focus, setFocus] = useState<ProviderSettingsFocus>({ token: 0, provider: null });
  const appliedSeqRef = useRef(-1);
  const previousSelectedRef = useRef<string | null>(selected);
  const namesKey = providerNames ? providerNames.join("\n") : null;

  useEffect(() => {
    const sync = () => setRequest(current => ({ name: readProviderSettingsTarget(), seq: current.seq + 1 }));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  useEffect(() => {
    const { name, seq } = request;
    if (!name || namesKey === null || appliedSeqRef.current === seq) return;
    if (!namesKey.split("\n").includes(name)) return;
    appliedSeqRef.current = seq;
    select(name);
    setFocus(current => ({ token: current.token + 1, provider: name }));
  }, [namesKey, request, select]);

  useEffect(() => {
    const previous = previousSelectedRef.current;
    previousSelectedRef.current = selected;
    const linked = readProviderSettingsTarget();
    if (!linked || appliedSeqRef.current !== request.seq || request.name !== linked) return;
    const movedAway = selected !== null ? selected !== linked : previous === linked;
    if (movedAway) replaceHash(PROVIDERS_HASH);
    // `request` is deliberately not a dependency: only a selection change can move away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  return focus;
}
