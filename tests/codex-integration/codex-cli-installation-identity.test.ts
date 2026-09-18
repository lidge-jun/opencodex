import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import {
  inspectCodexCliInstallationIdentity,
  type CodexCliInstallationIdentityInput,
  type InstallationFileRequest,
  type InstallationFilesResult,
  type ObservedInstallationFile,
} from "../../src/codex/cli-installation-identity";

const nativeTest = process.platform === "win32" && process.arch === "x64" ? test : test.skip;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const codexManifest = JSON.stringify({ name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" } });
const npmManifest = JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "bin/npm-cli.js" } });
// Independent fixture of the npm cmd-shim grammar, including the PATHEXT substitution delimiter.
const cmdShim = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL",
  "CALL :find_dp0", "", 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n") + "\r\n";

function inputFor(prefix: string): CodexCliInstallationIdentityInput {
  return {
    candidate: win32.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js"),
    npmPrefix: prefix,
    npmCli: win32.join(prefix, "tools", "node_modules", "npm", "bin", "npm-cli.js"),
    node: win32.join(prefix, "tools", "node.exe"),
  };
}

function contents(input: CodexCliInstallationIdentityInput): Map<string, string> {
  return new Map([
    [win32.join(input.npmPrefix, "node_modules", "@openai", "codex", "package.json"), codexManifest],
    [win32.join(input.npmPrefix, "node_modules", "@openai", "codex", "bin", "codex.js"), 'throw new Error("candidate must never execute");'],
    [win32.join(input.npmPrefix, "tools", "node_modules", "npm", "package.json"), npmManifest],
    [input.npmCli, 'throw new Error("npm must never execute");'],
    [input.node, "synthetic non-executable node identity"],
    [win32.join(input.npmPrefix, "codex.cmd"), cmdShim],
  ]);
}

function mockFiles(input = inputFor("C:\\Install")) {
  const values = contents(input);
  let pass = 0;
  const batches: InstallationFileRequest[][] = [];
  const read = async (
    requests: readonly InstallationFileRequest[],
    alter?: (file: ObservedInstallationFile, pass: number) => ObservedInstallationFile,
  ): Promise<InstallationFilesResult> => {
    pass += 1;
    batches.push([...requests]);
    return {
      kind: "observed",
      files: requests.map(request => {
        const value = values.get(request.path);
        if (value === undefined) throw new Error("unexpected fixture path");
        const bytes = Buffer.from(value);
        const file: ObservedInstallationFile = {
          path: request.path,
          identity: { volumeSerial: "01", fileId: request.path, size: bytes.length, lastWriteTime: "1", changeTime: "1" },
          bytes: request.hashOnly ? new Uint8Array() : bytes,
          digest: sha256(bytes),
        };
        return alter?.(file, pass) ?? file;
      }),
    };
  };
  return { input, values, read, batches };
}

function realFixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-installation-identity-"));
  const input = inputFor(root);
  const files = contents(input);
  const directories = new Set<string>();
  for (const [path, value] of files) {
    let directory = dirname(path);
    while (directory !== root) { directories.add(directory); directory = dirname(directory); }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
  return {
    input,
    cleanup: () => {
      // Every target is a file created above; remove only those leaves and then empty directories.
      for (const path of files.keys()) if (existsSync(path)) unlinkSync(path);
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) rmdirSync(directory);
      rmdirSync(root);
    },
  };
}

