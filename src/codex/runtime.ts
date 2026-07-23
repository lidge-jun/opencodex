import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { codexExecInvocation, isSpawnableCodexCandidate } from "./exec-invocation";
import { redactUserPath } from "../lib/redact";

export type CodexRuntimeSource =
  | "environment"
  | "configured"
  | "shim"
  | "path"
  | "fallback";

export interface ResolvedCodexRuntime {
  command: string;
  version: string | null;
  source: CodexRuntimeSource;
}

export interface RuntimeProbeFailure {
  command: string;
  source: CodexRuntimeSource;
  reason: string;
}

export interface EffortClampDiagnostic {
  runtimePath: string;
  runtimeVersion: string | null;
  removedEfforts: string[];
  affectedModels: string[];
}

export interface ResolveCodexRuntimeResult {
  runtime: ResolvedCodexRuntime;
  failures: RuntimeProbeFailure[];
  replacedConfigured?: { from: ResolvedCodexRuntime; reason: string };
  newerAvailable?: ResolvedCodexRuntime;
}

export type RuntimeExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
    shell?: boolean;
  },
) => string;

export interface ResolveCodexRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  configDir?: string;
  execFileSync?: RuntimeExecFile;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  now?: () => number;
}

interface PersistedRuntimeState {
  version: 1;
  command: string;
  source: CodexRuntimeSource;
  selectedVersion: string | null;
  updatedAt: string;
}

const PERSIST_FILE = "codex-runtime.json";
const CLAMP_PERSIST_FILE = "codex-runtime-clamp.json";

export function codexRuntimeStatePath(configDir: string = getConfigDir()): string {
  return join(configDir, PERSIST_FILE);
}

export function codexRuntimeClampStatePath(configDir: string = getConfigDir()): string {
  return join(configDir, CLAMP_PERSIST_FILE);
}

interface PersistedClampState extends EffortClampDiagnostic {
  version: 1;
  updatedAt: string;
}

