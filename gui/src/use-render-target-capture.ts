import { useState } from "react";
import { captureApiTarget, type ApiTargetCapture } from "./api";

/**
 * A capture owned by a rendered surface.
 *
 * The capture is created on the render that last saw this target identity and is reused
 * across later renders while that identity is unchanged. A module-level target change that
 * has not re-rendered this surface therefore cannot retarget its next action; a real prop
 * change starts a new capture.
 */
export function useRenderTargetCapture(apiBase: string, targetKey?: string): ApiTargetCapture {
  // An empty targetKey is "not supplied", not an identity shared by every embedded base.
  const identity = targetKey ? targetKey : apiBase;
  const make = (): ApiTargetCapture => typeof window === "undefined"
    // Server rendering has no location or session; the capture is never used there.
    ? { apiBase, targetKey: identity, origin: "", requestGeneration: 0, transport: "same-origin" }
    : captureApiTarget("shared", apiBase);
  const [state, setState] = useState<{ identity: string; capture: ApiTargetCapture }>(() => ({ identity, capture: make() }));
  if (state.identity !== identity) {
    setState({ identity, capture: make() });
  }
  return state.capture;
}
