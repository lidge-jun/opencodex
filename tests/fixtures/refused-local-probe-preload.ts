// Child-only transport seam for CLI cases that require a refused /healthz probe.
// No released port or host listener can turn this fixture into a live endpoint.
import { plugin } from "bun";

plugin({
  name: "refused-local-health-probe",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]server[\\/]direct-local-http\.ts$/ }, () => ({
      loader: "ts",
      contents: `export async function directLocalHttpFetch(input) {
        // Recovery requires definitive negatives for both loopback families.
        if (!["http://127.0.0.1:42101/healthz", "http://[::1]:42101/healthz"].includes(String(input))) throw new Error("unexpected fixture probe");
        const error = Object.assign(new Error("fixture connection refused"), { code: "ECONNREFUSED" });
        console.error("[refused-probe] " + error.code);
        throw error;
      }`,
    }));
  },
});
