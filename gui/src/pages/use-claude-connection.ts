import { useRef, useState } from "react";
import { toggleNativeIntegration } from "./integrations/native-api";

/** Shared immediate mutation: only acknowledge the server's committed state. */
export function useClaudeConnection(apiBase: string) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const change = async (enabled: boolean, onSuccess: (enabled: boolean) => void, onError: (error: unknown) => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await toggleNativeIntegration(apiBase, "claude", enabled);
      onSuccess(result.desiredEnabled);
    } catch (error) {
      onError(error);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, change };
}
