/**
 * claude-autoconnect — normalization boundary for the Auto-connect capability
 * contract. A missing capability field (old/stale backend) fails closed so a
 * persisted systemEnv:true is never presented as active on a non-Darwin host.
 */
export function reconcileAutoConnectState(response: {
  autoConnectSupported?: unknown;
  systemEnv?: unknown;
}): { autoConnectSupported: boolean; systemEnv: boolean } {
  const autoConnectSupported = response.autoConnectSupported === true;
  return {
    autoConnectSupported,
    systemEnv: autoConnectSupported && response.systemEnv === true,
  };
}
