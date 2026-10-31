import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath, repoPath } from "../helpers/repo-root";

for (const mode of ["parent", "api", "sync"]) {
  for (const ownership of ["hub", "pending", "standalone"]) {
    test(`R7 real history ${mode} respects ${ownership} at history entry`, () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-stop-history-"));
      try {
        const child = spawnSync(process.execPath, [fixturePath("stop-restore-history-runner.ts"), mode, ownership], {
          cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: join(root, "ocx"), CODEX_HOME: join(root, "codex"), GROK_HOME: join(root, "grok") },
          encoding: "utf8", timeout: 20_000, windowsHide: true,
        });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        const value = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
        expect(value.before).toBeDefined();
        if (ownership === "standalone") {
          expect(value.after.row).toEqual({ model_provider: "opencodex", source: "exec", has_user_event: 0 });
          expect(value.after.rollout).not.toBe(value.before.rollout);
          expect(value.after.manifest).toBeNull();
          expect(value.result.success ?? !value.result.other).toBe(true);
          if (mode === "sync") expect(value.lockChecks).toEqual([
            { phase: "rollout", config: true, history: true },
            { phase: "manifest", config: true, history: true },
          ]);
        } else {
          expect(value.after).toEqual(value.before);
          if (mode === "api") expect(value.result).toMatchObject({ success: ownership === "hub", sharedTeardown: ownership === "hub" ? "not-owned" : "refused" });
          else expect(value.result.boundary).toBe(ownership === "hub" ? "hub-owned" : "unproven");
          expect(value.receiptExists).toBe(ownership === "pending");
          expect(value.settled).toBe(ownership === "hub" ? "skipped" : "refused");
        }
      } finally { removeTreeWithRetry(root); }
    }, 20_000);
  }
}
