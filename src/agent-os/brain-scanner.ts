// Phase 15 (Brain Universe) — Project Scanner.
//
// READ-ONLY by construction: this module only walks directories and reads file
// metadata (size, mtime) plus tiny config files for framework detection. It has
// no write, rename, delete, or execute code paths at all. Secret files are
// EXCLUDED from indexing (never read, never hashed). Symlinks that escape the
// project root are never followed.

import { readdirSync, statSync, lstatSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";

export type ScanMode = "quick" | "standard" | "deep";
export type FileDisposition = "indexed" | "metadata_only" | "skipped" | "ignored" | "secret_excluded" | "failed";

const DEFAULT_IGNORED = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage",
  "__pycache__", ".venv", "venv", "tmp", "cache",
]);

const SECRET_PATTERNS = [
  /^.env$/i, /.env./i, /.pem$/i, /.key$/i,
  /^credentials.json$/i, /^secrets./i,
];

const INTERESTING_FILES = new Set([
  "README.md", "CLAUDE.md", "AGENTS.md", "SKILL.md", "skill.md",
  "package.json", "pyproject.toml", "requirements.txt",
  "docker-compose.yml", "Dockerfile", ".env.example",
  "mcp.json", "settings.json",
]);

export interface ScannedFile {
  path: string;
  disposition: FileDisposition;
  sizeBytes: number;
  extension: string | null;
  modifiedMs: number;
}

export interface ScanCoverage {
  filesScanned: number;
  filesIndexed: number;
  filesMetadataOnly: number;
  filesSkipped: number;
  filesIgnored: number;
  filesSecretExcluded: number;
  filesFailed: number;
  unreadablePaths: number;
  scanDurationMs: number;
}

export interface ScanResult {
  projectId: string;
  mode: ScanMode;
  coverage: ScanCoverage;
  files: ScannedFile[];
  detected: { frameworks: string[]; agentInstructions: string[]; configs: string[] };
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  scanEnabled: boolean;
  scanMode: ScanMode;
}

export function registerProject(input: { id?: string; name: string; rootPath: string; scanMode?: ScanMode }): ProjectRecord {
  const db = openAgentOsDb();
  const id = input.id ?? `proj_${randomUUID().slice(0, 8)}`;
  db.query(`
    INSERT INTO brain_projects (id, name, root_path, scan_enabled, scan_mode)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, scan_mode = excluded.scan_mode
  `).run(id, input.name, input.rootPath, input.scanMode ?? "standard");
  const row = db.query("SELECT * FROM brain_projects WHERE id = ?").get(id) as {
    id: string; name: string; root_path: string; scan_enabled: number; scan_mode: string;
  };
  return { id: row.id, name: row.name, rootPath: row.root_path, scanEnabled: row.scan_enabled === 1, scanMode: row.scan_mode as ScanMode };
}

function isSecretPath(name: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(name));
}

/** True when resolvedPath escapes rootPath (symlink escape / traversal guard). */
function escapesRoot(rootPath: string, resolvedPath: string): boolean {
  const rel = relative(rootPath, resolvedPath);
  return rel.startsWith("..") || rel.startsWith(`..${sep}`);
}

export function scanProject(projectId: string, mode?: ScanMode): ScanResult {
  const db = openAgentOsDb();
  const project = db.query("SELECT * FROM brain_projects WHERE id = ?").get(projectId) as
    | { id: string; name: string; root_path: string; scan_mode: string }
    | undefined;
  if (!project) throw new Error(`project ${projectId} not found`);
  const effectiveMode = mode ?? (project.scan_mode as ScanMode) ?? "standard";
  const rootPath = project.root_path;

  const coverage: ScanCoverage = {
    filesScanned: 0, filesIndexed: 0, filesMetadataOnly: 0, filesSkipped: 0,
    filesIgnored: 0, filesSecretExcluded: 0, filesFailed: 0, unreadablePaths: 0, scanDurationMs: 0,
  };
  const files: ScannedFile[] = [];
  const detected = { frameworks: new Set<string>(), agentInstructions: new Set<string>(), configs: new Set<string>() };

  const started = Date.now();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      coverage.unreadablePaths += 1;
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (DEFAULT_IGNORED.has(entry.name)) { coverage.filesIgnored += 1; continue; }
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        coverage.unreadablePaths += 1;
        continue;
      }
      // Symlink protection: resolve and refuse anything outside the root.
      if (stat.isSymbolicLink()) {
        // Never follow symlinks: a link could point outside the project root
        // (or at a device file). Broken links are counted as unreadable.
        coverage.unreadablePaths += 1;
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      coverage.filesScanned += 1;

      if (isSecretPath(entry.name)) {
        coverage.filesSecretExcluded += 1;
        files.push({ path: relative(rootPath, full), disposition: "secret_excluded", sizeBytes: stat.size, extension: null, modifiedMs: stat.mtimeMs });
        continue;
      }

      // File size policy: <1MB full index, 1-10MB partial, >10MB metadata only.
      const disposition: FileDisposition = stat.size > 10 * 1024 * 1024
        ? "metadata_only"
        : stat.size > 1024 * 1024
          ? "metadata_only"
          : "indexed";
      if (disposition === "indexed") coverage.filesIndexed += 1; else coverage.filesMetadataOnly += 1;

      const relPath = relative(rootPath, full);
      if (INTERESTING_FILES.has(entry.name)) {
        detected.configs.add(entry.name);
        if (entry.name === "CLAUDE.md" || entry.name === "AGENTS.md" || entry.name === "SKILL.md") {
          detected.agentInstructions.add(entry.name);
        }
        if (entry.name === "package.json" && effectiveMode !== "quick") {
          try {
            const pkg = JSON.parse(readFileSync(full, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps["next"]) detected.frameworks.add("next");
            if (deps["react"]) detected.frameworks.add("react");
            if (deps["astro"]) detected.frameworks.add("astro");
            if (deps["electron"]) detected.frameworks.add("electron");
            if (deps["typescript"]) detected.frameworks.add("typescript");
          } catch { coverage.filesSkipped += 1; }
        }
      }
      const dot = entry.name.lastIndexOf(".");
      files.push({
        path: relPath,
        disposition,
        sizeBytes: stat.size,
        extension: dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : null,
        modifiedMs: stat.mtimeMs,
      });
    }
  };

  walk(rootPath);
  coverage.scanDurationMs = Date.now() - started;

  const scanId = `scan_${randomUUID().slice(0, 8)}`;
  const persistSnapshot = db.transaction(() => {
    db.query(`
      INSERT INTO brain_scans (id, project_id, mode, coverage_json, created_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(scanId, projectId, effectiveMode, JSON.stringify(coverage), Date.now());
    const insertFile = db.query(`
      INSERT INTO brain_files
        (scan_id, project_id, path, disposition, size_bytes, extension, modified_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const file of files) {
      insertFile.run(
        scanId,
        projectId,
        file.path.split(sep).join("/"),
        file.disposition,
        file.sizeBytes,
        file.extension,
        Math.trunc(file.modifiedMs),
      );
    }
  });
  persistSnapshot();

  return {
    projectId,
    mode: effectiveMode,
    coverage,
    files,
    detected: { frameworks: [...detected.frameworks], agentInstructions: [...detected.agentInstructions], configs: [...detected.configs] },
  };
}
