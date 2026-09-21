import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const targetByTriple: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

function hostTriple(): string | undefined {
  const result = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return undefined;
  const host = result.stdout.toString().match(/^host:\s*(\S+)$/m)?.[1];
  return host;
}

const repoRoot = resolve(import.meta.dir, "../..");
const triple =
  argument("--target") ??
  process.env.TARGET ??
  process.env.RUST_TARGET ??
  Bun.env.RUST_TARGET ??
  hostTriple();
if (!triple || !targetByTriple[triple]) {
  throw new Error(
    `Unsupported Rust target ${triple ?? "(host unavailable)"}; pass --target ${Object.keys(targetByTriple).join("|")}`,
  );
}

const target = targetByTriple[triple];
const source = join(repoRoot, "dist", "standalone", target);
const executable = join(source, target.startsWith("bun-windows-") ? "ocx.exe" : "ocx");
if (!existsSync(executable)) {
  const result = Bun.spawnSync([
    process.execPath,
    "run",
    "build:standalone",
    "--target",
    target,
  ], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

const desktopRoot = resolve(import.meta.dir, "..");
const binaries = join(desktopRoot, "src-tauri", "binaries");
const resources = join(desktopRoot, "src-tauri", "resources", "gui", "dist");
mkdirSync(binaries, { recursive: true });
mkdirSync(resources, { recursive: true });
const destination = join(binaries, `ocx-${triple}${target.startsWith("bun-windows-") ? ".exe" : ""}`);
copyFileSync(executable, destination);
cpSync(join(repoRoot, "gui", "dist"), resources, { recursive: true });
console.log(`Prepared ${destination}`);
