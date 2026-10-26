import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

async function runStop(options: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "ocx-link-stop-"));
  const home = join(root, "ocx");
  const child = Bun.spawn([process.execPath, fixturePath("client-link-stop-runner.ts")], {
    cwd: repoPath(), stdin: new Blob([JSON.stringify(options)]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: join(root, "codex"), OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0" },
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (options.expectedFailure || options.expectedRefusal) {
      expect(exit, stdout).toBe(options.expectedFailure ? 1 : 0);
      expect(stderr).toContain("Link Child Codex routing restore refused");
    } else expect({ exit, stderr }, stdout).toEqual({ exit: 0, stderr: "" });
    return JSON.parse(readFileSync(join(home, "result.json"), "utf8"));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill(); await child.exited; }
    removeTreeWithRetry(root);
  }
}

for (const signal of process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`native Link ${signal} restores its owned Codex routing before listener release`, async () => {
    const report = await runStop({ mode: "runtime", signal });
    expect(report.result).toEqual({ atListenerStop: true });
    expect(report.after).toBe('model = "native"\n');
    expect(report.profileAfter).toBeNull();
    expect(report.journalRetained).toBe(false);
    expect(report.protectedUnchanged).toBe(true);
  }, 20_000);
}

test("native hub signal exit preserves the connection-owned route", async () => {
  const report = await runStop({ mode: "runtime", transport: "hub" });
  expect(report.after).toBe(report.before);
  expect(report.profileAfter).toBe(report.profileBefore);
  expect(report.journalRetained).toBe(true);
  expect(report.protectedUnchanged).toBe(true);
}, 20_000);

test("native Link signal refuses a connection swapped after runtime publication", async () => {
  const report = await runStop({ mode: "runtime", mutation: "connection", expectedFailure: true });
  expect(report.result).toEqual({ atListenerStop: true });
  expect(report.after).toBe(report.before);
  expect(report.profileAfter).toBe(report.profileBefore);
  expect(report.journalRetained).toBe(true);
  expect(report.protectedUnchanged).toBe(true);
}, 20_000);

test("owned Link routing restore is idempotent and retains the connection's remaining artifacts", async () => {
  const report = await runStop({ mode: "helper", repeat: true });
  expect(report.result.first).toMatchObject({ success: true, restored: true });
  expect(report.result.repeated).toMatchObject({ success: true, restored: false });
  expect(report.after).toBe('model = "native"\n');
  expect(report.profileAfter).toBeNull();
  expect(report.journalRetained).toBe(false);
  expect(report.protectedUnchanged).toBe(true);
});

for (const mutation of ["connection", "selection", "journal", "process-journal", "unverified"]) {
  test(`Link restore refuses ${mutation} evidence without touching its files`, async () => {
    const report = await runStop({ mode: "helper", mutation });
    expect(report.result).toMatchObject({ success: false, restored: false });
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.protectedUnchanged).toBe(true);
  });
}

for (const mutation of ["config", "profile"]) {
  test(`Link restore preserves an edited ${mutation} and reports the incomplete pair`, async () => {
    const report = await runStop({ mode: "helper", mutation });
    expect(report.result.success).toBe(false);
    if (mutation === "config") expect(report.after).toBe(report.before);
    else expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.protectedUnchanged).toBe(true);
  });
}

for (const mutation of ["oversized", "nonregular"]) {
  test(`missing Link journal cannot make an ${mutation} config a successful no-op`, async () => {
    const report = await runStop({ mode: "helper", mutation });
    expect(report.result).toMatchObject({ success: false, restored: false });
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.protectedUnchanged).toBe(true);
  });
}

test("Link API teardown restores the owned journal before an accepted parent deferral", async () => {
  const report = await runStop({ mode: "api" });
  expect(report.result).toMatchObject({ success: true, sharedTeardown: "performed" });
  expect(report.result.message).toContain("ocx sync --restart-codex");
  expect(report.after).toBe('model = "native"\n');
  expect(report.profileAfter).toBeNull();
  expect(report.journalRetained).toBe(false);
  expect(report.protectedUnchanged).toBe(true);
});

test("parent Link teardown restores only its connection-owned journal", async () => {
  const report = await runStop({ mode: "parent" });
  expect(report.result).toEqual({ historyOnly: false, historyDeferred: false, other: false });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.protectedUnchanged).toBe(true);
});

test("parent Link teardown refuses the connection that replaced its stopped target", async () => {
  const report = await runStop({ mode: "parent", mutation: "connection", expectedRefusal: true });
  expect(report.result).toEqual({ historyOnly: false, historyDeferred: false, other: true });
  expect(report.after).toBe(report.before);
  expect(report.profileAfter).toBe(report.profileBefore);
  expect(report.journalRetained).toBe(true);
  expect(report.protectedUnchanged).toBe(true);
});
