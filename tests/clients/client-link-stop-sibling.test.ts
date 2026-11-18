import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixturePath, repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { runStop } from "../helpers/client-link-stop";
import { isClientStopArgv, isClientStopCommandLine, observeClientStopOwner, readClientStopProcessStart } from "../../src/client/stop-teardown-owner";

test("Linux Link forced stop refuses an unavailable pidfd without sending a numeric signal", async () => {
  const report = await runStop({ mode: "termination", terminationPlatform: "linux" });
  expect(report.result).toMatchObject({ signals: [], message: expect.stringContaining("pidfd") });
}, 20_000);

test.each(["stopping", "different-generation"] as const)("Linux Link sibling escalation after TERM with %s", async siblingEscalation => {
  const { result } = await runStop({ mode: "runtime", preserve: "sibling", siblingEscalation });
  expect(result).toEqual({
    signals: siblingEscalation === "stopping" ? [[73, 15], [73, 9]] : [[73, 15]],
    openedExactlyOnceForTarget: true, closed: [73], stopping: true,
    ...(siblingEscalation === "different-generation" ? { refusal: expect.stringContaining("Connected-client stop refused") } : {}),
  });
}, 20_000);

test("macOS Link stop sends only an orderly signal when the attested Child remains live", async () => {
  const report = await runStop({ mode: "termination", terminationPlatform: "darwin" });
  expect(report.result).toMatchObject({ signals: ["SIGTERM"], message: expect.stringContaining("foreground terminal") });
}, 20_000);

for (const stopConnectionDrift of ["invalid", "mismatched", "disconnected", "other-link", "hub"]) {
  test(`ocx stop refuses a live Link Child with ${stopConnectionDrift} saved ownership`, async () => {
    const report = await runStop({ mode: "file-stop", fileClients: ["pi"], stopConnectionDrift, expectedUnsupportedStop: true });
    expect(report.result).toEqual({ exitCode: 1, calls: { service: 0, killed: 0 }, bound: true, stopping: false });
    expect(report.fileAfter).toEqual(report.fileOwnedBytes);
  }, 20_000);
}

for (const missingStopRecord of ["absent", "invalid"]) {
  test(`ocx stop retains a live tracked Child with a disconnected saved state and ${missingStopRecord} runtime record`, async () => {
    const report = await runStop({ mode: "file-stop", fileClients: ["pi"], stopConnectionDrift: "disconnected",
      missingStopRecord, expectedUnsupportedStop: true });
    expect(report.result).toEqual({ exitCode: 1, calls: { service: 0, killed: 0 }, bound: true, stopping: false });
    expect(report.fileAfter).toEqual(report.fileOwnedBytes);
  }, 20_000);
}

test("ocx stop refuses a new process incarnation after an unanswered Link stop", async () => {
  const report = await runStop({ mode: "file-stop", fileClients: ["pi"], startIdentityChanges: "request", expectedUnsupportedStop: true });
  expect(report.result).toEqual({ exitCode: 1, calls: { service: 1, killed: 0 }, bound: true, stopping: true });
  expect(report.fileAfter.pi).not.toContain("127.0.0.1");
}, 20_000);

test.skipIf(process.platform === "win32")("ocx stop refuses escalation when the Child incarnation changes after SIGTERM", async () => {
  const report = await runStop({ mode: "file-stop", fileClients: ["pi"], startIdentityChanges: "escalation", expectedUnsupportedStop: true });
  expect(report.result).toEqual({ exitCode: 1, calls: { service: 1, killed: 1 }, bound: true, stopping: true });
  expect(report.fileAfter.pi).not.toContain("127.0.0.1");
}, 20_000);

test("ocx stop rechecks Link ownership before forced fallback after an unanswered stop", async () => {
  const report = await runStop({ mode: "file-stop", fileClients: ["pi"], driftDuringFallback: true, expectedUnsupportedStop: true });
  expect(report.result).toEqual({ exitCode: 1, calls: { service: 1, killed: 0 }, bound: true, stopping: true });
  expect(report.fileAfter.pi).not.toContain("127.0.0.1");
}, 20_000);

