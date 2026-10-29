import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
import { SPAWN_BUDGET_MS } from "./test-budget";
import { trustWindowsTempFixtureAncestry } from "./windows-temp-ancestry";
import { afterEach, expect, test } from "bun:test";
import { cpSync, realpathSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createCodexCliUpdatePlan } from "../../src/codex/cli-update-plan";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { removeTreeAfterBackgroundWork } from "./remove-tree";
import { fixtureArtifact, fixtureTar } from "./codex-cli-apply-artifact";
import { fixturePath } from "./repo-root";

export const native = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
// Full native npm-tree ACL/identity renewal and real children are the proof.
// Bound this class for a shared Windows host; keep every admission/readback assertion.
export const WINDOWS_APPLY_BUDGET_MS = 4 * SPAWN_BUDGET_MS;
export const WINDOWS_APPLY_CHILD_BUDGET_MS = 2 * SPAWN_BUDGET_MS;
export type WorkerFixtureReply = { type: string; requestId?: string; cleanupConfirmed?: boolean; result?: import("../../src/codex/cli-update-apply").CodexCliApplyResult };
export function fixtureCleanupProven(messages: readonly unknown[], requestId: string, closed: boolean, errored: boolean,
  expectedErrors: readonly string[] = []): boolean {
  if (!closed || errored) return false;
  const replies: WorkerFixtureReply[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const message = value as WorkerFixtureReply;
    // Assertions can fail independently: teardown authority rejects ALL foreign,
    // malformed or error traffic, including traffic mixed with a valid result.
    if (message.requestId !== requestId || !["native-start", "result"].includes(message.type)) return false;
    if (message.type === "native-start" && (value as { committed?: unknown }).committed !== true) return false;
    if (message.type === "result" && (!message.result || typeof message.result !== "object"
      || Array.isArray(message.result) || message.cleanupConfirmed !== true)) return false;
    if (message.type === "result") {
      const result = message.result!;
      const version = (value: unknown) => value === null || typeof value === "string";
      if (!["applied", "not_applied", "refused", "ambiguous"].includes(result.outcome)
        || typeof result.reason !== "string" || !/^[a-f0-9]{32}$/.test(result.planId)
        || !version(result.installedVersion) || !version(result.targetVersion)
        || !(result.installerExitCode === null || Number.isInteger(result.installerExitCode))
        || !(result.verificationPid === null || (Number.isInteger(result.verificationPid) && result.verificationPid > 0))) return false;
    }
    replies.push(message);
  }
  const results = replies.filter(message => message.type === "result");
  return results.length === 1
    && results[0]!.cleanupConfirmed === true && results[0]!.result?.leaseRetained === false
    && Array.isArray(results[0]!.result?.cleanupErrors)
    && JSON.stringify(results[0]!.result!.cleanupErrors) === JSON.stringify(expectedErrors);
}
export const mainRoot = "node_modules/@openai/codex", backingRoot = "node_modules/@openai/codex-win32-x64";
export const nativePath = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
export const write = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
export function artifacts(version: string, executable?: Buffer) {
  const pe = Buffer.alloc(512); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(1, 70); pe.writeUInt16LE(240, 84); pe.writeUInt16LE(2, 86); pe.writeUInt16LE(0x20b, 88);
  // Synthetic PE only. The real Node verification child executes this fixture's JS;
  // this is an npm/readback test, not a claim that a real Codex native binary ran.
  const mainFiles = { "package.json": JSON.stringify({ name: "@openai/codex", version,
    bin: { codex: "bin/codex.js" }, optionalDependencies: { "@openai/codex-win32-x64": version } }),
    "bin/codex.js": executable ? '#!/usr/bin/env node\n' +
      'const cp=require("node:child_process"), path=require("node:path");\n' +
      'const exe=path.join(__dirname,"../../codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");\n' +
      'const child=cp.spawn(exe,process.argv.slice(2),{stdio:"inherit",windowsHide:true});\n' +
      'child.on("error",()=>{process.exitCode=91});child.on("exit",code=>{process.exitCode=code??92});\n'
      : `#!/usr/bin/env node\nconsole.log("codex-cli ${version}");\n`, "README.md": "auxiliary\n" };
  const backingFiles = { "package.json": JSON.stringify({ name: "@openai/codex-win32-x64", version, os: ["win32"], cpu: ["x64"] }),
    [nativePath]: executable ?? pe, "vendor/auxiliary.txt": "auxiliary\n" };
  const main = fixtureTar(mainFiles), backing = fixtureTar(backingFiles);
  return { mainFiles, backingFiles, main, backing, set: { platform: "win32" as const, arch: "x64",
    main: fixtureArtifact(main, version), backing: fixtureArtifact(backing, version, "@openai/codex-win32-x64", "@openai/codex-win32-x64") } };
}
// Each importing test file owns its fixture roots and cleanup hook, including without --isolate.
export function createWindowsApplyFixtures() {
  const roots: string[] = [];
  const liveFixtureRoots = new Set<string>();
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      if (liveFixtureRoots.has(root)) { roots.push(root); continue; }
      await removeTreeAfterBackgroundWork(root);
    }
  });
  async function fixture(executable?: Buffer, onCreated?: (root: string) => void) {
    // This host's observed writable AppData ancestry refused; this is not a ban on
    // every profile. Evaluate actual ancestry ACL/owner/reparse evidence instead.
    // Create only this test-owned directory below the repository's volume anchor;
    // never repair or suppress metadata on the host's existing ancestor directories.
    const root = createCodexCliTestRoot("ocx-win-apply-");
    onCreated?.(root); roots.push(root);
    await hardenSecretDirAsync(root, { required: true });
    trustWindowsTempFixtureAncestry(root);
    const prefix = join(root, "prefix"); mkdirSync(prefix);
    await hardenSecretDirAsync(prefix, { required: true });
    const old = artifacts("1.0.0"), target = artifacts("1.1.0", executable);
    for (const [relative, bytes] of Object.entries(old.mainFiles)) write(join(prefix, mainRoot, relative), bytes);
    for (const [relative, bytes] of Object.entries(old.backingFiles)) write(join(prefix, backingRoot, relative), bytes);
    const shims = JSON.parse(readFileSync(fixturePath("codex-windows-npm-shims.json"), "utf8"));
    for (const [name, bytes] of Object.entries(shims.files)) write(join(prefix, name), String(bytes));
    const sourceNode = realpathSync(Bun.which("node.exe")!);
    const nodeDir = join(root, "nodejs"); mkdirSync(nodeDir);
    copyFileSync(sourceNode, join(nodeDir, "node.exe"));
    cpSync(join(dirname(sourceNode), "node_modules", "npm"), join(nodeDir, "node_modules", "npm"), { recursive: true });
    const inspectionDeps = { env: { CODEX_CLI_PATH: join(prefix, "codex.cmd"), PATH: nodeDir, PATHEXT: ".EXE;.CMD" },
      configDir: join(root, "absent-home"), arch: "x64" as const, selectionAttested: true };
    const deps = { platform: "win32" as const, inspectionDeps,
      resolveTarget: () => ({ kind: "resolved" as const, version: "1.1.0", integrity: target.set.main.integrity, artifacts: target.set }),
      scanProcesses: () => ({ kind: "observed" as const, processes: [] }),
      fetchArtifact: async (artifact: typeof target.set.main) => artifact.installName === "@openai/codex" ? target.main : target.backing };
    return { root, prefix, old, target, deps };
  }
  async function approved(f: Awaited<ReturnType<typeof fixture>>) {
    const plan = await createCodexCliUpdatePlan(f.deps);
    expect(plan, JSON.stringify(plan)).toMatchObject({ applicable: true, refusal: null });
    expect(plan.planId).toMatch(/^[a-f0-9]{32}$/); return plan.planId!;
  }

  return { roots, liveFixtureRoots, fixture, approved };
}
