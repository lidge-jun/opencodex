import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodexCliUpdate, type CodexCliApplyDeps } from "../../src/codex/cli-update-apply";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { acquireCodexCliApplyLease } from "../../src/codex/cli-update-lease";
import { createCodexCliApplyFixture } from "../helpers/codex-cli-apply-fixture";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { codexCliPlatformBacking } from "../../src/codex/cli-install-provenance";
import { observeCodexCliFileSet, sameCodexCliFiles } from "../../src/codex/cli-update-files";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
const posix = process.platform !== "win32";
function fixture(targetNativeSource?: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-apply-private-")); roots.push(root);
  return createCodexCliApplyFixture(root, process.platform, process.arch, targetNativeSource);
}
function depsFor(f: ReturnType<typeof fixture>, overrides: Partial<CodexCliApplyDeps> = {}): CodexCliApplyDeps {
  return { platform: process.platform, temporaryRoot: f.temporaryRoot,
    inspectionDeps: { env: f.env, configDir: join(f.home, "ocx"), selectionAttested: true, selectedCommand: f.launcher },
    scanProcesses: () => ({ kind: "observed", processes: [] }),
    resolveTarget: () => ({ kind: "resolved", version: "1.1.0", integrity: f.target.artifacts.main.integrity, artifacts: f.target.artifacts }),
    fetchArtifact: async artifact => artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes,
    ...overrides };
}
async function approved(f: ReturnType<typeof fixture>, deps = depsFor(f)) {
  const plan = await createCodexCliUpdatePlan(deps);
  expect(plan.applicable).toBe(true); expect(plan.planId).toMatch(/^[0-9a-f]{32}$/);
  return plan.planId!;
}
function cli(f: ReturnType<typeof fixture>, args: string[]) {
  const result = spawnSync(Bun.which("node")!, [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", ...args, "--json"], {
    cwd: repoRoot(), encoding: "utf8", env: f.env, timeout: 60_000,
  });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
describe.skipIf(!posix)("Codex CLI private-prefix POSIX apply", () => {
  test("published Node launcher -> real resolver/provenance -> plan/apply -> verified new files", () => {
    const f = fixture();
    const plan = cli(f, ["plan"]);
    expect(plan.applicable).toBe(true); expect(plan.managed).toBe(true);
    expect(plan.targetArtifacts.backing.name).toBe("@openai/codex");
    const result = cli(f, ["apply", "--plan-id", plan.planId, "--yes"]);
    expect(result.outcome).toBe("applied"); expect(result.installedVersion).toBe("1.1.0");
    expect(result.leaseRetained).toBe(false);
    const after = cli(f, ["check"]); expect(after.managed).toBe(true); expect(after.packageVersion).toBe("1.1.0");
    const calls = readFileSync(f.trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--offline"); expect(calls[0]).toContain("--ignore-scripts");
    expect(calls[0]![calls[0]!.indexOf("--prefix") + 1]).toBe(f.prefix);
    expect(calls[0]!.filter(arg => arg.includes("@file:"))).toHaveLength(2);
    expect(calls[0]!.join(" ")).not.toContain("@latest");
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
  }, 120_000);
  test("published CLI packs and applies through a symlinked TMPDIR using canonical staging", () => {
    const f = fixture(); const alias = join(f.root, "tmp-alias");
    symlinkSync(f.temporaryRoot, alias, "dir"); f.env.TMPDIR = alias;
    const plan = cli(f, ["plan"]); expect(plan.applicable).toBe(true);
    const result = cli(f, ["apply", "--plan-id", plan.planId, "--yes"]);
    expect(result.outcome).toBe("applied"); expect(result.installedVersion).toBe("1.1.0");
    expect(result.leaseRetained).toBe(false);
    const calls = readFileSync(f.trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    const archives = calls[0]!.filter(arg => arg.includes("@file:")).map(arg => arg.split("@file:")[1]!);
    expect(archives).toHaveLength(2);
    for (const archive of archives) { expect(archive.startsWith(f.temporaryRoot + "/")).toBe(true); expect(archive.startsWith(alias + "/")).toBe(false); }
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);

  test.each(["stale-content", "same-version-integrity", "active", "unknown", "archive-tamper", "missing-backing"] as const)(
    "%s refuses before installer admission", async scenario => {
      const f = fixture(); let installs = 0;
      const deps = depsFor(f, { install: async () => { installs++; return { terminal: true, exitCode: 0 }; } });
      const id = await approved(f, deps);
      if (scenario === "stale-content") writeFileSync(join(f.prefix, "lib/node_modules/@openai/codex/bin/codex.js"), "#!/usr/bin/env node\n// changed bytes\n");
      const altered = { ...deps } as { -readonly [K in keyof CodexCliApplyDeps]: CodexCliApplyDeps[K] };
      if (scenario === "same-version-integrity") altered.resolveTarget = () => ({ kind: "resolved", version: "1.1.0", integrity: f.target.artifacts.main.integrity,
        artifacts: { ...f.target.artifacts, backing: { ...f.target.artifacts.backing, integrity: "sha512-" + Buffer.alloc(64, 8).toString("base64") } } });
      if (scenario === "active") altered.scanProcesses = () => ({ kind: "observed", processes: [{ pid: 1, command: "codex" }] } as never);
      if (scenario === "unknown") altered.scanProcesses = () => ({ kind: "unavailable" } as never);
      if (scenario === "archive-tamper") altered.fetchArtifact = async () => Buffer.from("invalid archive");
      if (scenario === "missing-backing") altered.fetchArtifact = async artifact => artifact.version === "1.1.0" ? f.target.main.bytes : f.target.main.bytes;
      const result = await applyCodexCliUpdate(id, altered);
      expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
      expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    }, 120_000,
  );
  test("a plan from a different prefix refuses without installing", async () => {
    const first = fixture(), second = fixture(); const id = await approved(first);
    let installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(second, { install: async () => { installs++; return { terminal: true, exitCode: 0 }; } }));
    expect(result.reason).toBe("plan_changed"); expect(installs).toBe(0);
  }, 120_000);
  test("content and selection are renewed after slow artifact preparation", async () => {
    const f = fixture(); let installs = 0;
    const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, {
      fetchArtifact: async artifact => {
        if (artifact.version !== "1.1.0") writeFileSync(join(f.prefix, "lib/node_modules/@openai/codex/bin/codex.js"), "#!/usr/bin/env node\n// changed during prepare\n");
        return artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes;
      }, install: async () => { installs++; return { terminal: true, exitCode: 0 }; },
    }));
    expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
  }, 120_000);
  test.each(["selection", "active", "unknown"] as const)("late %s change refuses after artifact preparation", async kind => {
    const f = fixture(); const id = await approved(f); let prepared = false, installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(f, {
      fetchArtifact: async artifact => {
        if (artifact.version !== "1.1.0") {
          prepared = true;
          if (kind === "selection") { unlinkSync(f.launcher); symlinkSync(f.target.main.path, f.launcher); }
        }
        return artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes;
      },
      scanProcesses: () => prepared && kind !== "selection"
        ? kind === "active" ? { kind: "observed", processes: [{ pid: 1, command: "codex" }] } as never : { kind: "unavailable" } as never
        : { kind: "observed", processes: [] },
      install: async () => { installs++; return { terminal: true, exitCode: 0 }; },
    }));
    expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
  }, 120_000);
  test("exit zero with original full files is not_applied", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async () => ({ terminal: true, exitCode: 0 }) }));
    expect(result.outcome).toBe("not_applied"); expect(result.installerExitCode).toBe(0);
  }, 120_000);
  test("a newly installed sibling backing with unchanged nested-old main is ambiguous", async () => {
    const f = fixture();
    const mainRoot = join(f.prefix, "lib", "node_modules", "@openai", "codex");
    const sibling = join(f.prefix, "lib", "node_modules", ...f.old.artifacts.backing.installName.split("/"));
    const nestedScope = join(mainRoot, "node_modules", "@openai"); mkdirSync(nestedScope, { recursive: true });
    renameSync(sibling, join(nestedScope, f.old.artifacts.backing.installName.split("/")[1]!));
    const before = readFileSync(join(mainRoot, "package.json"), "utf8");
    const originalFiles = observeCodexCliFileSet([mainRoot]);
    expect(existsSync(sibling)).toBe(false);
    const id = await approved(f); let installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      installs++;
      f.privateNpm(invocation.args.filter(arg => !arg.startsWith(f.target.artifacts.main.installName + "@file:")));
      return { terminal: true, exitCode: 17 };
    } }));
    expect(installs).toBe(1); expect(result.outcome).toBe("ambiguous");
    expect(result.reason).toBe("installation_readback_unverified"); expect(result.leaseRetained).toBe(false);
    expect(result.installedVersion).toBe("1.0.0");
    expect(sameCodexCliFiles(originalFiles, observeCodexCliFileSet([mainRoot]))).toBe(true);
    expect(readFileSync(join(mainRoot, "package.json"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(sibling, "package.json"), "utf8")).version).toBe(f.target.artifacts.backing.version);
  }, 120_000);
  test.each(["complete-nonzero", "missing-auxiliary", "changed-auxiliary", "main-only", "native-nonexecutable"] as const)(
    "%s is classified by complete readback, not installer exit", async scenario => {
      const f = fixture(); const id = await approved(f);
      const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
        const args = scenario === "main-only" ? invocation.args.filter(arg => !arg.startsWith(f.target.artifacts.backing.installName + "@file:")) : [...invocation.args];
        f.privateNpm([...args]);
        const auxiliary = join(f.prefix, "lib", "node_modules", ...f.target.artifacts.backing.installName.split("/"), "vendor/auxiliary.txt");
        if (scenario === "missing-auxiliary") rmSync(auxiliary);
        if (scenario === "changed-auxiliary") writeFileSync(auxiliary, "synthetic auxiliary CHANGED\n");
        if (scenario === "native-nonexecutable") chmodSync(join(f.prefix, "lib", "node_modules", ...f.target.artifacts.backing.installName.split("/"),
          "vendor", codexCliPlatformBacking(process.platform, process.arch)!.triple, "bin/codex"), 0o644);
        return { terminal: true, exitCode: scenario === "complete-nonzero" ? 17 : 0 };
      } }));
      expect(result.outcome).toBe(scenario === "complete-nonzero" ? "applied" : "ambiguous");
      expect(result.leaseRetained).toBe(false);
    }, 120_000,
  );
  test.skipIf(process.geteuid?.() === 0)("mode 0641 is not executable by the nonroot file owner", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      f.privateNpm([...invocation.args]);
      chmodSync(join(f.prefix, "lib", "node_modules", ...f.target.artifacts.backing.installName.split("/"),
        "vendor", codexCliPlatformBacking(process.platform, process.arch)!.triple, "bin/codex"), 0o641);
      return { terminal: true, exitCode: 0 };
    } }));
    expect(result.outcome).toBe("ambiguous");
  }, 120_000);
  test.each(["#!/bin/sh\nexit 7\n", "#!/bin/sh\nprintf 'codex-cli 9.9.9\\n'\n"])("verified bytes with unsuccessful/wrong version execution are ambiguous", async source => {
    const f = fixture(source); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      f.privateNpm([...invocation.args]); return { terminal: true, exitCode: 0 };
    } }));
    expect(result.outcome).toBe("ambiguous"); expect(result.reason).toBe("version_readback_unverified");
    expect(result.leaseRetained).toBe(false); expect(result.verificationPid).toBeNull();
  }, 120_000);
  test("uncertain owned version child retains lease/staging and exposes its PID", async () => {
    const f = fixture(); const id = await approved(f);
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async invocation => {
      f.privateNpm([...invocation.args]); return { terminal: true, exitCode: 0 };
    }, verifyVersion: async () => ({ terminal: false, ok: false, pid: 12345 }) }));
    expect(result.outcome).toBe("ambiguous"); expect(result.reason).toBe("version_process_state_unknown");
    expect(result.leaseRetained).toBe(true); expect(result.verificationPid).toBe(12345);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(true);
    expect(readdirSync(f.temporaryRoot).length).toBeGreaterThan(0);
    // Only an injected lifetime observation: there is no actual PID 12345 owned here.
  }, 120_000);
  test("empty and damaged apply locks remain busy without reclaim", async () => {
    const f = fixture(); const id = await approved(f); let installs = 0;
    const path = join(f.prefix, ".ocx-codex-cli-apply.lock"); mkdirSync(path, { mode: 0o700 });
    for (const owner of [null, "", "{broken"]) {
      if (owner !== null) writeFileSync(join(path, "owner.json"), owner);
      const result = await applyCodexCliUpdate(id, depsFor(f, { install: async () => { installs++; return { terminal: true, exitCode: 0 }; } }));
      expect(result.reason).toBe("installation_busy"); expect(existsSync(path)).toBe(true);
    }
    expect(installs).toBe(0);
  }, 120_000);
  test("one prefix lease excludes a concurrent apply and remains held for an uncertain installer", async () => {
    const f = fixture(); const id = await approved(f);
    let resume!: () => void; let entered!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const first = applyCodexCliUpdate(id, depsFor(f, { fetchArtifact: async artifact => {
      entered(); await pending; return artifact.version === "1.1.0" ? f.target.main.bytes : f.target.backing.bytes;
    }, install: async () => ({ terminal: false, exitCode: null }) }));
    await admitted;
    const other = await applyCodexCliUpdate(id, depsFor(f));
    expect(other.reason).toBe("installation_busy");
    resume(); const result = await first;
    expect(result.outcome).toBe("ambiguous"); expect(result.leaseRetained).toBe(true);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(true);
    expect(acquireCodexCliApplyLease(f.prefix)).toBeNull();
    // The uncertain child is a test double; no real installer survives teardown.
  }, 120_000);
  test("original file mode damage is ambiguous, not not_applied", async () => {
    const f = fixture(); const id = await approved(f);
    const native = join(f.prefix, "lib", "node_modules", ...f.old.artifacts.backing.installName.split("/"),
      "vendor", codexCliPlatformBacking(process.platform, process.arch)!.triple, "bin/codex");
    const result = await applyCodexCliUpdate(id, depsFor(f, { install: async () => {
      chmodSync(native, 0o644); return { terminal: true, exitCode: 0 };
    } }));
    expect(result.outcome).toBe("ambiguous");
  }, 120_000);
  test("cancellation during npm waits for terminal state, keeping lease and staging until readback", async () => {
    const f = fixture(); const id = await approved(f); const controller = new AbortController();
    let close!: () => void, admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    const terminal = new Promise<void>(resolve => { close = resolve; });
    let done = false;
    const running = applyCodexCliUpdate(id, depsFor(f, { signal: controller.signal, install: async () => {
      admitted(); await terminal; return { terminal: true, exitCode: 0 };
    } })).then(result => { done = true; return result; });
    await started; controller.abort(); await Promise.resolve();
    expect(done).toBe(false); expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(true);
    expect(readdirSync(f.temporaryRoot).length).toBeGreaterThan(0);
    close(); const result = await running;
    expect(result.outcome).toBe("not_applied"); expect(result.leaseRetained).toBe(false);
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);
  test.each(["cancel", "error"] as const)("%s during preparation releases only its own lease", async kind => {
    const f = fixture(); const id = await approved(f); const controller = new AbortController();
    let installs = 0;
    const result = await applyCodexCliUpdate(id, depsFor(f, { signal: controller.signal,
      fetchArtifact: async () => { if (kind === "error") throw new Error("synthetic failure"); controller.abort(); return f.target.main.bytes; },
      install: async () => { installs++; return { terminal: true, exitCode: 0 }; },
    }));
    expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
    expect(existsSync(join(f.prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    expect(readdirSync(f.temporaryRoot)).toEqual([]);
  }, 120_000);
});
