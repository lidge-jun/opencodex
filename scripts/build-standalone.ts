import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isStandaloneTarget, standaloneExecutableName } from "./standalone-targets";

function hostTarget(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${platform}-${arch}`;
}

function argumentValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const target = argumentValue("--target") ?? hostTarget();
if (!isStandaloneTarget(target)) {
  throw new Error(`Unsupported standalone target: ${target}`);
}

const repoRoot = resolve(import.meta.dir, "..");
const guiDist = join(repoRoot, "gui", "dist");
if (!existsSync(join(guiDist, "index.html"))) {
  throw new Error("gui/dist is missing; run `bun run build:gui` first");
}

const output = resolve(argumentValue("--out") ?? join(repoRoot, "dist", "standalone", target));
mkdirSync(output, { recursive: true });
const executable = join(output, standaloneExecutableName(target));
const result = Bun.spawnSync([
  process.execPath,
  "build",
  "--compile",
  "--target",
  target,
  join(repoRoot, "src", "cli", "index.ts"),
  "--outfile",
  executable,
], { stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) process.exit(result.exitCode);

cpSync(guiDist, join(output, "gui", "dist"), { recursive: true });
const digest = createHash("sha256").update(readFileSync(executable)).digest("hex");
writeFileSync(join(output, "SHA256SUMS"), `${digest}  ${executable.split(/[\\/]/).pop()}\n`);
console.log(`Built ${executable}`);
