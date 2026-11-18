import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
for (const detail of ["unbound", "bound", "absent", "invalid"]) test(`native workflow detail: ${detail}`, async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-workflow-sse-"));
  try {
    mkdirSync(join(home, "ocx")); mkdirSync(join(home, "codex"));
    const child = Bun.spawn([process.execPath, helperPath("messages-sse-workflow-case.ts"), detail], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").find(line => line.startsWith("WORKFLOW "))!.slice(9));
    expect(result.hookHits).toBeGreaterThan(0);
    expect(result.filterChecks).toEqual({ forward: true, backward: true });
    expect(result.status).toBe(429); expect(result.sends).toBe(0);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).not.toContain("987654321");
    if (detail === "unbound") expect(result.text).toContain("unassigned provider-pool history");
    else if (detail === "bound") expect(result.text).toContain("Review the task, account and pool spending limits");
    expect(result.code).toBe("workflow_spend_exhausted");
    expect(result.header).toBe("workflow_spend_exhausted");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, SPAWN_BUDGET_MS);
