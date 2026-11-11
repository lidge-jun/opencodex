/**
 * The marker `ocx claude` and `ocx opencode` (and `ocx minimax`, which reuses the OpenCode launch)
 * set on the detached `ocx start` they launch, naming the launcher. Their proxies also carry
 * OCX_SERVICE=1, which is all a service registered before v2.49 gives its process, so a restart
 * reads this marker as the positive evidence that no service manager owns the runtime
 * (src/client/runtime-restart.ts classifyClientRestartSupervisor). A manager's own marker
 * (OCX_SERVICE_MANAGED, the Windows wrapper marker) always wins over it.
 */
export const COMPANION_PROXY_ENV = "OCX_COMPANION_PROXY";
