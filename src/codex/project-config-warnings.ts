import { existsSync, readFileSync } from "node:fs";
import path, { dirname, join, resolve } from "node:path";
import { expandUserPath } from "../config";
import { defaultCodexHome } from "./home";
import { readRootTomlString } from "./paths";

const OCX_SECTION_MARKER = "# Auto-injected by opencodex";
const DIAGNOSTICS_CACHE_TTL_MS = 30_000;

function resolveCodexConfigPath(): string {
  const raw = process.env.CODEX_HOME?.trim();
  const home = raw ? resolve(expandUserPath(raw)) : defaultCodexHome();
  return join(home, "config.toml");
}

export type ProjectCodexConfigIssueCode = "model_providers_table" | "profile_selector" | "model_provider_root";

export interface ProjectCodexConfigWarning {
  path: string;
  code: ProjectCodexConfigIssueCode;
  /** Effective provider id that bypasses OpenCodex. */
  detail: string;
  /** Profile name when the bypass is selected via profile = "…". */
  profileName?: string;
  message: string;
}

interface TomlDocument {
  root: Record<string, string>;
  sections: Map<string, Record<string, string>>;
}

let diagnosticsCache: { at: number; warnings: ProjectCodexConfigWarning[] } | null = null;

function hasInjectedOpenaiBaseUrl(content: string): boolean {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let i = 1; i < rootEnd; i++) {
    if (/^\s*openai_base_url\s*=/.test(lines[i]) && lines[i - 1].includes(OCX_SECTION_MARKER)) return true;
  }
  return false;
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

/** Lightweight TOML parse for root keys and [section] tables (Codex config shape). */
export function parseTomlDocument(content: string): TomlDocument {
  const root: Record<string, string> = {};
  const sections = new Map<string, Record<string, string>>();
  let current = root;

  for (const line of content.split("\n")) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (table) {
      const name = table[1]!.trim();
      const section = sections.get(name) ?? {};
      sections.set(name, section);
      current = section;
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*("(?:\\.|[^"])*"|'[^']*'|[^\s#]+)\s*(?:#.*)?$/);
    if (kv) current[kv[1]!] = parseTomlString(kv[2]!);
  }

  return { root, sections };
}

function profileSectionKeys(profileName: string): string[] {
  return [
    `profiles.${profileName}`,
    `profiles."${profileName}"`,
    `profiles.'${profileName}'`,
  ];
}

function readProfileModelProvider(sections: Map<string, Record<string, string>>, profileName: string): string | null {
  for (const key of profileSectionKeys(profileName)) {
    const provider = sections.get(key)?.model_provider;
    if (provider) return provider;
  }
  return null;
}

function hasModelProviderTable(sections: Map<string, Record<string, string>>, provider: string): boolean {
  return sections.has(`model_providers.${provider}`);
}

/** Built-in openai provider still routes through the proxy under Design B (marker-owned openai_base_url). */
function isProxyCompatibleProvider(provider: string): boolean {
  return provider === "opencodex" || provider === "openai";
}

export interface EffectiveProjectModelRouting {
  provider: string | null;
  profileName: string | null;
  via: "profile" | "root" | null;
}

/** Resolve the provider Codex would actually use from a project .codex/config.toml. */
export function resolveEffectiveProjectModelProvider(content: string): EffectiveProjectModelRouting {
  const { root, sections } = parseTomlDocument(content);
  const rootProfile = root.profile ?? null;
  const rootProvider = root.model_provider ?? null;

  if (rootProfile) {
    const fromProfile = readProfileModelProvider(sections, rootProfile);
    if (fromProfile) {
      return { provider: fromProfile, profileName: rootProfile, via: "profile" };
    }
    if (rootProvider) {
      return { provider: rootProvider, profileName: rootProfile, via: "root" };
    }
    return { provider: null, profileName: rootProfile, via: null };
  }

  if (rootProvider) {
    return { provider: rootProvider, profileName: null, via: "root" };
  }

  return { provider: null, profileName: null, via: null };
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
  return false;
}

