import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandUserPath } from "../config";
import { defaultCodexHome } from "./home";
import { readRootTomlString } from "./paths";

const OCX_SECTION_MARKER = "# Auto-injected by opencodex";

function resolveCodexConfigPath(): string {
  const raw = process.env.CODEX_HOME?.trim();
  const home = raw ? resolve(expandUserPath(raw)) : defaultCodexHome();
  return join(home, "config.toml");
}

export type ProjectCodexConfigIssueCode = "model_providers_table" | "profile_selector" | "model_provider_root";

export interface ProjectCodexConfigWarning {
  path: string;
  code: ProjectCodexConfigIssueCode;
  /** Provider id, profile name, or model_provider value when relevant. */
  detail: string;
  message: string;
}

function hasInjectedOpenaiBaseUrl(content: string): boolean {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 1; i < rootEnd; i++) {
    if (/^\s*openai_base_url\s*=/.test(lines[i]) && lines[i - 1].includes(OCX_SECTION_MARKER)) return true;
  }
  return false;
}

/** True when global Codex config routes through the opencodex proxy. */
export function isGlobalOpencodexRoutingActive(
  codexConfigPath: string = resolveCodexConfigPath(),
  content?: string,
): boolean {
  let text = content;
  if (text === undefined) {
    if (!existsSync(codexConfigPath)) return false;
    try {
      text = readFileSync(codexConfigPath, "utf-8");
    } catch {
      return false;
    }
  }
  if (hasInjectedOpenaiBaseUrl(text)) return true;
  if (readRootTomlString(text, "model_provider") === "opencodex") return true;
  if (text.includes("[model_providers.opencodex]")) return true;
  return false;
}

export function parseTrustedProjectPathsFromCodexConfig(content: string): string[] {
  const paths: string[] = [];
  const re = /^\[projects\.(?:'([^']*)'|"([^"]*)")\]/gm;
  for (const match of content.matchAll(re)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (raw) paths.push(raw);
  }
  return paths;
}

export function analyzeProjectCodexConfig(content: string, configPath: string): ProjectCodexConfigWarning[] {
  const warnings: ProjectCodexConfigWarning[] = [];
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;

  for (let i = 0; i < lines.length; i++) {
    const table = lines[i].match(/^\s*\[model_providers\.([^\]]+)\]\s*$/);
    if (!table) continue;
    const provider = table[1]!.trim();
    if (provider === "opencodex") continue;
    warnings.push({
      path: configPath,
      code: "model_providers_table",
      detail: provider,
      message:
        `Project Codex config defines [model_providers.${provider}] (${relPath(configPath)}). `
        + "That routes this trusted project away from the OpenCodex proxy. "
        + "Remove the provider table (and any profile = line that selects it) so global routing from "
        + "~/.codex/config.toml applies.",
    });
  }

  for (let i = 0; i < rootEnd; i++) {
    const profileMatch = lines[i].match(/^\s*profile\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
    if (profileMatch) {
      const profile = parseTomlString(profileMatch[1]!);
      if (profile && profile !== "opencodex") {
        warnings.push({
          path: configPath,
          code: "profile_selector",
          detail: profile,
          message:
            `Project Codex config sets profile = "${profile}" (${relPath(configPath)}). `
            + "Profiles can bypass the OpenCodex proxy for this project. "
            + "Remove the profile line or switch to global proxy routing only.",
        });
      }
      continue;
    }
    const providerMatch = lines[i].match(/^\s*model_provider\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/);
    if (providerMatch) {
      const provider = parseTomlString(providerMatch[1]!);
      if (provider && provider !== "opencodex") {
        warnings.push({
          path: configPath,
          code: "model_provider_root",
          detail: provider,
          message:
            `Project Codex config sets model_provider = "${provider}" (${relPath(configPath)}). `
            + "Use global ~/.codex/config.toml for OpenCodex routing instead of a project-local provider override.",
        });
      }
    }
  }

  return dedupeRelatedProjectCodexWarnings(warnings);
}

/** profile/model_provider that selects an already-flagged [model_providers.X] table is one bypass, not two. */
export function dedupeRelatedProjectCodexWarnings(
  warnings: ProjectCodexConfigWarning[],
): ProjectCodexConfigWarning[] {
  const providerTables = new Set(
    warnings.filter(w => w.code === "model_providers_table").map(w => w.detail),
  );
  if (providerTables.size === 0) return warnings;
  return warnings.filter(w => {
    if (w.code === "profile_selector" && providerTables.has(w.detail)) return false;
    if (w.code === "model_provider_root" && providerTables.has(w.detail)) return false;
    return true;
  });
}

function parseTomlString(raw: string): string {
  if (raw.startsWith("\"")) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw.slice(1, -1);
}

