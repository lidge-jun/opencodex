import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface UpdaterManifestOptions {
  version: string;
  dir: string;
  repo: string;
  out: string;
  warn?: (message: string) => void;
  requireAll?: boolean;
}

interface PlatformUpdate {
  signature: string;
  url: string;
}

export interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, PlatformUpdate>;
}

const platformFiles: Record<string, string> = {
  "darwin-aarch64": "macos.app.tar.gz",
  "darwin-x86_64": "macos.app.tar.gz",
  "windows-x86_64": "windows-x64.msi",
  // The AppImage is the plugin's default Linux target: it keeps the plain os-arch key so
  // AppImage installs from releases before the deb target existed keep resolving updates.
  "linux-x86_64": "linux-x86_64.AppImage",
  // A deb install cannot apply an AppImage payload (the updater validates the downloaded
  // bytes as a real .deb before installing), so it must resolve a distinct key. The shell
  // selects this key from the bundle type embedded at packaging time; see updater.rs.
  "linux-x86_64-deb": "linux-amd64.deb",
};

export function buildUpdaterManifest(options: UpdaterManifestOptions): UpdaterManifest {
  const dir = resolve(options.dir);
  const warn = options.warn ?? console.warn;
  const platforms: Record<string, PlatformUpdate> = {};
  const missing: string[] = [];
  for (const [platform, suffix] of Object.entries(platformFiles)) {
    const base = `OpenCodex-${options.version}-${suffix}`;
    const signaturePath = join(dir, `${base}.sig`);
    if (!existsSync(signaturePath)) {
      missing.push(platform);
      if (!options.requireAll) {
        warn(`Skipping ${platform}: missing ${signaturePath}`);
      }
      continue;
    }
    platforms[platform] = {
      signature: readFileSync(signaturePath, "utf8").trim(),
      url: `https://github.com/${options.repo}/releases/download/v${options.version}/${base}`,
    };
  }
  if (options.requireAll && missing.length > 0) {
    throw new Error(`Missing signed updater platforms: ${missing.join(", ")}`);
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error("No signed updater platforms remain");
  }
  return {
    version: options.version,
    notes: `https://github.com/${options.repo}/releases/tag/v${options.version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

export function writeUpdaterManifest(options: UpdaterManifestOptions): UpdaterManifest {
  const manifest = buildUpdaterManifest(options);
  const output = resolve(options.out);
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, output);
  return manifest;
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

if (import.meta.main) {
  const version = argument("--version");
  const dir = argument("--dir");
  const repo = argument("--repo");
  const out = argument("--out");
  const requireAll = Bun.argv.includes("--require-all");
  if (!version || !dir || !repo || !out) {
    throw new Error(
      "Usage: updater-manifest.ts --version <version> --dir <dir> --repo <owner/name> --out <file> [--require-all]",
    );
  }
  writeUpdaterManifest({ version, dir, repo, out, requireAll });
  console.log(`Wrote ${out}`);
}
