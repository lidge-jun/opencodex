import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { RESTRICTED_CAPABILITY_PATTERNS, STRICT_DEFAULTS } from "./constants";
import type { PackageCompatibility, SecurityImportedPackage } from "./types";

const INVENTORY_DIRS = ["skills", "agents", "commands", "rules", "mcp", "memory", "tools"];
const INVENTORY_FILES = ["SKILL.md", "AGENTS.md", "README.md"];
const SCRIPT_NAMES = new Set(["install.sh", "install_tools.sh", "setup.sh"]);

export interface PackageInventoryItem {
  path: string;
  kind: "file" | "dir";
  size: number;
  restricted: boolean;
  reason?: string;
}

function walk(root: string, current: string, items: PackageInventoryItem[]): void {
  if (!existsSync(current)) return;
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(current, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (entry.isDirectory()) {
      items.push({ path: rel, kind: "dir", size: 0, restricted: false });
      walk(root, full, items);
    } else if (entry.isFile()) {
      const size = statSync(full).size;
      const lower = entry.name.toLowerCase();
      const restrictedScript = SCRIPT_NAMES.has(lower);
      let body = "";
      try {
        if (size < 256_000) body = readFileSync(full, "utf8");
      } catch { /* binary */ }
      const match = RESTRICTED_CAPABILITY_PATTERNS.find(p => p.test(rel) || (body && p.test(body)));
      items.push({
        path: rel,
        kind: "file",
        size,
        restricted: restrictedScript || Boolean(match),
        reason: restrictedScript ? "imported_script_never_executed" : match ? "restricted_capability_pattern" : undefined,
      });
    }
  }
}

export function inventorySecurityPackage(sourcePath: string): {
  items: PackageInventoryItem[];
  restricted: string[];
  warnings: string[];
} {
  const items: PackageInventoryItem[] = [];
  walk(sourcePath, sourcePath, items);
  const restricted = items.filter(i => i.restricted).map(i => i.path);
  const warnings: string[] = [];
  if (!STRICT_DEFAULTS.imported_skill_auto_activate) {
    warnings.push("Imported packages start in REVIEW_REQUIRED and are never auto-activated.");
  }
  if (!STRICT_DEFAULTS.imported_tool_auto_execute) {
    warnings.push("Imported tools and shell scripts are never auto-executed.");
  }
  const hasInstall = items.some(i => SCRIPT_NAMES.has(basename(i.path).toLowerCase()));
  if (hasInstall) warnings.push("install.sh / install_tools.sh detected and will not be run.");
  for (const name of INVENTORY_FILES) {
    if (!existsSync(join(sourcePath, name))) warnings.push(`Missing ${name} (optional).`);
  }
  for (const dir of INVENTORY_DIRS) {
    if (!existsSync(join(sourcePath, dir))) warnings.push(`No ${dir}/ directory (optional).`);
  }
  return { items, restricted, warnings };
}

export function importSecurityPackage(sourcePath: string, actor = "operator"): SecurityImportedPackage {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new Error(`Package path is not a directory: ${sourcePath}`);
  }
  const { items, restricted, warnings } = inventorySecurityPackage(sourcePath);
  const compatibility: PackageCompatibility = restricted.length > 0 ? "QUARANTINED" : "REVIEW_REQUIRED";
  const now = new Date().toISOString();
  return {
    id: `pkg_${randomBytes(8).toString("hex")}`,
    name: basename(sourcePath),
    source: sourcePath,
    compatibility,
    restricted_items: restricted,
    warnings: [...warnings, `imported_by=${actor}`],
    inventory_json: JSON.stringify(items),
    created_at: now,
  };
}
