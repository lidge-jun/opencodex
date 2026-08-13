import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CompatibilityVersionManifest {
  schemaVersion: 1;
  assertionDslVersion: "1.0.0";
  evidenceSchemaVersion: "1.0.0";
  bunRuntimeVersion: string;
  files: Array<{ path: string; sha256: string }>;
}

const REQUIRED_ROOT_FILES = ["package.json", "bun.lock", "scripts/model-metadata.source.json"] as const;
const SELF_PATH = "src/generated/compatibility-version.json";

function decodeGitPaths(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 0) continue;
    if (index > start) paths.push(decoder.decode(bytes.slice(start, index)));
    start = index + 1;
  }
  return paths;
}

function validateRepoPath(path: string): void {
  if (!path || path.includes("\\") || path.startsWith("/") || posix.normalize(path) !== path) {
    throw new Error(`invalid compatibility manifest path: ${JSON.stringify(path)}`);
  }
  if (path.split("/").includes("..")) throw new Error(`compatibility manifest path escapes root: ${path}`);
  if (path === SELF_PATH) {
    throw new Error(`${SELF_PATH} must remain untracked to avoid self-referential compatibility identity`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build the frozen CL-00 compatibility-version manifest from exact Git-tracked working-tree bytes. */
export function buildCompatibilityVersionManifest(repoRoot: string): CompatibilityVersionManifest {
  const root = resolve(repoRoot);
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--", "src", ...REQUIRED_ROOT_FILES],
    { cwd: root },
  );
  const rawPaths = decodeGitPaths(new Uint8Array(output));
  const seen = new Set<string>();
  const rows: Array<{ path: string; sha256: string }> = [];

  for (const path of rawPaths) {
    validateRepoPath(path);
    if (seen.has(path)) throw new Error(`duplicate compatibility manifest path: ${path}`);
    seen.add(path);
    const fullPath = join(root, ...path.split("/"));
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`compatibility manifest path is not a regular file: ${path}`);
    }
    rows.push({ path, sha256: sha256(readFileSync(fullPath)) });
  }

  for (const required of REQUIRED_ROOT_FILES) {
    if (!seen.has(required)) throw new Error(`required compatibility manifest path is not tracked: ${required}`);
  }
  if (!rows.some(row => row.path.startsWith("src/"))) {
    throw new Error("compatibility manifest contains no tracked src files");
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  return {
    schemaVersion: 1,
    assertionDslVersion: "1.0.0",
    evidenceSchemaVersion: "1.0.0",
    bunRuntimeVersion: Bun.version,
    files: rows,
  };
}

export function generateCompatibilityVersionManifest(repoRoot?: string): string {
  const root = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = buildCompatibilityVersionManifest(root);
  const outputPath = join(root, ...SELF_PATH.split("/"));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outputPath;
}

if (import.meta.main) {
  const path = generateCompatibilityVersionManifest();
  console.log(`generated ${path}`);
}
