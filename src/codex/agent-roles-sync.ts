/**
 * Marker-owned Codex named-agent files for the role catalog.
 *
 * Writes only `$CODEX_HOME/agents/ocx-<id>.toml`. User files without the
 * ownership marker, including `reviewer.toml`, are never touched. Allowed keys
 * only — never `model_fallback`, sandbox, MCP, or skills (#1190).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import type { OcxConfig, OcxSubagentRole } from "../types";
import { agentRolesSyncEffective, enabledSubagentRoles, SUBAGENT_ROLE_ID_RE } from "./agent-roles";
import { resolveCodexHomeDir } from "./home";
import { tomlString } from "./paths";

export const AGENT_ROLE_MARKER = "# Managed by opencodex: agent role";
const OWNED_PREFIX = "ocx-";
const OWNED_SUFFIX = ".toml";

export type AgentRoleSyncResult = {
  written: string[];
  pruned: string[];
  warnings: string[];
};

export type AgentRoleSyncOptions = {
  /** Call-time Codex home. Defaults to `resolveCodexHomeDir()`. */
  codexHome?: string;
};

export function agentRoleFileName(id: string): string {
  return `${OWNED_PREFIX}${id}${OWNED_SUFFIX}`;
}

function isSafeOwnedFileName(file: string, id?: string): boolean {
  if (file !== basename(file) || file.includes("/") || file.includes("\\")) return false;
  if (!file.startsWith(OWNED_PREFIX) || !file.endsWith(OWNED_SUFFIX)) return false;
  const idFromFile = file.slice(OWNED_PREFIX.length, file.length - OWNED_SUFFIX.length);
  if (!SUBAGENT_ROLE_ID_RE.test(idFromFile)) return false;
  return id === undefined || idFromFile === id;
}

function renderRoleToml(role: OcxSubagentRole): string {
  const lines = [
    AGENT_ROLE_MARKER,
    `name = ${tomlString(role.id)}`,
    `description = ${tomlString(role.description)}`,
    `developer_instructions = ${tomlString(role.developerInstructions)}`,
    `model = ${tomlString(role.model)}`,
  ];
  if (role.effort) {
    lines.push(`model_reasoning_effort = ${tomlString(role.effort)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function isOwnedRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return false;
    return readFileSync(path, "utf8").includes(AGENT_ROLE_MARKER);
  } catch {
    return false;
  }
}

function inspectTarget(path: string): "missing" | "owned" | "conflict" | "not-file" {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return "not-file";
    return readFileSync(path, "utf8").includes(AGENT_ROLE_MARKER) ? "owned" : "conflict";
  } catch {
    return "missing";
  }
}

function unlinkQuietly(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function parseTomlName(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*name\s*=\s*(.*)$/);
    if (!match) continue;
    const raw = match[1]!.trim();
    if (raw.startsWith("\"")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        return typeof parsed === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
    if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw;
    return undefined;
  }
  return undefined;
}

function siblingNameConflict(dir: string, roleId: string, targetFile: string): string | undefined {
  const conventional = `${roleId}.toml`;
  if (conventional !== targetFile) {
    const conventionalPath = join(dir, conventional);
    try {
      const st = lstatSync(conventionalPath);
      if (st.isFile() || st.isSymbolicLink()) return conventional;
    } catch {
      // no conventional sibling
    }
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const existing of entries) {
    if (existing === targetFile || !existing.endsWith(".toml") || existing !== basename(existing)) continue;
    const path = join(dir, existing);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > 64_000) continue;
      const name = parseTomlName(readFileSync(path, "utf8"));
      if (name === roleId) return existing;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function syncCodexAgentRoles(
  config: Pick<OcxConfig, "subagentRoles" | "syncCodexAgentRoles">,
  options: AgentRoleSyncOptions = {},
): AgentRoleSyncResult {
  const written: string[] = [];
  const pruned: string[] = [];
  const warnings: string[] = [];
  try {
    const codexHome = options.codexHome ?? resolveCodexHomeDir();
    const dir = join(codexHome, "agents");
    const desired = agentRolesSyncEffective(config)
      ? enabledSubagentRoles(config.subagentRoles).filter(role => isSafeOwnedFileName(agentRoleFileName(role.id), role.id))
      : [];
    if (desired.length === 0 && !existsSync(dir)) {
      return { written, pruned, warnings };
    }
    if (existsSync(dir)) {
      const existing = lstatSync(dir);
      if (!existing.isDirectory() && !existing.isSymbolicLink()) {
        return {
          written,
          pruned,
          warnings: ["Codex agent role sync failed closed: agents is not a directory."],
        };
      }
    } else {
      mkdirSync(dir, { recursive: true });
    }
    const dirStat = statSync(dir);
    if (!dirStat.isDirectory()) {
      return {
        written,
        pruned,
        warnings: ["Codex agent role sync failed closed: agents is not a directory."],
      };
    }
    const keep = new Set(desired.map(role => agentRoleFileName(role.id)));

    for (const existing of readdirSync(dir)) {
      if (!isSafeOwnedFileName(existing)) continue;
      if (keep.has(existing)) continue;
      const path = join(dir, existing);
      if (!isOwnedRegularFile(path)) continue;
      if (!unlinkQuietly(path)) {
        warnings.push(`Could not prune ${existing}.`);
        continue;
      }
      pruned.push(existing);
    }

    for (const role of desired) {
      const file = agentRoleFileName(role.id);
      const target = join(dir, file);
      const sibling = siblingNameConflict(dir, role.id, file);
      if (sibling) {
        warnings.push(`Skipped ${file}: ${sibling} already uses name ${tomlString(role.id)}.`);
        if (inspectTarget(target) === "owned" && unlinkQuietly(target)) pruned.push(file);
        continue;
      }
      const state = inspectTarget(target);
      if (state === "conflict") {
        warnings.push(`Skipped ${file}: not owned by opencodex (missing marker).`);
        continue;
      }
      if (state === "not-file") {
        warnings.push(`Skipped ${file}: not a regular file.`);
        continue;
      }
      const tmp = `${target}.tmp-${process.pid}`;
      try {
        writeFileSync(tmp, renderRoleToml(role), { encoding: "utf8", mode: 0o644 });
        renameAtomicFile(tmp, target, undefined, "codex-agent-roles");
        written.push(file);
      } catch {
        unlinkQuietly(tmp);
        warnings.push(`Could not write ${file}.`);
      }
    }
    return { written, pruned, warnings };
  } catch {
    return {
      written,
      pruned,
      warnings: [...warnings, "Codex agent role sync failed closed."],
    };
  }
}
