import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { helperPath, repoRoot } from "../helpers/repo-root";

test.each(["terminal", "unknown", "recovery", "arming", "unsafe-stage", "unsafe-install", "rename-install", "rename-stage"])("apply %s enforces mutation admission and lifetime", async lane => {
  const child = spawn(process.execPath, [helperPath("codex-cli-apply-admission.ts"), lane], {
    cwd: repoRoot(), env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes.toString(); });
  child.stderr.on("data", bytes => { output += bytes.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  expect({ code, output }).toMatchObject({ code: 0 });
  expect(output).toContain("admission lifecycle verified");
});
