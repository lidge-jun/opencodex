import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixturePath, repoPath } from "./repo-root";
import { removeTreeWithRetry } from "./remove-tree";
import { stopFixtureEnv } from "./client-stop-fixture-home";

export async function runStop(options: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "ocx-link-stop-"));
  const home = join(root, "ocx");
  const env = stopFixtureEnv(root);
  let owner: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  let child: Bun.Subprocess<Blob, "pipe", "pipe"> | undefined;
  const timeout = setTimeout(() => {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (owner?.exitCode === null) owner.kill("SIGKILL");
  }, 15_000);
  try {
    const receiptState = options.receiptState;
    if (options.preserve === "receipt" && typeof receiptState === "string" && receiptState.startsWith("parent")) {
      // Own the inert stop process here so a killed runtime cannot orphan it. EOF
      // also releases it if the test process itself is killed by the batch watchdog.
      const path = join(home, process.platform === "linux" || receiptState === "parent-spaced"
        ? "fixture owner" : "fixture-owner", "src", "cli", "index.ts");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'console.log("ready"); await Bun.stdin.text();');
      const verb = receiptState === "parent-start" ? "start" : receiptState === "parent-status" ? "status" : "stop";
      owner = Bun.spawn([process.execPath, path, `--ocx-internal-launch-proof=${"a".repeat(43)}`, verb, "--json"],
        { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      const reader = owner.stdout.getReader();
      try {
        const ready = await reader.read();
        if (ready.done) throw new Error("fixture owner did not start");
      } finally {
        reader.releaseLock();
      }
    }
    child = Bun.spawn([process.execPath, fixturePath("client-link-stop-runner.ts")], {
      cwd: repoPath(), stdin: new Blob([JSON.stringify({ ...options, receiptOwnerPid: owner?.pid })]),
      stdout: "pipe", stderr: "pipe", env,
    });
    if (options.osSignal) {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(home, "ready")) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      if (!existsSync(join(home, "ready"))) throw new Error("fixture did not publish its signal-ready listener");
      child.kill("SIGTERM");
    }
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (options.expectedUnsupportedStop) {
      expect(exit, stdout).toBe(1);
      expect(stderr).toContain("Connected-client stop refused");
      expect(stderr).toContain("update/restart");
      if (options.expectLegacyRecovery) {
        expect(stderr).toMatch(/close.*clients.*old.*ocx stop.*current.*ocx stop.*ocx start.*ocx sync --restart-codex/is);
      }
    } else if (options.expectedUnownedFileRecovery) {
      expect(exit, stdout).toBe(0);
      expect(stderr).toContain("Link Child file routing restore failed");
    } else if (options.receiptWriteFails) {
      expect(exit, stdout).toBe(1);
      expect(stderr).toContain("fixture receipt write denied");
    } else if (options.mode === "offline-stop") {
      expect(exit, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ runtimeDown: true, sharedTeardown: "restored" });
    } else if (options.expectedNativePreflightRefusal) {
      expect(exit, stdout).toBe(1);
      expect(stderr).toContain("Link Child native teardown preflight refused");
      expect(stderr).toContain("No process was stopped");
    } else if (options.expectedFileRefusal || options.repairFileRefusal) {
      expect(exit, stdout).toBe(options.mode === "file-stop" ? 1 : 0);
      expect(stderr).toContain("Link Child file routing restore refused");
      expect(stderr).toContain("retry ocx stop");
    } else if (options.expectedFailure || options.expectedRefusal) {
      expect(exit, stdout).toBe(options.expectedFailure ? 1 : 0);
      expect(stderr).toContain("Link Child Codex routing restore refused");
    } else if (String(options.preserve).startsWith("restart-rollback")) {
      expect(exit, stdout).toBe(0);
      expect(stderr.trim()).toBe("[client] restart: the replacement did not start (not_ready); this runtime keeps serving");
    } else expect({ exit, stderr }, stdout).toEqual({ exit: 0, stderr: "" });
    const report = JSON.parse(readFileSync(join(home, "result.json"), "utf8"));
    const atExit = JSON.parse(readFileSync(join(home, "exit.json"), "utf8"));
    expect(atExit.codexDiscovery).toBe(false);
    for (const field of ["after", "profileAfter", "journalRetained", "journalHomeBound", "catalogAfter", "grokAfter", "protectedUnchanged", "fileAfter", "codexDiscovery"]) {
      expect(atExit[field], `no late restoration after listener release: ${field}`).toEqual(report[field]);
    }
    return { ...report, fileLateResult: atExit.fileLateResult };
  } finally {
    clearTimeout(timeout);
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (owner?.exitCode === null) owner.kill("SIGKILL");
    await Promise.all([child?.exited, owner?.exited]);
    removeTreeWithRetry(root);
  }
}
