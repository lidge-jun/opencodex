import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

for (const retryError of ["busy", "locked", "exhausted", "permission", "unwrapped", "identity"]) {
  test(`signal sync fencing bounds and classifies ${retryError} retries`, async () => {
    const report = await runStop({ mode: "retry", retryError });
    const succeeds = retryError === "busy" || retryError === "locked";
    expect(report.result).toEqual({ success: succeeds, attempts: succeeds ? 3 : retryError === "exhausted" ? 20 : 1,
      waits: Array(succeeds ? 2 : retryError === "exhausted" ? 19 : 0).fill(50) });
    expect(report.after).toBe(report.before);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
  });
}

for (const runtimeRecord of ["absent", "invalid", "foreign"]) {
  test(`signal refuses restoration when its runtime record is ${runtimeRecord}`, async () => {
    const report = await runStop({ mode: "runtime", runtimeRecord, expectedFailure: true });
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
    expect(report.protectedUnchanged).toBe(true);
  }, 20_000);
}

for (const preserve of ["service", "desktop", "receipt", "sibling"]) {
  test(`${preserve} signal preservation does not require a restoration sync fence`, async () => {
    const report = await runStop({ mode: "runtime", preserve, runtimeRecord: "absent" });
    expect(report.after).toBe(report.before);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
  }, 20_000);
}

for (const { releaseFirst, hold } of [{ releaseFirst: false, hold: "catalog" }, { releaseFirst: false, hold: "home" }, { releaseFirst: true, hold: "catalog" }, { releaseFirst: false, hold: "lock" }] as const) {
  test(`a separate sync ${releaseFirst ? "finishes before" : "cannot commit after"} signal restoration (${hold})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-link-sync-stop-"));
    const home = join(root, "ocx"), codex = join(root, "codex");
    const children: Array<{ child: ReturnType<typeof Bun.spawn>; drained: Promise<unknown> }> = [];
    const spawn = (file: string, options: unknown) => {
      const child = Bun.spawn([process.execPath, fixturePath(file)], {
        cwd: repoPath(), stdin: new Blob([JSON.stringify(options)]), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex, OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0" },
      });
      const drained = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      children.push({ child, drained });
      return child;
    };
    const waitFor = async (name: string) => {
      const end = Date.now() + 15_000;
      while (!existsSync(join(home, name)) && Date.now() < end) await Bun.sleep(10);
      if (!existsSync(join(home, name))) throw new Error(`fixture did not publish ${name}`);
    };
    const release = (name: string) => writeFileSync(join(home, name), "ready");
    const read = (name: string) => JSON.parse(readFileSync(join(home, name), "utf8"));
    const durable = () => ({
      config: readFileSync(join(codex, "config.toml"), "utf8"),
      catalog: JSON.parse(readFileSync(join(codex, "opencodex-catalog.json"), "utf8")),
      profile: existsSync(join(codex, "opencodex.config.toml")),
      connection: readFileSync(join(home, "config.json"), "utf8"),
      token: readFileSync(join(home, "service-api-token"), "utf8"),
    });
    const timer = setTimeout(() => { for (const { child } of children) if (child.exitCode === null) child.kill(); }, 35_000);
    try {
      const runtime = spawn("client-link-stop-runner.ts", { mode: "runtime", externalSignal: true, holdShutdown: true });
      await waitFor("ready");
      const held = spawn("client-link-sync-runner.ts", { hold, name: "held" });
      await waitFor("held-requested");
      if (releaseFirst) {
        release("catalog-release");
        expect(await held.exited).toBe(0);
        expect(read("held-sync-result.json")).toMatchObject({ ok: true, catalogWritten: true, injected: true });
        expect(durable().config).toContain("openai_base_url");
        expect(durable().catalog.models).toEqual([{ slug: "fixture/late-sync" }]);
      }
      release("signal-now");
      if (hold === "lock") {
        // Both immediate attempts see a real competing C transaction. Yielding lets it finish.
        await Bun.sleep(150);
        release("catalog-release");
      }
      await waitFor("shutdown-drained");
      const restored = durable();
      expect(restored.config).toBe('model = "native"\n');
      expect(restored.profile).toBe(false);
      expect(restored.catalog.models).toEqual([{ slug: "fixture-native", visibility: "list" }]);
      if (releaseFirst) {
        // No apply lock is held now: a fresh sync must be refused by shutdown admission.
        const fresh = spawn("client-link-sync-runner.ts", { hold: false, name: "fresh" });
        expect(await fresh.exited).toBe(0);
        expect(read("fresh-sync-result.json")).toMatchObject({ ok: false, fetched: false });
        expect(durable()).toEqual(restored);
      }
      release("shutdown-release");
      expect(await runtime.exited).toBe(0);
      if (!releaseFirst) {
        release("catalog-release");
        expect(await held.exited).toBe(0);
        expect(read("held-sync-result.json")).toMatchObject(hold === "lock" ? { ok: true, lockHeld: true } : { ok: false, fetched: true });
      }
      // Read after BOTH processes exit; the runtime's own exit snapshot cannot prove this.
      expect(durable()).toEqual(restored);
      if (releaseFirst) {
        // A new explicit offline sync after complete shutdown remains supported.
        const offline = spawn("client-link-sync-runner.ts", { hold: false, name: "fresh" });
        expect(await offline.exited).toBe(0);
        expect(read("fresh-sync-result.json")).toMatchObject({ ok: true, fetched: true, injected: true });
      }
    } finally {
      clearTimeout(timer);
      for (const { child } of children) { if (child.exitCode === null) child.kill(); await child.exited; }
      await Promise.all(children.map(value => value.drained));
      removeTreeWithRetry(root);
    }
  }, 40_000);
}