test("the legacy Link refusal gives a connection-preserving recovery in execution order", async () => {
  const report = await runStop({ mode: "file-stop", fileClients: ["pi"], oldStopCapability: true,
    legacyOwnerRecord: true, expectedUnsupportedStop: true, expectLegacyRecovery: true });
  expect(report.result).toEqual({ exitCode: 1, calls: { service: 0, killed: 0 }, bound: true, stopping: false });
  expect(report.fileAfter).toEqual(report.fileOwnedBytes);
}, 20_000);

test("an older native Child cannot be treated as Hub-owned from saved config alone", async () => {
  const report = await runStop({ mode: "file-stop", fileClients: ["pi"], oldStopCapability: true,
    legacyOwnerRecord: true, stopConnectionDrift: "hub", expectedUnsupportedStop: true });
  expect(report.result).toEqual({ exitCode: 1, calls: { service: 0, killed: 0 }, bound: true, stopping: false });
  expect(report.fileAfter).toEqual(report.fileOwnedBytes);
}, 20_000);

for (const preserve of ["service", "desktop", "sibling"]) {
  test(`native Link signal preserves ${preserve} restoration ownership`, async () => {
    const report = await runStop({ mode: "runtime", preserve, fileClients: ["pi"] });
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.protectedUnchanged).toBe(true);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
    expect(report.fileAfter).toEqual(report.fileOwnedBytes);
  }, 20_000);
}

for (const receiptState of ["live", "abandoned", "quarantined", "invalid", "parent-invalid", "parent-start", "parent-status", "parent-unfenced", "parent-finished", "parent-port", "parent-host", "parent-guessed", "parent-oversized", "parent-nonregular", "parent-reused", "parent-wrong-nonce", ...(process.platform === "win32" ? [] : ["parent-symlink"])]) {
  test(`an unverified native teardown (${receiptState}) cleans files but retains its listener`, async () => {
    const report = await runStop({ mode: "runtime", preserve: "receipt", receiptState, fileClients: ["pi"],
      observeNativeRefusal: true, expectedRefusal: true });
    expect(report.result).toEqual({ refused: true, bound: true, stopping: true });
    expect(report.fileAfter.pi).not.toContain("127.0.0.1");
    expect(JSON.parse(report.fileAfter.pi)).toMatchObject({ fixtureUserSetting: "keep" });
    expect(report.teardownOutstanding).toBe(true);
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
    expect(report.protectedUnchanged).toBe(true);
  }, 20_000);
}

for (const receiptState of ["invalid", "abandoned-guessed", "abandoned-other", "abandoned-unknown"]) {
  test(`ocx stop refuses inherited native teardown (${receiptState}) before service or process termination`, async () => {
    const report = await runStop({ mode: "file-stop", preserve: "receipt", receiptState, fileClients: ["pi"], expectedNativePreflightRefusal: true });
    expect(report.result).toEqual({ exitCode: 1, calls: { service: 0, killed: 0 }, bound: true, stopping: false });
    expect(report.fileAfter).toEqual(report.fileOwnedBytes);
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.teardownOutstanding).toBe(true);
    expect(report.grokAfter).toBe(report.grokBefore);
  }, 20_000);
}

for (const receiptState of ["abandoned", "abandoned-dead-other", "quarantined"]) {
  test(`native recovery preflight keeps the supported ${receiptState} parent stop`, async () => {
    const report = await runStop({ mode: "file-preflight", preserve: "receipt", receiptState, fileClients: ["pi"] });
    expect(report.result).toEqual({ outcome: null, bound: true, stopping: true });
    expect(report.fileAfter.pi).not.toContain("127.0.0.1");
    expect(report.teardownOutstanding).toBe(true);
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.protectedUnchanged).toBe(true);
  }, 20_000);
}

