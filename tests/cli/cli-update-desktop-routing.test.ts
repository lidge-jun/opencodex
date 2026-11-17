import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

// Windows validation (#8246): `update --desktop --json` was routed to the orchestrated updater's
// grammar because --json alone selects it, so the headless updater never ran in JSON mode.
test("update --desktop reaches the headless updater with and without --json", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-desktop-route-"));
  try {
    for (const args of [["update", "--desktop", "--json"], ["update", "--desktop", "--check", "--json"], ["update", "--desktop"]]) {
      const result = spawnSync(process.execPath, [repoPath("src/cli/index.ts"), ...args], {
        encoding: "utf8", timeout: 60_000,
        env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex"), OCX_NO_UPDATE_CHECK: "1" },
      });
      // Off a Windows Desktop installation the headless updater refuses with its own message.
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("must be run with that installation's ocx.exe");
      expect(result.stdout).not.toContain('"error":"usage"');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
