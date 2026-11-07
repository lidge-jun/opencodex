/** Private candidate; controlled artifacts only. Never executes fixture Node/npm/vendor bytes. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import type { CodexCliApplyDeps } from "../../src/codex/cli-update-apply";
import { fixtureArtifact, fixtureTar } from "./codex-cli-apply-artifact";
import { fixturePath } from "./repo-root";

const mainRoot = "node_modules/@openai/codex";
const backingRoot = "node_modules/@openai/codex-win32-x64";
const nativePath = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
function write(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { flag: "wx" });
}
function artifacts(version: string) {
  // Same valid synthetic PE/layout pattern as windows-apply.test.ts, not a runnable Node.
  const pe = Buffer.alloc(512); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(1, 70); pe.writeUInt16LE(240, 84);
  pe.writeUInt16LE(2, 86); pe.writeUInt16LE(0x20b, 88);
  const mainFiles = { "package.json": JSON.stringify({ name: "@openai/codex", version,
    bin: { codex: "bin/codex.js" }, optionalDependencies: { "@openai/codex-win32-x64": version } }),
    "bin/codex.js": `#!/usr/bin/env node\nconsole.log("codex-cli ${version}");\n`, "README.md": "fixture\n" };
  const backingFiles = { "package.json": JSON.stringify({ name: "@openai/codex-win32-x64", version,
    os: ["win32"], cpu: ["x64"] }), [nativePath]: pe, "vendor/auxiliary.txt": "fixture\n" };
  const main = fixtureTar(mainFiles), backing = fixtureTar(backingFiles);
  return { pe, mainFiles, backingFiles, main, backing, set: { platform: "win32" as const, arch: "x64",
    main: fixtureArtifact(main, version),
    backing: fixtureArtifact(backing, version, "@openai/codex-win32-x64", "@openai/codex-win32-x64") } };
}

export async function prepareRetentionFixture(root: string) {
  const prefix = join(root, "prefix"), tools = join(root, "tools"), configDir = join(root, "config");
  mkdirSync(prefix); mkdirSync(tools);
  await hardenSecretDirAsync(prefix, { required: true });
  await hardenSecretDirAsync(tools, { required: true });
  const old = artifacts("1.0.0"), target = artifacts("1.1.0");
  for (const [path, bytes] of Object.entries(old.mainFiles)) write(join(prefix, mainRoot, path), bytes);
  for (const [path, bytes] of Object.entries(old.backingFiles)) write(join(prefix, backingRoot, path), bytes);
  const shims = JSON.parse(readFileSync(fixturePath("codex-windows-npm-shims.json"), "utf8"));
  for (const [name, bytes] of Object.entries(shims.files)) write(join(prefix, name), String(bytes));
  write(join(tools, "node.exe"), old.pe);
  write(join(tools, "node_modules/npm/package.json"), JSON.stringify({ name: "npm", version: "11.0.0",
    bin: { npm: "bin/npm-cli.js" } }));
  const npmCli = join(tools, "node_modules/npm/bin/npm-cli.js");
  write(npmCli, "throw new Error('FIXTURE_NPM_MUST_NEVER_EXECUTE');\n");
  const deps: CodexCliApplyDeps = {
    platform: "win32", inspectionDeps: { env: { CODEX_CLI_PATH: join(prefix, "codex.cmd"),
      PATH: tools, PATHEXT: ".EXE;.CMD" }, configDir, arch: "x64", selectionAttested: true },
    resolveTarget: () => ({ kind: "resolved", version: "1.1.0", integrity: target.set.main.integrity, artifacts: target.set }),
    // Controlled empty process observation, not a claim to have scanned live applications.
    scanProcesses: () => ({ kind: "observed", processes: [] }),
    fetchArtifact: async artifact => {
      if (artifact.integrity === target.set.main.integrity && artifact.installName === "@openai/codex") return target.main;
      if (artifact.integrity === target.set.backing.integrity && artifact.installName === "@openai/codex-win32-x64") return target.backing;
      throw new Error("UNEXPECTED_ARTIFACT_NO_NETWORK");
    },
  };
  return { root, prefix, configDir, npmCli, deps };
}