describe("explicit Codex CLI installation identity", () => {
  nativeTest("observes real Windows package/tool files without executing them and binds content changes", async () => {
    const fixture = realFixture();
    try {
      const first = await inspectCodexCliInstallationIdentity(fixture.input);
      expect(first).toMatchObject({
        status: "observed", reason: "identity_observed", installationIdentityObserved: true,
        candidateSource: "explicit-cli", packageVersion: "1.2.3", npmVersion: "11.0.0",
        selectionAttested: false, managed: false, applyAllowed: false,
        proof: "windows-handle-bound", toolchain: "observed-only",
      });
      expect(first.identityDigest).toMatch(/^[a-f0-9]{64}$/);
      expect((await inspectCodexCliInstallationIdentity(fixture.input)).identityDigest).toBe(first.identityDigest);
      const publicJson = JSON.stringify(first);
      expect(publicJson).not.toContain("ocx-installation-identity-");
      expect(publicJson).not.toContain("candidate must never execute");
      writeFileSync(fixture.input.node, "different synthetic non-executable node identity");
      const changed = await inspectCodexCliInstallationIdentity(fixture.input);
      expect(changed.status).toBe("observed");
      expect(changed.identityDigest).not.toBe(first.identityDigest);
    } finally { fixture.cleanup(); }
  });

  nativeTest("accepts the real standard npm cmd shim but refuses appended commands", async () => {
    const fixture = realFixture();
    try {
      const input = { ...fixture.input, candidate: win32.join(fixture.input.npmPrefix, "codex.cmd") };
      expect((await inspectCodexCliInstallationIdentity(input)).status).toBe("observed");
      writeFileSync(input.candidate, cmdShim + "echo extra command\r\n");
      expect(await inspectCodexCliInstallationIdentity(input)).toMatchObject({
        status: "refused", reason: "launcher_mismatch", installationIdentityObserved: false, identityDigest: null,
      });
    } finally { fixture.cleanup(); }
  });

  test("unsupported platform and unsafe or unrelated paths do not reach filesystem inspection", async () => {
    const input = inputFor("C:\\Install");
    let reads = 0;
    const inspectFiles = async (): Promise<InstallationFilesResult> => { reads += 1; throw new Error("unexpected I/O"); };
    expect((await inspectCodexCliInstallationIdentity(input, { platform: "linux", inspectFiles })).reason).toBe("unsupported_platform");
    for (const candidate of ["codex", "C:codex.cmd", "C:\\Install\\..\\codex.cmd", "\\\\host\\share\\codex.cmd"]) {
      expect((await inspectCodexCliInstallationIdentity({ ...input, candidate }, { platform: "win32", inspectFiles })).reason).toBe("unsafe_path");
    }
    for (const replacement of [
      { npmPrefix: "C:\\Elsewhere" }, { candidate: input.candidate.replace("Install", "install") },
      { node: "C:\\tools\\other.exe" }, { npmCli: "C:\\tools\\npm.cmd" },
      { candidate: "C:\\scoop\\codex.cmd" },
    ]) {
      expect((await inspectCodexCliInstallationIdentity({ ...input, ...replacement }, { platform: "win32", inspectFiles })).reason)
        .toBe("unsupported_layout");
    }
    expect(reads).toBe(0);
  });

  test.each(["identity", "contents"])("a manifest %s change between discovery and coherent observation is refused", async change => {
    const fixture = mockFiles();
    const result = await inspectCodexCliInstallationIdentity(fixture.input, {
      platform: "win32",
      inspectFiles: requests => fixture.read(requests, (file, pass) => {
        if (pass !== 2 || !file.path.endsWith("package.json")) return file;
        if (change === "identity") return { ...file, identity: { ...file.identity, changeTime: "2" } };
        const bytes = Buffer.from(Buffer.from(file.bytes).toString("utf8").replace("1.2.3", "1.2.4"));
        return { ...file, bytes, digest: sha256(bytes) };
      }),
    });
    expect(result).toMatchObject({ status: "refused", reason: "identity_changed", identityDigest: null });
    expect(fixture.batches).toHaveLength(2);
  });

  test("case-distinct returned paths cannot stand in for the requested manifest", async () => {
    const fixture = mockFiles();
    expect((await inspectCodexCliInstallationIdentity(fixture.input, {
      platform: "win32",
      inspectFiles: requests => fixture.read(requests, file => ({ ...file, path: file.path.replace("Install", "install") })),
    })).reason).toBe("read_failed");
  });

  test("invalid package names, versions and bin mappings refuse before linked-file reads", async () => {
    for (const bad of [
      { name: "unrelated", version: "1.2.3", bin: "bin/codex.js" },
      { name: "@openai/codex", version: "unknown", bin: "bin/codex.js" },
      { name: "@openai/codex", version: "1.2.3", bin: "../escape.js" },
    ]) {
      const fixture = mockFiles();
      fixture.values.set(win32.join(fixture.input.npmPrefix, "node_modules", "@openai", "codex", "package.json"), JSON.stringify(bad));
      expect((await inspectCodexCliInstallationIdentity(fixture.input, { platform: "win32", inspectFiles: fixture.read })).reason)
        .toBe("package_mismatch");
      expect(fixture.batches).toHaveLength(1);
    }
    const fixture = mockFiles();
    fixture.values.set(win32.join(fixture.input.npmPrefix, "tools", "node_modules", "npm", "package.json"),
      JSON.stringify({ name: "npm", version: "11.0.0", bin: { npm: "../npm-cli.js" } }));
    expect((await inspectCodexCliInstallationIdentity(fixture.input, { platform: "win32", inspectFiles: fixture.read })).reason)
      .toBe("package_mismatch");
  });

  test("the explicit Node is hash-only and every requested linked file must be present", async () => {
    const fixture = mockFiles();
    expect((await inspectCodexCliInstallationIdentity(fixture.input, { platform: "win32", inspectFiles: fixture.read })).status).toBe("observed");
    expect(fixture.batches[1]!.find(file => file.path === fixture.input.node)).toEqual({
      path: fixture.input.node, maxBytes: 256 * 1024 * 1024, hashOnly: true,
    });
    const missing = mockFiles();
    expect((await inspectCodexCliInstallationIdentity(missing.input, {
      platform: "win32", inspectFiles: async requests => {
        const result = await missing.read(requests);
        return result.kind === "observed"
          ? { kind: "observed", files: result.files.filter(file => file.path !== missing.input.node) } : result;
      },
    })).reason).toBe("read_failed");
  });

  test("native refusals and exceptions stay redacted and never grant authority", async () => {
    for (const inspectFiles of [
      async (): Promise<InstallationFilesResult> => ({ kind: "refused", reason: "private C:\\secret\\file" }),
      async (): Promise<InstallationFilesResult> => { throw new Error("private C:\\secret\\file"); },
    ]) {
      const result = await inspectCodexCliInstallationIdentity(inputFor("C:\\Install"), { platform: "win32", inspectFiles });
      expect(result).toMatchObject({ status: "refused", selectionAttested: false, managed: false, applyAllowed: false, identityDigest: null });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  test("a selected candidate source is echoed without changing the observation contract", async () => {
    const fixture = mockFiles();
    const selected = { ...fixture.input, candidateSource: "selected" as const };
    const observed = await inspectCodexCliInstallationIdentity(selected, { platform: "win32", inspectFiles: fixture.read });
    expect(observed).toMatchObject({
      status: "observed", candidateSource: "selected", installationIdentityObserved: true,
      selectionAttested: false, managed: false, applyAllowed: false,
    });
    const refused = await inspectCodexCliInstallationIdentity(
      { ...selected, candidate: "C:\\elsewhere\\codex.cmd" }, { platform: "win32", inspectFiles: fixture.read });
    expect(refused).toMatchObject({ status: "refused", candidateSource: "selected", reason: "unsupported_layout" });
  });

  test("the renamed npm launcher codex.opencodex-real.cmd is grammar-checked like the shim", async () => {
    const fixture = mockFiles();
    const backing = win32.join(fixture.input.npmPrefix, "codex.opencodex-real.cmd");
    fixture.values.set(backing, cmdShim);
    expect((await inspectCodexCliInstallationIdentity(
      { ...fixture.input, candidate: backing },
      { platform: "win32", inspectFiles: fixture.read },
    ))).toMatchObject({ status: "refused", reason: "unsupported_layout", candidateSource: "explicit-cli" });
    expect(fixture.batches).toHaveLength(0);
    const input = { ...fixture.input, candidate: backing, candidateSource: "selected" as const };
    expect((await inspectCodexCliInstallationIdentity(input, { platform: "win32", inspectFiles: fixture.read })))
      .toMatchObject({ status: "observed", reason: "identity_observed", candidateSource: "selected" });
    fixture.values.set(backing, "@echo off\\r\\nrem arbitrary wrapper\\r\\n");
    expect((await inspectCodexCliInstallationIdentity(input, { platform: "win32", inspectFiles: fixture.read })))
      .toMatchObject({ status: "refused", reason: "launcher_mismatch" });
  });
});
