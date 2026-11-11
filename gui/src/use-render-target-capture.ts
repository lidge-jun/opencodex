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
  const logical = targetKey ? targetKey : apiBase;
  // The capture also depends on the base, not only the logical key. A relay that re-pairs to
  // the same hub can keep the key while the request base and transport move (relay ->
  // direct), and a capture taken against the old base is refused by every targetFetch until
  // this surface remounts. The logical key itself is unchanged, so drafts keyed by it stay.
  const identity = `${logical}\u0000${apiBase}`;
  const make = (): ApiTargetCapture => typeof window === "undefined"
    // Server rendering has no location or session; the capture is never used there.
    ? { apiBase, targetKey: logical, origin: "", requestGeneration: 0, transport: "same-origin" }
    : captureApiTarget("shared", apiBase);
  const [state, setState] = useState<{ identity: string; capture: ApiTargetCapture }>(() => ({ identity, capture: make() }));
  if (state.identity !== identity) {
    setState({ identity, capture: make() });
  }
  return state.capture;
}