test("ocx stop refuses a native Link sibling whose published owner differs from the saved Link", async () => {
  const report = await runStop({ mode: "file-stop", preserve: "sibling", fileClients: ["pi"],
    stopConnectionDrift: "other-link", expectedUnsupportedStop: true });
  expect(report.result).toEqual({ exitCode: 1, calls: { service: 0, killed: 0 }, bound: true, stopping: false });
  expect(report.fileAfter).toEqual(report.fileOwnedBytes);
}, 20_000);

test.skipIf(process.platform === "win32")("ocx stop stops an attested native Link sibling without touching shared routing", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-link-sibling-stop-")));
  const home = join(root, "ocx");
  const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: join(root, "codex"),
    OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0", PI_CODING_AGENT_DIR: join(root, ".pi", "agent") };
  const child = Bun.spawn([process.execPath, fixturePath("client-link-stop-runner.ts")], {
    cwd: repoPath(), env, stdout: "ignore", stderr: "pipe",
    stdin: new Blob([JSON.stringify({ mode: "runtime", osSignal: true, preserve: "sibling", fileClients: ["pi"] })]),
  });
  const childError = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(home, "ready")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(home, "ready"))).toBe(true);
    const runtime = JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8"));
    expect(runtime).toMatchObject({ pid: child.pid, siblingOfPort: 10100, clientLinkOwner: expect.any(String) });
    expect((await fetch(`http://127.0.0.1:${runtime.port}/healthz`)).ok).toBe(true);
    const cli = join(root, "stop.ts");
    const unexpected = join(root, "unexpected-stop-side-effects");
    const inheritedReceipt = join(home, `pending-teardown-${"a".repeat(32)}.json`);
    writeFileSync(inheritedReceipt, "{");
    writeFileSync(cli, `
      import { mock } from "bun:test";
      import { appendFileSync } from "node:fs";
      const lifecyclePath = ${JSON.stringify(repoPath("src/client/lifecycle-lock.ts"))};
      const lifecycle = await import(lifecyclePath);
      const deps = { lockPath: ${JSON.stringify(join(home, "lifecycle.sqlite"))} };
      mock.module(lifecyclePath, () => ({ ...lifecycle,
        withClientLifecycle: work => lifecycle.withClientLifecycle(work, deps),
        withClientLifecycleSync: work => lifecycle.withClientLifecycleSync(work, deps) }));
      for (const [path, name] of ${JSON.stringify([
        [repoPath("src/config/pending-teardown.ts"), "claimPendingTeardown"],
        [repoPath("src/service.ts"), "stopServiceIfInstalledDetailed"],
        [repoPath("src/server/system-env.ts"), "revertSystemEnv"],
      ])}) {
        const original = await import(path);
        mock.module(path, () => ({ ...original, [name]: () => {
          appendFileSync(${JSON.stringify(unexpected)}, name + "\\n");
          throw new Error(name);
        } }));
      }
      mock.module(${JSON.stringify(repoPath("src/cli/codex-shim-autorestore.ts"))}, () => ({ maybeAutoRestoreCodexShimAsync: async () => {} }));
      await import(${JSON.stringify(repoPath("src/cli/index.ts"))});
    `);
    const stop = await Bun.$`${process.execPath} ${cli} stop --json`.env(env).quiet().nothrow();
    expect(stop.exitCode, stop.stderr.toString()).toBe(0);
    expect(JSON.parse(stop.stdout.toString())).toMatchObject({ runtimeDown: true, service: "absent", sharedTeardown: "skipped" });
    expect(await child.exited, await childError).toBe(0);
    const atExit = JSON.parse(readFileSync(join(home, "exit.json"), "utf8"));
    expect(atExit).toMatchObject({ after: atExit.before, profileAfter: atExit.profileBefore, journalRetained: true,
      catalogAfter: JSON.parse(atExit.catalogBefore), grokAfter: atExit.grokBefore, fileAfter: atExit.fileOwnedBytes,
      protectedUnchanged: true, teardownOutstanding: true });
    expect(readFileSync(inheritedReceipt, "utf8")).toBe("{");
    expect(existsSync(unexpected)).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    removeTreeWithRetry(root);
  }
}, 20_000);

