import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { CodexCliArtifact, CodexCliArtifactSet } from "../../src/codex/cli-update-artifacts";
import { codexCliPlatformBacking } from "../../src/codex/cli-install-provenance";

export function fixtureTar(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write("package/" + name);
    const octal = (offset: number, length: number, number: number) => header.write(number.toString(8).padStart(length - 1, "0") + "\0", offset, length);
    octal(100, 8, 0o755); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, bytes.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257);
    octal(148, 8, header.reduce((sum, byte) => sum + byte, 0));
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
export function fixtureArtifact(bytes: Buffer, version = "1.1.0", installName = "@openai/codex", name = "@openai/codex"): CodexCliArtifact {
  return { name, installName, version, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz` };
}
export function fixtureArtifactSet(platform: NodeJS.Platform = "linux", arch = "x64", version = "1.1.0") {
  const layout = codexCliPlatformBacking(platform, arch)!;
  const variant = `${version}-${layout.package.slice("@openai/codex-".length)}`;
  const mainManifest = { name: "@openai/codex", version, bin: { codex: "bin/codex.js" },
    optionalDependencies: Object.fromEntries(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]
      .map(suffix => [`@openai/codex-${suffix}`, `npm:@openai/codex@${version}-${suffix}`])) };
  const mainFiles = { "package.json": JSON.stringify(mainManifest) + "\n", "bin/codex.js": [
    "#!/usr/bin/env node", "// Synthetic fixture: resolve the installed platform alias like the published launcher.",
    `const root = require('node:path').dirname(require.resolve('${layout.package}/package.json'));`,
    `const native = require('node:path').join(root, 'vendor/${layout.triple}/bin/codex');`,
    "const child = require('node:child_process').spawnSync(native, process.argv.slice(2), {stdio:'inherit'});",
    "process.exit(child.status ?? 1);", "",
  ].join("\n") };
  const backingFiles = { "package.json": JSON.stringify({ name: "@openai/codex", version: variant }) + "\n",
    [`vendor/${layout.triple}/bin/codex`]: `#!/bin/sh\n# synthetic backing\n[ "$1" = "--version" ] || exit 2\nprintf 'codex-cli ${version}\\n'\n` };
  const main = fixtureTar(mainFiles), backing = fixtureTar(backingFiles);
  const artifacts: CodexCliArtifactSet = { platform, arch, main: fixtureArtifact(main, version),
    backing: fixtureArtifact(backing, variant, layout.package) };
  return { artifacts, main, backing, mainManifest, mainFiles, backingFiles };
}
