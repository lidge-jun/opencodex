import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type BundleKind = "dmg" | "app.tar.gz" | "msi" | "appimage" | "deb";

interface BundleSpec {
  kind: BundleKind;
  dir: string;
  name: string;
}

const bundlesByTarget: Record<string, BundleSpec[]> = {
  "universal-apple-darwin": [
    { kind: "dmg", dir: "dmg", name: "macos.dmg" },
    { kind: "app.tar.gz", dir: "macos", name: "macos.app.tar.gz" },
  ],
  "aarch64-apple-darwin": [
    { kind: "dmg", dir: "dmg", name: "macos.dmg" },
    { kind: "app.tar.gz", dir: "macos", name: "macos.app.tar.gz" },
  ],
  "x86_64-apple-darwin": [
    { kind: "dmg", dir: "dmg", name: "macos.dmg" },
    { kind: "app.tar.gz", dir: "macos", name: "macos.app.tar.gz" },
  ],
  "x86_64-pc-windows-msvc": [{ kind: "msi", dir: "msi", name: "windows-x64.msi" }],
  "x86_64-unknown-linux-gnu": [
    { kind: "appimage", dir: "appimage", name: "linux-x86_64.AppImage" },
    { kind: "deb", dir: "deb", name: "linux-amd64.deb" },
  ],
};

export interface CollectReleaseAssetsOptions {
  version: string;
  target: string;
  out: string;
  repoRoot?: string;
}

function findBundle(directory: string, kind: BundleKind): string {
  if (!existsSync(directory)) {
    throw new Error(`Missing ${kind} bundle directory: ${directory}`);
  }
  const artifact = readdirSync(directory)
    .filter(name => name.toLowerCase().endsWith(`.${kind.toLowerCase()}`));
  if (artifact.length === 0) throw new Error(`No ${kind} bundle found in ${directory}`);
  if (artifact.length > 1) {
    throw new Error(`Multiple ${kind} bundles found in ${directory}: ${artifact.join(", ")}`);
  }
  return join(directory, artifact[0]);
}

export function collectReleaseAssets(options: CollectReleaseAssetsOptions): string[] {
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dir, "../.."));
  const bundles = bundlesByTarget[options.target];
  if (!bundles) throw new Error(`Unsupported desktop target: ${options.target}`);

  const output = resolve(options.out);
  mkdirSync(output, { recursive: true });
  const written: string[] = [];
  for (const bundle of bundles) {
    const source = findBundle(
      join(repoRoot, "desktop", "src-tauri", "target", options.target, "release", "bundle", bundle.dir),
      bundle.kind,
    );
    const destinationName = `OpenCodex-${options.version}-${bundle.name}`;
    const destination = join(output, destinationName);
    copyFileSync(source, destination);
    written.push(destination);

    const signature = `${source}.sig`;
    if (existsSync(signature)) {
      copyFileSync(signature, `${destination}.sig`);
      written.push(`${destination}.sig`);
    }

    const digest = createHash("sha256").update(readFileSync(destination)).digest("hex");
    const checksum = `${destination}.sha256`;
    writeFileSync(checksum, `${digest}  ${destinationName}\n`);
    written.push(checksum);
  }
  return written;
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

if (import.meta.main) {
  const version = argument("--version");
  const target = argument("--target");
  const out = argument("--out");
  if (!version || !target || !out) {
    throw new Error("Usage: collect-release-assets.ts --version <version> --target <target> --out <dir>");
  }
  for (const path of collectReleaseAssets({ version, target, out })) console.log(`Wrote ${path}`);
}
