/** Test-only post-inspection drift seam; this is NOT the production Worker entry. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";
import { codexCliUpdateInspectionDepsFromSnapshot } from "../../src/codex/cli-update-inspection-context";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import type { CodexCliUpdateWorkerRunMessage } from "../../src/codex/cli-update-worker";

declare const self: Worker;
if (typeof Bun !== "undefined" && Bun.isMainThread === false) {
  let ran = false;
  self.onmessage = async ({ data }: MessageEvent<CodexCliUpdateWorkerRunMessage>) => {
    if (ran || data.type !== "run" || data.operation !== "plan") return;
    ran = true;
    try {
      const snapshot = data.snapshot;
      if (!snapshot?.path || !snapshot.home) throw new Error("fixture_snapshot_missing");
      const plan = await createCodexCliUpdatePlan({
        inspectionDeps: codexCliUpdateInspectionDepsFromSnapshot(snapshot),
        inspect: async deps => {
          const report = await inspectCodexCliInstall(deps);
          if (!report.managed || !report.installContentDigest) throw new Error("fixture_inspection_missing");
          // Same realm/report/private evidence; only the previously observed npm bytes change.
          writeFileSync(join(snapshot.path!, "node_modules", "npm", "bin", "npm-cli.js"),
            `require('node:fs').writeFileSync(${JSON.stringify(join(snapshot.home!, "metadata-ran"))}, 'unexpected'); process.exit(97);`);
          return report;
        },
      });
      self.postMessage({ type: "done", requestId: data.requestId, jobId: data.jobId, operation: "plan", plan });
    } catch {
      self.postMessage({ type: "error", requestId: data.requestId, jobId: data.jobId, message: "fixture_worker_failed" });
    } finally { self.onmessage = null; }
  };
}
