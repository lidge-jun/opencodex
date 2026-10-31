import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
    if (options.osSignal) {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(home, "ready")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      if (!existsSync(join(home, "ready"))) throw new Error("fixture did not publish its signal-ready listener");
      child.kill("SIGTERM");
    }
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (options.expectedFailure || options.expectedRefusal) {
      expect(exit, stdout).toBe(options.expectedFailure ? 1 : 0);
      expect(stderr).toContain("Link Child Codex routing restore refused");
    } else if (String(options.preserve).startsWith("restart-rollback")) {
      expect(exit, stdout).toBe(0);
      expect(stderr.trim()).toBe("[client] restart: the replacement did not start (not_ready); this runtime keeps serving");
    } else expect({ exit, stderr }, stdout).toEqual({ exit: 0, stderr: "" });
    const report = JSON.parse(readFileSync(join(home, "result.json"), "utf8"));
    const atExit = JSON.parse(readFileSync(join(home, "exit.json"), "utf8"));
    for (const field of ["after", "profileAfter", "journalRetained", "journalHomeBound", "catalogAfter", "grokAfter", "protectedUnchanged"]) {
      expect(atExit[field], `no late restoration after listener release: ${field}`).toEqual(report[field]);
    }
    return report;
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
    expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
    expect(report.grokAfter).toBe('theme = "fixture"\n');
  }, 20_000);
}

test.skipIf(process.platform === "win32")("a real POSIX SIGTERM restores after catalog sync before listener release", async () => {
  const report = await runStop({ mode: "runtime", osSignal: true, syncBeforeStop: true });
  expect(report.syncEvidence).toEqual({ changedFields: ["catalogFingerprint", "catalogSyncedAt"], fullCasRefused: true, catalogWritten: true, injected: true, journalHomeBound: true });
  expect(report.after).toBe('model = "native"\n');
  expect(report.profileAfter).toBeNull();
  expect(report.journalHomeBound).toBe(false);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);

test("native Link signal restores after real catalog sync without weakening the full snapshot CAS", async () => {
  const report = await runStop({ mode: "runtime", syncBeforeStop: true });
  expect(report.syncEvidence).toEqual({ changedFields: ["catalogFingerprint", "catalogSyncedAt"], fullCasRefused: true, catalogWritten: true, injected: true, journalHomeBound: true });
  expect(report.after).toBe('model = "native"\n');
  expect(report.profileAfter).toBeNull();
  // Reinjection preserves the first hash: field-level restore retains its recovery
  // snapshot but releases the home binding, rather than deleting recovery evidence.
  expect(report.journalRetained).toBe(true);
  expect(report.journalHomeBound).toBe(false);
  expect(report.protectedUnchanged).toBe(true);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);

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

test("owned Link full restore is idempotent and retains connection credentials", async () => {
  const report = await runStop({ mode: "helper", repeat: true });
  expect(report.result.first).toMatchObject({ success: true, restored: true });
  expect(report.result.repeated).toMatchObject({ success: true, restored: false });
  expect(report.after).toBe('model = "native"\n');
  expect(report.profileAfter).toBeNull();
  expect(report.journalRetained).toBe(false);
  expect(report.protectedUnchanged).toBe(true);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
});

for (const mutation of ["connection", "selection", "journal", "process-journal", "unverified", "rotation", "hub"]) {
  test(`Link restore refuses ${mutation} evidence without touching its files`, async () => {
    const report = await runStop({ mode: "helper", mutation });
    expect(report.result).toMatchObject({ success: false, restored: false });
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.protectedUnchanged).toBe(true);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
  });
}

for (const mutation of ["config", "profile"]) {
  test(`Link full restore preserves user edits in ${mutation} while removing owned routing`, async () => {
    const report = await runStop({ mode: "helper", mutation });
    expect(report.result.success).toBe(true);
    if (mutation === "config") expect(report.after).toContain('approval_policy = "on-request"');
    else expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.after).not.toContain("openai_base_url");
    expect(report.protectedUnchanged).toBe(true);
    expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
    expect(report.grokAfter).toBe('theme = "fixture"\n');
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

test("Link API teardown preserves the merged parent deferral contract", async () => {
  const report = await runStop({ mode: "api" });
  expect(report.result).toMatchObject({ success: true, sharedTeardown: "deferred" });
  expect(report.after).toBe(report.before);
  expect(report.profileAfter).toBe(report.profileBefore);
  expect(report.journalRetained).toBe(true);
  expect(report.protectedUnchanged).toBe(true);
});

test("parent Link teardown retains the merged full restoration contract", async () => {
  const report = await runStop({ mode: "parent" });
  expect(report.result).toEqual({ historyOnly: false, historyDeferred: false, other: false });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.protectedUnchanged).toBe(true);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
});

for (const preserve of ["service", "desktop", "receipt", "sibling"]) {
  test(`native Link signal preserves ${preserve} restoration ownership`, async () => {
    const report = await runStop({ mode: "runtime", preserve });
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.protectedUnchanged).toBe(true);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
  }, 20_000);
}

test("a pending restart admission cannot leave routing behind on signal shutdown", async () => {
  const report = await runStop({ mode: "runtime", preserve: "restart" });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);

test.each(["restart-rollback", "restart-rollback-recycle"])("signal shutdown joins %s before restoring", async preserve => {
  const report = await runStop({ mode: "runtime", preserve });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);

test("a scheduled recycle cannot skip restoration or spawn after signal shutdown", async () => {
  const report = await runStop({ mode: "runtime", preserve: "recycle-pending" });
  expect(report.after).toBe('model = "native"\n');
  expect(report.journalRetained).toBe(false);
  expect(report.catalogAfter.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
  expect(report.grokAfter).toBe('theme = "fixture"\n');
}, 20_000);

for (const mutation of ["connection", "selection", "rotation", "hub", "prior-catalog", "api-key", "token", "management", "link-id"]) {
  test(`served-connection guard rechecks ${mutation} at each write and freezes its snapshot`, async () => {
    const report = await runStop({ mode: "guard", mutation });
    expect(report.result).toEqual({ writes: ["before-change"], refused: true, boundary: mutation === "hub" ? "hub-owned" : "unproven" });
    expect(report.after).toBe(report.before);
    expect(report.journalRetained).toBe(true);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
  });
}

test("served-connection guard permits catalog sync metadata at a later write", async () => {
  const report = await runStop({ mode: "guard", mutation: "catalog" });
  expect(report.result).toEqual({ writes: ["before-change", "after-change"], refused: false, boundary: "restore" });
});
