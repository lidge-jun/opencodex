import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { withInstalledShim } from "../helpers/codex-shim-install-fixture";

describe("version-manager shim destruction (#2412)", () => {
  test("a destroyed shim diagnostic does not open a non-file launcher", () => {
    if (process.platform === "win32") return;
    withInstalledShim(({ home, wrappers, backups }) => {
      rmSync(wrappers[0]);
      expect(spawnSync("mkfifo", [wrappers[0]]).status).toBe(0);
      rmSync(backups[0]);
      const shimModule = repoPath("src", "codex", "shim.ts");
      const script = `
        const { autoRestoreCodexShim } = await import(${JSON.stringify(shimModule)});
        console.log(JSON.stringify(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} })));
      `;

      const child = spawnSync(process.execPath, ["-e", script], {
        cwd: repoRoot(),
        env: { ...process.env, OPENCODEX_HOME: home },
        encoding: "utf8",
        timeout: 1_000,
      });

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({ status: "ineligible" });
    });
  });
});
