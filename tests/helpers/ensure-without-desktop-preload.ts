import { mock } from "bun:test";
import * as coldStart from "../../src/cli/ensure-desktop-cold-start";

// A temporary HOME isolates files, but cannot hide the developer's running Desktop.
// These CLI-owned fixtures exercise real ensure/start and shared-client ownership;
// only the machine-wide Desktop process observation is outside their boundary.
const productionDeps = coldStart.productionDesktopColdStartDeps;
mock.module("../../src/cli/ensure-desktop-cold-start", () => ({
  ...coldStart,
  productionDesktopColdStartDeps: <T>(waitForProxy: (timeoutMs: number) => Promise<T | null>) => ({
    ...productionDeps(waitForProxy),
    desktopProcess: () => "absent" as const,
  }),
}));