export function loadLastEffortClamp(
  deps: ResolveCodexRuntimeDeps = {},
): EffortClampDiagnostic | null {
  const configDir = deps.configDir ?? getConfigDir();
  const read = deps.readFileSync ?? ((path, encoding) => readFileSync(path, encoding));
  try {
    const raw = JSON.parse(read(codexRuntimeClampStatePath(configDir), "utf8")) as PersistedClampState;
    if (raw?.version !== 1 || !Array.isArray(raw.removedEfforts)) return null;
    return {
      runtimePath: typeof raw.runtimePath === "string" ? raw.runtimePath : "codex",
      runtimeVersion: typeof raw.runtimeVersion === "string" ? raw.runtimeVersion : null,
      removedEfforts: raw.removedEfforts.filter((item): item is string => typeof item === "string"),
      affectedModels: Array.isArray(raw.affectedModels)
        ? raw.affectedModels.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function persistEffortClamp(
  diagnostic: EffortClampDiagnostic | null,
  deps: ResolveCodexRuntimeDeps = {},
): void {
  const configDir = deps.configDir ?? getConfigDir();
  const path = codexRuntimeClampStatePath(configDir);
  if (!diagnostic || diagnostic.removedEfforts.length === 0) {
    try {
      unlinkSync(path);
    } catch {
      /* absent is fine */
    }
    return;
  }
  const payload: PersistedClampState = {
    version: 1,
    updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    runtimePath: diagnostic.runtimePath,
    runtimeVersion: diagnostic.runtimeVersion,
    removedEfforts: diagnostic.removedEfforts,
    affectedModels: diagnostic.affectedModels,
  };
  atomicWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export function displayCodexRuntimePath(command: string): string {
  if (command === "codex") return "codex";
  return redactUserPath(command);
}

export function parseCodexVersionOutput(raw: string): string | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const match = text.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

/** Compare dotted Codex versions. Returns negative if a < b. */
export function compareCodexVersions(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const parse = (value: string) => {
    const [core, pre = ""] = value.split("-", 2);
    const parts = (core ?? "").split(".").map(part => Number.parseInt(part, 10) || 0);
    return { parts, pre };
  };
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  return left.pre.localeCompare(right.pre);
}

export function loadPersistedCodexRuntime(
  deps: ResolveCodexRuntimeDeps = {},
): PersistedRuntimeState | null {
  const configDir = deps.configDir ?? getConfigDir();
  const read = deps.readFileSync ?? ((path, encoding) => readFileSync(path, encoding));
  try {
    const raw = JSON.parse(read(codexRuntimeStatePath(configDir), "utf8")) as PersistedRuntimeState;
    if (raw?.version !== 1 || typeof raw.command !== "string" || !raw.command.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

export function persistCodexRuntime(
  runtime: ResolvedCodexRuntime,
  deps: ResolveCodexRuntimeDeps = {},
): void {
  const configDir = deps.configDir ?? getConfigDir();
  const payload: PersistedRuntimeState = {
    version: 1,
    command: runtime.command,
    source: runtime.source,
    selectedVersion: runtime.version,
    updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  atomicWriteFile(codexRuntimeStatePath(configDir), `${JSON.stringify(payload, null, 2)}\n`);
}

function probeVersion(
  command: string,
  deps: ResolveCodexRuntimeDeps,
): { ok: true; version: string | null } | { ok: false; reason: string } {
  const platform = deps.platform ?? process.platform;
  if (command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command)) {
    const exists = deps.existsSync ?? existsSync;
    if (!exists(command)) return { ok: false, reason: "path does not exist" };
    if (!isSpawnableCodexCandidate(command, platform)) {
      return { ok: false, reason: "not a spawnable Codex launcher on this platform" };
    }
  }
  const execFile = deps.execFileSync ?? (execFileSync as unknown as RuntimeExecFile);
  try {
    const invocation = codexExecInvocation(command, platform);
    const output = execFile(invocation.file, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8_000,
      windowsHide: true,
      shell: invocation.shell,
    });
    return { ok: true, version: parseCodexVersionOutput(output) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `failed --version (${message.slice(0, 160)})` };
  }
}

function shimCandidates(deps: ResolveCodexRuntimeDeps): string[] {
  const configDir = deps.configDir ?? getConfigDir();
  const read = deps.readFileSync ?? ((path, encoding) => readFileSync(path, encoding));
  const platform = deps.platform ?? process.platform;
  try {
    const state = JSON.parse(read(join(configDir, "codex-shim.json"), "utf8")) as {
      wrapperPath?: unknown;
      originalPath?: unknown;
      backupPath?: unknown;
      wrappers?: Array<{ wrapperPath?: unknown; originalPath?: unknown; backupPath?: unknown }>;
    };
    const files = Array.isArray(state.wrappers) && state.wrappers.length > 0 ? state.wrappers : [state];
    const out: string[] = [];
    for (const file of files) {
      for (const value of [file.backupPath, file.originalPath, file.wrapperPath]) {
        if (typeof value !== "string" || value.length === 0) continue;
        if (!isSpawnableCodexCandidate(value, platform)) continue;
        out.push(value);
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

function pathCandidates(deps: ResolveCodexRuntimeDeps): string[] {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const out: string[] = [];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (platform === "win32") {
      out.push(join(dir, "codex.exe"), join(dir, "codex.cmd"));
    } else {
      out.push(join(dir, "codex"));
    }
  }
  return [...new Set(out)];
}

interface RankedCandidate {
  command: string;
  source: CodexRuntimeSource;
}

function tryCandidate(
  candidate: RankedCandidate,
  failures: RuntimeProbeFailure[],
  deps: ResolveCodexRuntimeDeps,
): ResolvedCodexRuntime | null {
  const probed = probeVersion(candidate.command, deps);
  if (!probed.ok) {
    failures.push({ command: candidate.command, source: candidate.source, reason: probed.reason });
    return null;
  }
  return {
    command: candidate.command,
    version: probed.version,
    source: candidate.source,
  };
}

/**
 * Resolve the single Codex runtime OpenCodex should use for sync, clamp, and probes.
 */
export function resolveCodexRuntime(deps: ResolveCodexRuntimeDeps = {}): ResolveCodexRuntimeResult {
  const env = deps.env ?? process.env;
  const failures: RuntimeProbeFailure[] = [];
  const ordered: RankedCandidate[] = [];

  const envPath = env.CODEX_CLI_PATH?.trim();
  if (envPath) ordered.push({ command: envPath, source: "environment" });

  const persisted = loadPersistedCodexRuntime(deps);
  if (persisted?.command) {
    ordered.push({ command: persisted.command, source: "configured" });
  }

  for (const command of shimCandidates(deps)) {
    ordered.push({ command, source: "shim" });
  }
  for (const command of pathCandidates(deps)) {
    ordered.push({ command, source: "path" });
  }
  ordered.push({ command: "codex", source: "fallback" });

  const seen = new Set<string>();
  const valid: ResolvedCodexRuntime[] = [];
  for (const candidate of ordered) {
    const key = candidate.command.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = tryCandidate(candidate, failures, deps);
    if (resolved) valid.push(resolved);
  }

  if (valid.length === 0) {
    return {
      runtime: { command: "codex", version: null, source: "fallback" },
      failures,
    };
  }

  // Prefer first valid in priority order (environment → configured → shim → path → fallback).
  let selected = valid[0]!;
  let replacedConfigured: ResolveCodexRuntimeResult["replacedConfigured"];

  // If environment is invalid but configured is valid, configured wins among remaining.
  // (Already handled by order.) If configured was preferred but failed, record replacement.
  if (persisted?.command) {
    const configuredStillValid = valid.some(
      item => item.command === persisted.command && item.source === "configured",
    );
    if (!configuredStillValid) {
      const replacement = valid.find(item => item.command !== persisted.command) ?? selected;
      replacedConfigured = {
        from: {
          command: persisted.command,
          version: persisted.selectedVersion,
          source: "configured",
        },
        reason: failures.find(item => item.command === persisted.command)?.reason
          ?? "configured runtime is no longer valid",
      };
      selected = replacement;
    } else {
      // Stick to configured even if a later PATH entry appears first after env miss —
      // configured is intentionally second priority and must survive new terminals.
      selected = valid.find(item => item.command === persisted.command) ?? selected;
    }
  }

  // Environment always wins when valid.
  const envValid = envPath
    ? valid.find(item => item.command === envPath && item.source === "environment")
    : undefined;
  if (envValid) selected = envValid;

  const newerAvailable = valid
    .filter(item => item.command !== selected.command)
    .sort((a, b) => compareCodexVersions(b.version, a.version))[0];
  const newer =
    newerAvailable && compareCodexVersions(newerAvailable.version, selected.version) > 0
      ? newerAvailable
      : undefined;

  return {
    runtime: selected,
    failures,
    replacedConfigured,
    newerAvailable: newer,
  };
}

/** Resolve and persist a successful selection (unless source is ephemeral fallback-only with no path). */
export function resolveAndPersistCodexRuntime(
  deps: ResolveCodexRuntimeDeps = {},
): ResolveCodexRuntimeResult {
  const result = resolveCodexRuntime(deps);
  if (result.runtime.command && result.runtime.source !== "fallback") {
    try {
      persistCodexRuntime(result.runtime, deps);
    } catch {
      /* persistence best-effort */
    }
  }
  return result;
}

export function formatRuntimeLogLine(runtime: ResolvedCodexRuntime): string {
  const path = displayCodexRuntimePath(runtime.command);
  return `[opencodex] Codex runtime: ${path} (version=${runtime.version ?? "unknown"}, source=${runtime.source})`;
}

export function formatClampLogLines(diagnostic: EffortClampDiagnostic): string[] {
  const efforts = diagnostic.removedEfforts.join(", ");
  return [
    `[opencodex] Removed unsupported reasoning efforts: ${efforts}`,
    "[opencodex] Run ocx doctor for diagnosis and recovery.",
  ];
}
