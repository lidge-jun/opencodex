import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";

// Match the canonical generator without importing any not-yet-verified source.
const REQUIRED_ROOT_FILES = ["package.json", "bun.lock", "scripts/model-metadata.source.json"];
const MANIFEST_PATH = "src/generated/compatibility-version.json";

interface ManifestRow {
  path: string;
  sha256: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRows(raw: unknown): ManifestRow[] {
  if (!record(raw) || raw.schemaVersion !== 1
    || raw.assertionDslVersion !== "1.0.0" || raw.evidenceSchemaVersion !== "1.0.0"
    || typeof raw.bunRuntimeVersion !== "string" || !raw.bunRuntimeVersion
    || !Array.isArray(raw.files) || raw.files.length === 0) {
    throw new Error("Invalid compatibility manifest schema");
  }
  const seen = new Set<string>();
  return raw.files.map((row: unknown) => {
    if (!record(row) || typeof row.path !== "string" || typeof row.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      throw new Error("Invalid compatibility manifest entry");
    }
    const path = row.path;
    if (!path || /[\\\0]/.test(path) || posix.normalize(path) !== path
      || path.split("/").some(part => !part || part === "." || part === "..")
      || (!path.startsWith("src/") && !REQUIRED_ROOT_FILES.includes(path))
      || path === MANIFEST_PATH) {
      throw new Error(`Invalid compatibility manifest path: ${JSON.stringify(path)}`);
    }
    if (seen.has(path)) throw new Error(`Duplicate compatibility manifest entry: ${JSON.stringify(path)}`);
    seen.add(path);
    return { path, sha256: row.sha256 };
  });
}

function regularFile(root: string, path: string): string {
  const parts = path.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink in compatibility input: ${JSON.stringify(path)}`);
    }
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Non-regular compatibility input: ${JSON.stringify(path)}`);
    }
  }
  return current;
}

function sourceFiles(root: string, path = "src"): string[] {
  const stat = lstatSync(join(root, path));
  if (stat.isSymbolicLink()) throw new Error(`Symlink in source tree: ${JSON.stringify(path)}`);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error(`Non-regular source entry: ${JSON.stringify(path)}`);
  return readdirSync(join(root, path)).flatMap(name => sourceFiles(root, `${path}/${name}`));
}

/** Validate a Git-free build snapshot against the host-generated tracked-source manifest. */
export function verifyCompatibilitySnapshot(snapshotRoot: string): void {
  const root = resolve(snapshotRoot);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid compatibility snapshot root");
  const manifestFile = regularFile(root, MANIFEST_PATH);
  const rows = parseRows(JSON.parse(readFileSync(manifestFile, "utf8")));
  const expected = new Set(rows.map(row => row.path));
  for (const required of REQUIRED_ROOT_FILES) {
    if (!expected.has(required)) throw new Error(`Missing required manifest entry: ${required}`);
  }
  if (!rows.some(row => row.path.startsWith("src/"))) {
    throw new Error("Compatibility manifest contains no source files");
  }

  // Inspect the full tree, including symlinks to files/directories not named in the manifest.
  for (const path of sourceFiles(root)) {
    if (path !== MANIFEST_PATH && !expected.has(path)) {
      throw new Error(`Source file absent from compatibility manifest: ${JSON.stringify(path)}`);
    }
  }
  for (const row of rows) {
    const bytes = readFileSync(regularFile(root, row.path));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== row.sha256) {
      throw new Error(`Stale compatibility manifest: hash mismatch for ${JSON.stringify(row.path)}`);
    }
  }
}

if (import.meta.main) {
  verifyCompatibilitySnapshot(process.argv[2] ?? resolve(import.meta.dir, ".."));
}
