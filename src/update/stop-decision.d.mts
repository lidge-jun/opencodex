/** Declaration for the plain-ESM post-stop decision shared with `bin/ocx.mjs`. */
export declare function decidePostStopUpdate(input: {
  status: number | null;
  hasRuntimeState: boolean;
  liveness: "live" | "dead" | "unknown";
}): {
  proceed: boolean;
  reason: "stop-failed" | "runtime-state" | "proxy-live" | "proxy-unknown" | "history-only" | "ok";
};