for (const changedReceipt of [false, true]) test.skipIf(process.platform !== "darwin")(
  changedReceipt ? "foreground CLI stop retains the listener if the older endpoint receipt changes after preflight"
    : "foreground CLI stop completes native handoff with a verified older endpoint receipt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-link-stop-handoff-")));
  const home = join(root, "ocx"), codex = join(root, "codex");
  const env = { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: home, CODEX_HOME: codex,
    OCX_SERVICE: "", OCX_SERVICE_MANAGED: "0", PI_CODING_AGENT_DIR: join(root, ".pi", "agent") };
  const cli = join(root, "src", "cli", "index.ts");
  mkdirSync(dirname(cli), { recursive: true });
  const child = Bun.spawn([process.execPath, fixturePath("client-link-stop-runner.ts")], {
    cwd: repoPath(), env, stdout: "ignore", stderr: "pipe",
    stdin: new Blob([JSON.stringify({ mode: "runtime", osSignal: true, preserve: "receipt", receiptState: "abandoned-dead-other", fileClients: ["pi"] })]),
  });
  const childError = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(home, "ready")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(home, "ready"))).toBe(true);
    const receipts = () => readdirSync(home).filter(name => name.includes("pending-teardown"));
    expect(receipts()).toHaveLength(1);
    const inheritedPath = join(home, receipts()[0]!);
    writeFileSync(cli, `
      import { mock } from "bun:test";
      import { appendFileSync } from "node:fs";
      const lifecyclePath = ${JSON.stringify(repoPath("src/client/lifecycle-lock.ts"))};
      const lifecycle = await import(lifecyclePath);
      const { withClientLifecycle, withClientLifecycleSync } = lifecycle;
      const deps = { lockPath: ${JSON.stringify(join(home, "lifecycle.sqlite"))} };
      mock.module(lifecyclePath, () => ({ ...lifecycle,
        withClientLifecycle: work => withClientLifecycle(work, deps),
        withClientLifecycleSync: work => withClientLifecycleSync(work, deps) }));
      const servicePath = ${JSON.stringify(repoPath("src/service.ts"))};
      const service = await import(servicePath);
      mock.module(servicePath, () => ({ ...service, stopServiceIfInstalledDetailed: () => {
        ${changedReceipt ? `appendFileSync(${JSON.stringify(inheritedPath)}, " ");` : ""}
        return "absent";
      } }));
      mock.module(${JSON.stringify(repoPath("src/cli/codex-shim-autorestore.ts"))}, () => ({ maybeAutoRestoreCodexShimAsync: async () => {} }));
      await import(${JSON.stringify(repoPath("src/cli/index.ts"))});
    `);
    const stop = await Bun.$`${process.execPath} ${cli} stop --json`.env(env).quiet().nothrow();
    if (changedReceipt) {
      expect(stop.exitCode, stop.stderr.toString()).toBe(1);
      expect(stop.stderr.toString()).toContain("Link Child did not exit after SIGTERM");
      const { port } = JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8"));
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);
      expect(receipts()).toHaveLength(2);
      return;
    }
    expect(stop.exitCode, stop.stderr.toString()).toBe(0);
    expect(JSON.parse(stop.stdout.toString())).toMatchObject({ runtimeDown: true, sharedTeardown: "restored" });
    expect(await child.exited, await childError).toBe(0);
    const atExit = JSON.parse(readFileSync(join(home, "exit.json"), "utf8"));
    expect(atExit.after).toBe(atExit.before);
    expect(atExit.fileAfter.pi).not.toContain("127.0.0.1");
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toBe('model = "native"\n');
    expect(receipts()).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    removeTreeWithRetry(root);
  }
}, 20_000);

