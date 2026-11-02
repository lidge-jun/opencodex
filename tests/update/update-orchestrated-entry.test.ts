import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { assertNotRealHomeUnderTest } from "../../src/lib/test-home-guard";

test("a source checkout update plan emits one JSON refusal in a temporary home", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-update-entry-"));
  const home = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(home); mkdirSync(codex); assertNotRealHomeUnderTest(home);
  const proc = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "update", "--plan", "--json"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
      CODEX_SQLITE_HOME: codex, CLAUDE_CONFIG_DIR: join(root, "claude"), OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_TEST_HOME_GUARD: "1" },
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ schema: "ocx.update.plan/1", installer: "source", canApply: false, reason: "source-checkout", updateInFlight: false });
    expect(stderr).not.toContain("shim repair");
    writeFileSync(join(home, "update-orchestrated.json"), JSON.stringify({ pid: process.pid, phase: "mutating", startedAt: Date.now() }));
    const active = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "update", "--plan", "--json"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
        CODEX_SQLITE_HOME: codex, CLAUDE_CONFIG_DIR: join(root, "claude"), OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_TEST_HOME_GUARD: "1" },
    });
    const [activeOutput, activeError, activeCode] = await Promise.all([new Response(active.stdout).text(), new Response(active.stderr).text(), active.exited]);
    expect(activeCode).toBe(0);
    expect(activeError).not.toContain("shim repair");
    expect(JSON.parse(activeOutput).updateInFlight).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("the Node launcher classifies orchestration before package-manager update and boot recovery", () => {
  const source = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
  const classification = source.indexOf("const orchestratedUpdate =");
  expect(classification).toBeGreaterThan(-1);
  expect(classification).toBeLessThan(source.indexOf('process.argv[2] === "update" && installMethod === "mise"'));
  expect(classification).toBeLessThan(source.indexOf('const probe = bootRestoreProbe('));
});

test("malformed orchestrated update with help is rejected before the human help shortcut", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-update-help-"));
  const home = join(root, "ocx"), codex = join(root, "codex");
  mkdirSync(home); mkdirSync(codex); assertNotRealHomeUnderTest(home);
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required to test the published launcher");
  try {
    for (const [executable, entry] of [[node, repoPath("bin/ocx.mjs")], [process.execPath, repoPath("src/cli/index.ts")]]) {
    const proc = Bun.spawn([executable!, entry!, "update", "--plan", "--json", "--help"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
        OCX_REAL_HOME: process.env.OCX_REAL_HOME ?? homedir(), OCX_TEST_HOME_GUARD: "1" },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(64);
    expect(JSON.parse(stdout)).toEqual({ error: "usage" });
    expect(stderr).toContain("Usage:");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
