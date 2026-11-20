/** Extra time the stop controller gives the proxy after its configured turn drain. */
export const PROXY_STOP_EXIT_GRACE_MS = 3_000;

/** Leave one second of the controller's grace for listener teardown and process exit. */
export const OPTIONAL_SHUTDOWN_GRACE_MS = PROXY_STOP_EXIT_GRACE_MS - 1_000;
