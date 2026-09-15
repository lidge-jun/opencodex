import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Compute SHA-256 digest of utf-8 string or buffer. */
export function sha256(content: string | Buffer): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

/** Compute SHA-256 digest of a file on disk. */
export function sha256File(filePath: string): string {
  const buffer = readFileSync(filePath);
  return sha256(buffer);
}

/**
 * Deterministically compute the canonical content SHA-256 for a Skill.
 * Sorts all file paths (including entry SKILL.md) and combines their individual hashes.
 */
export function computeSkillContentHash(
  entryFileContent: string,
  bundledFiles: Record<string, string | Buffer> = {},
  entryFileName = "SKILL.md",
): { contentSha256: string; filesSha256: Record<string, string> } {
  const filesSha256: Record<string, string> = {};
  filesSha256[entryFileName] = sha256(entryFileContent);

  for (const [relPath, content] of Object.entries(bundledFiles)) {
    if (relPath === entryFileName) continue;
    filesSha256[relPath] = sha256(content);
  }

  // Sort keys deterministically
  const sortedKeys = Object.keys(filesSha256).sort();
  const compositeHash = createHash("sha256");
  for (const k of sortedKeys) {
    compositeHash.update(`${k}:${filesSha256[k]}\n`);
  }

  return {
    contentSha256: compositeHash.digest("hex"),
    filesSha256,
  };
}

/**
 * Scan a directory recursively and compute individual file hashes and composite hash.
 */
export function computeDirectoryHash(dirPath: string): {
  contentSha256: string;
  filesSha256: Record<string, string>;
  files: string[];
} {
  const filesSha256: Record<string, string> = {};
  const files: string[] = [];

  function walk(current: string) {
    if (!existsSync(current)) return;
    const entries = readdirSync(current).sort();
    for (const entry of entries) {
      const full = join(current, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const rel = relative(dirPath, full).split("\\").join("/");
        if (rel === ".pao-managed.json" || rel.startsWith(".pao-")) continue;
        const hash = sha256File(full);
        filesSha256[rel] = hash;
        files.push(rel);
      }
    }
  }

  walk(dirPath);
  files.sort();

  const composite = createHash("sha256");
  for (const file of files) {
    composite.update(`${file}:${filesSha256[file]}\n`);
  }

  return {
    contentSha256: composite.digest("hex"),
    filesSha256,
    files,
  };
}

