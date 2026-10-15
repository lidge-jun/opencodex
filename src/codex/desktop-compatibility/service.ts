import { createDesktopCompatibilityRuntime, type DesktopCompatibilityRuntime } from "./runtime";

/** One runtime for management and automatic startup; shutdown never constructs a new instance. */
export function createDesktopCompatibilityService(factory: () => DesktopCompatibilityRuntime = createDesktopCompatibilityRuntime) {
  let runtime: DesktopCompatibilityRuntime | undefined;
  let starting: Promise<ReturnType<DesktopCompatibilityRuntime["status"]>> | null = null;
  let shuttingDown = false;
  return {
    get(): DesktopCompatibilityRuntime {
      if (!runtime) {
        const raw = factory();
        runtime = { ...raw, start() {
          if (shuttingDown) return Promise.reject(new Error("desktop_compatibility_stopping"));
          if (starting) return Promise.reject(new Error("desktop_compatibility_busy"));
          starting = raw.start().finally(() => { starting = null; });
          return starting;
        } };
      }
      return runtime;
    },
    async shutdown(): Promise<void> {
      shuttingDown = true;
      try { await starting; } catch { /* failed start owns its cleanup */ }
      if (runtime) await runtime.stop();
    },
  };
}
const service = createDesktopCompatibilityService();
export const getDesktopCompatibilityRuntime = () => service.get();
export const shutdownDesktopCompatibility = () => service.shutdown();