export function parseTrustedProjectPathsFromCodexConfig(content: string): string[] {
  const { sections } = parseTomlDocument(content);
  const paths: string[] = [];

  for (const [name, keys] of sections) {
    const quoted = name.match(/^projects\.(?:'([^']*)'|"([^"]*)")$/);
    if (!quoted) continue;
    const raw = (quoted[1] ?? quoted[2] ?? "").trim();
    if (!raw) continue;
    if ((keys.trust_level ?? "").toLowerCase() !== "trusted") continue;
    paths.push(raw);
  }

  return paths;
}

export function analyzeProjectCodexConfig(content: string, configPath: string): ProjectCodexConfigWarning[] {
  const { sections } = parseTomlDocument(content);
  const routing = resolveEffectiveProjectModelProvider(content);
  const provider = routing.provider;

  if (!provider || isProxyCompatibleProvider(provider)) return [];

  const rel = relPath(configPath);
  if (hasModelProviderTable(sections, provider)) {
    return [{
      path: configPath,
      code: "model_providers_table",
      detail: provider,
      profileName: routing.profileName ?? undefined,
      message:
        `Project Codex config selects provider "${provider}" via `
        + `${routing.via === "profile" ? `profile = "${routing.profileName}"` : "model_provider"} and defines `
        + `[model_providers.${provider}] (${rel}). That routes this trusted project away from the OpenCodex proxy.`,
    }];
  }

  if (routing.via === "profile" && routing.profileName) {
    return [{
      path: configPath,
      code: "profile_selector",
      detail: provider,
      profileName: routing.profileName,
      message:
        `Project Codex config profile "${routing.profileName}" sets model_provider = "${provider}" (${rel}). `
        + "That routes this trusted project away from the OpenCodex proxy.",
    }];
  }

  return [{
    path: configPath,
    code: "model_provider_root",
    detail: provider,
    message:
      `Project Codex config sets model_provider = "${provider}" (${rel}). `
      + "Use global ~/.codex/config.toml for OpenCodex routing instead of a project-local provider override.",
  }];
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

/**
 * Render a path under the user's home as `~/...` for warning display.
 * Platform-correct containment (devlog 260715_cross_platform_audit/030): the old
 * lowercase prefix match had no component boundary (`C:\Users\bob2` rendered as
 * inside `~` for home `C:\Users\bob`) and case-folded on case-sensitive POSIX
 * filesystems. `relative()` carries the right case semantics per platform; reject
 * parent (`..`, `..\x`) and cross-drive (absolute) results.
 */
export function relPath(
  abs: string,
  pathApi: Pick<typeof path, "relative" | "sep" | "isAbsolute"> = path,
): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (!home) return abs;
  const rel = pathApi.relative(home, abs);
  if (rel === "") return "~";
  if (rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) return abs;
  return `~/${rel.replace(/\\/g, "/")}`;
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

export function invalidateProjectConfigDiagnosticsCache(): void {
  diagnosticsCache = null;
}

export function getCachedProjectConfigDiagnostics(): {
  warnings: ProjectCodexConfigWarning[];
  grouped: ProjectCodexConfigWarningGroup[];
} {
  const now = Date.now();
  if (!diagnosticsCache || now - diagnosticsCache.at > DIAGNOSTICS_CACHE_TTL_MS) {
    diagnosticsCache = { at: now, warnings: collectProjectCodexConfigWarnings() };
  }
  const warnings = diagnosticsCache.warnings;
  return { warnings, grouped: groupProjectCodexConfigWarningsByPath(warnings) };
}

export function summarizeProjectCodexIssue(warning: ProjectCodexConfigWarning): string {
  switch (warning.code) {
    case "model_providers_table":
      return `[model_providers.${warning.detail}]`;
    case "profile_selector":
      return warning.profileName ? `profile="${warning.profileName}"` : `model_provider="${warning.detail}"`;
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