for (const receiptState of ["parent", "parent-stale", "parent-spaced"]) {
  test(`an active native stop (${receiptState}) defers only native restoration after file cleanup`, async () => {
    const report = await runStop({ mode: "runtime", preserve: "receipt", receiptState, fileClients: ["pi"] });
    expect(report.result).toEqual({ atListenerStop: true });
    expect(report.fileAfter.pi).not.toContain("127.0.0.1");
    expect(JSON.parse(report.fileAfter.pi)).toMatchObject({ fixtureUserSetting: "keep" });
    expect(report.teardownOutstanding).toBe(true);
    expect(report.after).toBe(report.before);
    expect(report.profileAfter).toBe(report.profileBefore);
    expect(report.journalRetained).toBe(true);
    expect(report.catalogAfter).toEqual(JSON.parse(report.catalogBefore));
    expect(report.grokAfter).toBe(report.grokBefore);
    expect(report.protectedUnchanged).toBe(true);
  }, 20_000);
}

test("native teardown recognizes only supported stop invocations, including an updater's stop child", () => {
  expect(isClientStopArgv(["/opt/Program Files/ocx", "stop", "--json", "--expect-pid", "12", "--expect-port", "10100",
    "--expect-hostname", "127.0.0.1", "--expect-config-home", "/home/person with spaces/.opencodex", "--expect-cli-version", "1.0.0",
    "--expect-compatibility-token", "a".repeat(64)])).toBe(true);
  for (const command of ["/usr/local/bin/ocx stop", '"C:\\Program Files\\ocx.exe" stop --json', "bun src/cli.ts stop",
    "bun run /install/src/cli/index.ts stop --deadline-ms 5000 --json",
    `bun /npm/node_modules/@bitkyc08/opencodex/src/cli/index.ts --ocx-internal-launch-proof=${"a".repeat(43)} stop --json`]) {
    expect(isClientStopCommandLine(command), command).toBe(true);
  }
  for (const command of ["ocx start", "ocx status", "ocx update", "ocx update --plan", "ocx update --desktop --check", "ocx __gui-update-worker",
    "ocx stop --help", "ocx status stop", "node -e 'ocx stop'", "bun -e 'src/cli.ts stop'", "bun other.ts stop",
    "bun src/cli/index.ts --ocx-internal-launch-proof=invalid stop", "ocx stop --expect-pid 5", "ocx stop --deadline-ms 0"]) {
    expect(isClientStopCommandLine(command), command).toBe(false);
  }
});

test("stop owner with malformed creation identity or unrecognized invocation remains unverified", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'], { stdout: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    const startTime = readClientStopProcessStart(child.pid);
    expect(startTime).toBeDefined();
    const owner = { pid: child.pid, nonce: "a".repeat(32) };
    expect([
      observeClientStopOwner({ ...owner, startTime: "malformed" }),
      observeClientStopOwner({ ...owner, startTime: startTime! }),
    ]).toEqual(["unverified", "unverified"]);
  } finally {
    child.kill();
    await child.exited;
  }
}, 20_000);

test("an abandoned native teardown receipt cannot release a conflicting Link file route", async () => {
  const report = await runStop({ mode: "runtime", preserve: "receipt", receiptState: "abandoned",
    fileClients: ["pi"], fileConflict: true, observeFileRefusal: true, expectedFileRefusal: true });
  expect(report.result).toEqual({ refused: true, bound: true, stopping: true });
  expect(report.fileAfter.pi).toContain("operator-edited-placeholder");
  expect(report.fileAfter.pi).toContain("127.0.0.1");
  expect(report.teardownOutstanding).toBe(true);
  expect(report.after).toBe(report.before);
  expect(report.journalRetained).toBe(true);
}, 20_000);

test("a native teardown receipt cannot skip the Link signal sync fence", async () => {
  const report = await runStop({ mode: "runtime", preserve: "receipt", runtimeRecord: "absent",
    observeFileRefusal: true, expectedFileRefusal: true });
  expect(report.result).toEqual({ refused: true, bound: true, stopping: false });
  expect(report.teardownOutstanding).toBe(true);
  expect(report.after).toBe(report.before);
  expect(report.grokAfter).toBe(report.grokBefore);
}, 20_000);
