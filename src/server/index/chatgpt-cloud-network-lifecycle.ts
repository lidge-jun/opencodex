import type { OcxConfig } from "../../types";
import type { CloudNetworkStatus } from "../../chatgpt/cloud-network/contract";
import type { startCloudNetwork } from "../../chatgpt/cloud-network/runtime";

type Handle = Awaited<ReturnType<typeof startCloudNetwork>>;
export interface CloudNetworkLifecycle {
  start(config: OcxConfig): void;
  status(): CloudNetworkStatus;
  configure(enabled: boolean, persist: () => void): Promise<CloudNetworkStatus>;
  recover(persist: () => void): Promise<CloudNetworkStatus>;
  settled(): Promise<void>;
  stop(): Promise<void>;
}

export function createChatgptCloudNetworkLifecycle(deps: {
  platform?: NodeJS.Platform;
  start?: () => Promise<Handle>;
  recover?: () => Promise<void>;
  warn?: (message: string) => void;
} = {}): CloudNetworkLifecycle {
  let config: OcxConfig | undefined;
  let handle: Handle | undefined;
  let needsRecovery = false;
  let stopped = false;
  let snapshot: CloudNetworkStatus = { configured: false, state: "disabled", applicationHandshake: "unverified" };
  let pending: Promise<unknown> = Promise.resolve();
  const status = () => ({ ...snapshot, configured: config?.chatgptDesktop?.cloudNetwork === true });
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const task = pending.then(work, work);
    pending = task.catch(() => {});
    return task;
  };
  const fail = (reason: string) => {
    snapshot = { ...snapshot, state: "unavailable", reason };
    (deps.warn ?? console.warn)(`ChatGPT cloud network unavailable (${reason}); inspect with: ocx chatgpt network status`);
  };
  const stopHandle = async (recoverWithoutHandle = false) => {
    const previous = handle;
    handle = undefined;
    try {
      if (previous) await previous.stop();
      else if (recoverWithoutHandle) {
        const recover = deps.recover ?? (await import("../../chatgpt/cloud-network/runtime")).recoverCloudNetwork;
        await recover();
      }
      needsRecovery = false;
    } catch (error) { needsRecovery = true; fail("recovery_failed"); throw error; }
  };
  const reconcile = async () => {
    if (stopped || config?.chatgptDesktop?.cloudNetwork !== true) {
      await stopHandle(needsRecovery);
      snapshot = { configured: false, state: stopped ? "stopped" : "disabled", applicationHandshake: "unverified" };
      return status();
    }
    if ((deps.platform ?? process.platform) !== "darwin") { fail("macos_required"); return status(); }
    if (config.runtimeRole === "client") { fail("client_role"); return status(); }
    if (handle) return status();
    snapshot = { configured: true, state: "starting", applicationHandshake: "unverified" };
    try {
      const runtime = deps.start ? undefined : await import("../../chatgpt/cloud-network/runtime");
      const current = await (deps.start ?? runtime!.startCloudNetwork)();
      handle = current;
      needsRecovery = false;
      snapshot = { configured: true, state: "active", applicationHandshake: "unverified" };
      void current.lost.then(lost => {
        if (lost && handle === current) { handle = undefined; needsRecovery = true; fail("helper_disconnected"); }
      });
    } catch (error) {
      // Fixed reason codes only: never print an upstream URL or raw socket error.
      const { CloudNetworkError } = await import("../../chatgpt/cloud-network/contract");
      if (error instanceof CloudNetworkError && (error.recoveryRequired || error.message === "helper_disconnected")) needsRecovery = true;
      fail(error instanceof CloudNetworkError ? error.message : "startup_failed");
    }
    return status();
  };
  return {
    start(value) {
      config = value;
      if (value.chatgptDesktop?.cloudNetwork === true) void enqueue(reconcile);
    },
    status,
    configure(enabled, persist) {
      return enqueue(async () => {
        if (stopped || !config) throw new Error("Cloud network runtime is stopping or absent");
        persist();
        if (config.chatgptDesktop?.cloudNetwork !== enabled) throw new Error("Cloud network configuration was not saved");
        return reconcile();
      });
    },
    recover(persist) {
      return enqueue(async () => {
        if (stopped || !config) throw new Error("Cloud network runtime is stopping or absent");
        persist();
        await stopHandle(true);
        snapshot = { configured: false, state: "disabled", applicationHandshake: "unverified" };
        return status();
      });
    },
    settled: async () => { await pending; },
    stop() {
      stopped = true;
      return enqueue(async () => {
        await stopHandle(needsRecovery);
        snapshot = { configured: status().configured, state: "stopped", applicationHandshake: "unverified" };
      });
    },
  };
}
