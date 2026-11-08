import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { OAuthStatus } from "./providers-shared";

type OAuthSnapshot = { target: object; providers: string[]; status: Record<string, OAuthStatus> };

// Each visit gets a new identity, including A -> B -> A. Old async writers cannot
// update the current visit, and the render that changes target sees empty state.
export function useTargetOAuthState(apiBase: string) {
  const target = useMemo(() => ({ apiBase }), [apiBase]);
  const [snapshot, setSnapshot] = useState<OAuthSnapshot>(() => ({ target, providers: [], status: {} }));
  const current: OAuthSnapshot = snapshot.target === target ? snapshot : { target, providers: [], status: {} };
  if (snapshot !== current) setSnapshot(current);
  const setOauthProviders = useCallback<Dispatch<SetStateAction<string[]>>>(update => {
    setSnapshot(previous => previous.target !== target ? previous : {
      ...previous, providers: typeof update === "function" ? update(previous.providers) : update,
    });
  }, [target]);
  const setOauthStatus = useCallback<Dispatch<SetStateAction<Record<string, OAuthStatus>>>>(update => {
    setSnapshot(previous => previous.target !== target ? previous : {
      ...previous, status: typeof update === "function" ? update(previous.status) : update,
    });
  }, [target]);
  return { oauthProviders: current.providers, oauthStatus: current.status, setOauthProviders, setOauthStatus };
}