function relPath(abs: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (home && abs.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${abs.slice(home.length).replace(/\\/g, "/")}`;
  }
  return abs;
}

export function discoverProjectCodexConfigPaths(options: {
  cwd?: string;
  codexConfigPath?: string;
  maxWalkParents?: number;
} = {}): string[] {
  const found = new Set<string>();
  const codexConfigPath = options.codexConfigPath ?? resolveCodexConfigPath();
  const addIfExists = (projectRoot: string) => {
    const path = join(resolve(projectRoot), ".codex", "config.toml");
    if (existsSync(path)) found.add(path);
  };

  let cwd = resolve(options.cwd ?? process.cwd());
  const maxWalk = options.maxWalkParents ?? 12;
  for (let depth = 0; depth < maxWalk; depth++) {
    addIfExists(cwd);
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }

  if (existsSync(codexConfigPath)) {
    try {
      const global = readFileSync(codexConfigPath, "utf-8");
      for (const projectPath of parseTrustedProjectPathsFromCodexConfig(global)) {
        addIfExists(projectPath);
      }
    } catch {
      /* ignore unreadable global config */
    }
  }

  return [...found];
}

export function collectProjectCodexConfigWarnings(options: {
  cwd?: string;
  codexConfigPath?: string;
  requireOpencodexRouting?: boolean;
} = {}): ProjectCodexConfigWarning[] {
  const codexConfigPath = options.codexConfigPath ?? resolveCodexConfigPath();
  const requireRouting = options.requireOpencodexRouting ?? true;
  if (requireRouting && !isGlobalOpencodexRoutingActive(codexConfigPath)) return [];

  const warnings: ProjectCodexConfigWarning[] = [];
  for (const path of discoverProjectCodexConfigPaths({ cwd: options.cwd, codexConfigPath })) {
    try {
      const content = readFileSync(path, "utf-8");
      warnings.push(...analyzeProjectCodexConfig(content, path));
    } catch {
      /* skip unreadable project config */
    }
  }
  return warnings;
}

export function summarizeProjectCodexIssue(warning: ProjectCodexConfigWarning): string {
  switch (warning.code) {
    case "model_providers_table":
      return `[model_providers.${warning.detail}]`;
    case "profile_selector":
      return `profile="${warning.detail}"`;
    case "model_provider_root":
      return `model_provider="${warning.detail}"`;
  }
}

function humanizeProviderDetail(detail: string): string {
  if (detail === "opencode_go") return "OpenCode Go";
  if (detail.startsWith("opencode")) return "OpenCode";
  if (detail === "opencodex") return "OpenCodex";
  return detail;
}

/** Short "why" line: what this project config overrides and where traffic goes instead. */
export function explainProjectConfigBypass(warnings: ProjectCodexConfigWarning[]): string {
  const targets = [...new Set(warnings.map(w => humanizeProviderDetail(w.detail)))];
  const via = targets.length === 1 ? targets[0]! : targets.join(" / ");
  return `Overrides OpenCodex — Codex uses ${via} for this repo instead of the proxy (~/.codex/config.toml).`;
}

export interface ProjectCodexConfigWarningGroup {
  path: string;
  issues: string[];
  bypass: string;
}

export function groupProjectCodexConfigWarningsByPath(
  warnings: ProjectCodexConfigWarning[],
): ProjectCodexConfigWarningGroup[] {
  const grouped = new Map<string, ProjectCodexConfigWarning[]>();
  for (const warning of warnings) {
    const list = grouped.get(warning.path) ?? [];
    list.push(warning);
    grouped.set(warning.path, list);
  }
  return [...grouped.entries()].map(([path, pathWarnings]) => ({
    path,
    issues: pathWarnings.map(summarizeProjectCodexIssue),
    bypass: explainProjectConfigBypass(pathWarnings),
  }));
}

export function formatProjectCodexConfigWarningsForDoctor(warnings: ProjectCodexConfigWarning[]): string[] {
  const grouped = groupProjectCodexConfigWarningsByPath(warnings);
  if (grouped.length === 0) return [];
  const lines: string[] = [];
  for (const { path, issues, bypass } of grouped) {
    lines.push(`  --     ${relPath(path)} — ${issues.join(", ")}`);
    lines.push(`         ${bypass}`);
  }
  lines.push("       fix: remove those entries so OpenCodex proxy routing applies in this project");
  return lines;
}

export function formatProjectCodexConfigWarningsForConsole(warnings: ProjectCodexConfigWarning[]): string[] {
  const grouped = groupProjectCodexConfigWarningsByPath(warnings);
  if (grouped.length === 0) return [];
  const lines = ["⚠️  Project Codex config bypasses OpenCodex:"];
  for (const { path, issues, bypass } of grouped) {
    lines.push(`    ${relPath(path)} — ${issues.join(", ")}`);
    lines.push(`    ${bypass}`);
  }
  lines.push("    fix: remove those entries so OpenCodex proxy routing applies in this project");
  return lines;
}

export function printProjectCodexConfigWarnings(
  log?: Pick<Console, "log"> | null,
  options?: Parameters<typeof collectProjectCodexConfigWarnings>[0],
): ProjectCodexConfigWarning[] {
  const warnings = collectProjectCodexConfigWarnings(options);
  if (log) {
    for (const line of formatProjectCodexConfigWarningsForConsole(warnings)) {
      log.log(line);
    }
  }
  return warnings;
}
