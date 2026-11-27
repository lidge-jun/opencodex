/**
 * Manage per-client `opencodex-advisor` MCP registration, anti-forgetting hooks/skills, and
 * bidirectional Advisor <-> Routing synchronization for compatible external coding clients.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import {
  fingerprint,
  integrationsDir,
  readRecords,
  writeRecord,
  type OwnershipRecord,
} from "../integrations/ownership";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { isBunTestFileProcess } from "../lib/test-home-guard";
import type { OcxConfig } from "../types";
import {
  ADVISOR_MCP_CLIENT_IDS,
  advisorRunnable,
  isAdvisorMcpClientId,
  normalizeAdvisorMcpClients,
  resolveAdvisorSettings,
  type AdvisorMcpClientId,
} from "./settings";

export const ADVISOR_MCP_SERVER_NAME = "opencodex-advisor";
export const ADVISOR_MCP_TIMEOUT_MS = 900_000;
export const CLINE_ADVISOR_MCP_TIMEOUT_SECONDS = 900;
export const ADVISOR_SKILL_MARKER = "<!-- ocx-managed:opencodex-advisor-skill:v1 -->";
export const ADVISOR_HOOK_MARKER = "# ocx-managed:opencodex-advisor-hook:v1";
const LONG_MCP_CONSULT_WAIT_MS = "240000";

export { ADVISOR_MCP_CLIENT_IDS, isAdvisorMcpClientId, normalizeAdvisorMcpClients, type AdvisorMcpClientId };

export type AdvisorMcpTrustStatus =
  | "trusted"
  | "action_required"
  | "needs_confirmation"
  | "auto_enabled"
  | "not_mounted";

export interface AdvisorMcpClientStatus {
  clientId: AdvisorMcpClientId;
  label: string;
  detected: boolean;
  routed: boolean;
  mounted: boolean;
  selected: boolean;
  defaultAutoMount: boolean;
  supportsHooks: boolean;
  supportsSkills: boolean;
  hooksMounted: boolean;
  skillMounted: boolean;
  trustStatus: AdvisorMcpTrustStatus;
  configPath: string;
  hookConfigPath?: string;
  skillPath?: string;
  trustNoteZh: string;
  trustNoteEn: string;
}

export interface AdvisorMcpSyncOptions {
  homeDir?: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  isStandaloneExecutable?: boolean;
  execPath?: string;
  sourceEntrypoint?: string;
}

export interface AdvisorMcpSyncResult {
  mounted: AdvisorMcpClientId[];
  unmounted: AdvisorMcpClientId[];
  errors: Array<{ clientId: AdvisorMcpClientId; message: string }>;
  statuses: AdvisorMcpClientStatus[];
}

interface ResolvedClientPaths {
  rootDir: string;
  mcpConfigPath: string;
  sharedWithRouting: boolean;
  hookConfigPath?: string;
  hookScriptPath?: string;
  skillPath?: string;
  approvalsPath?: string;
}

interface ClientSpec {
  id: AdvisorMcpClientId;
  label: string;
  defaultAutoMount: boolean;
  mcpContainer: "mcpServers" | "mcp";
  entryFormat: "workbuddy" | "qoder" | "commandcode" | "cline" | "opencode" | "claude";
  supportsHooks: boolean;
  supportsSkills: boolean;
  resolvePaths: (home: string, env: NodeJS.ProcessEnv) => ResolvedClientPaths;
  trustNoteZh: string;
  trustNoteEn: string;
}

type JsonObj = Record<string, unknown>;

function canonicalClientPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(current), ...missing); }
    catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function isPlainObject(value: unknown): value is JsonObj {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function workbuddyHome(id: "workbuddy" | "workbuddy-ai", home: string, env: NodeJS.ProcessEnv): string {
  const override = env.WORKBUDDY_CONFIG_DIR?.trim() || env.CODEBUDDY_CONFIG_DIR?.trim();
  return override ? resolve(home, override) : join(home, `.${id}`);
}

function qoderHome(id: "qoder" | "qoder-cn", home: string, env: NodeJS.ProcessEnv): string {
  if (id === "qoder-cn") {
    const override = env.QODERCN_CONFIG_DIR?.trim();
    return override ? resolve(home, override) : join(home, ".qoder-cn");
  }
  const override = env.QODER_CONFIG_DIR?.trim();
  return override ? resolve(home, override) : join(home, ".qoder");
}

function clineSettingsDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLINE_DIR?.trim();
  const base = override ? resolve(home, override) : join(home, ".cline");
  return join(base, "data", "settings");
}

function opencodeConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim() ? resolve(home, env.XDG_CONFIG_HOME.trim()) : join(home, ".config");
  return join(xdg, "opencode", "opencode.json");
}

const CLIENT_SPECS: Record<AdvisorMcpClientId, ClientSpec> = {
  workbuddy: {
    id: "workbuddy",
    label: "WorkBuddy (CN)",
    defaultAutoMount: true,
    mcpContainer: "mcpServers",
    entryFormat: "workbuddy",
    supportsHooks: true,
    supportsSkills: true,
    resolvePaths: (home, env) => {
      const rootDir = workbuddyHome("workbuddy", home, env);
      return {
        rootDir,
        mcpConfigPath: join(rootDir, "mcp.json"),
        sharedWithRouting: false,
        hookConfigPath: join(rootDir, "settings.json"),
        hookScriptPath: join(rootDir, "hooks", "opencodex-advisor-notice.sh"),
        skillPath: join(rootDir, "skills", ADVISOR_MCP_SERVER_NAME, "SKILL.md"),
        approvalsPath: join(rootDir, "mcp-approvals.json"),
      };
    },
    trustNoteZh: "写入 mcp.json 与 Prompt Hook 后，仍需在 WorkBuddy 的 MCP 管理页对该服务点击一次「信任」才可生效。",
    trustNoteEn: "After mounting mcp.json and the prompt hook, click Trust once in WorkBuddy's MCP manager before first use.",
  },
  "workbuddy-ai": {
    id: "workbuddy-ai",
    label: "WorkBuddy AI",
    defaultAutoMount: true,
    mcpContainer: "mcpServers",
    entryFormat: "workbuddy",
    supportsHooks: true,
    supportsSkills: true,
    resolvePaths: (home, env) => {
      const rootDir = workbuddyHome("workbuddy-ai", home, env);
      return {
        rootDir,
        mcpConfigPath: join(rootDir, "mcp.json"),
        sharedWithRouting: false,
        hookConfigPath: join(rootDir, "settings.json"),
        hookScriptPath: join(rootDir, "hooks", "opencodex-advisor-notice.sh"),
        skillPath: join(rootDir, "skills", ADVISOR_MCP_SERVER_NAME, "SKILL.md"),
        approvalsPath: join(rootDir, "mcp-approvals.json"),
      };
    },
    trustNoteZh: "写入 mcp.json 与 Prompt Hook 后，仍需在 WorkBuddy AI 的 MCP 管理页对该服务点击一次「信任」才可生效。",
    trustNoteEn: "After mounting mcp.json and the prompt hook, click Trust once in WorkBuddy AI's MCP manager before first use.",
  },
  qoder: {
    id: "qoder",
    label: "Qoder",
    defaultAutoMount: true,
    mcpContainer: "mcpServers",
    entryFormat: "qoder",
    supportsHooks: true,
    supportsSkills: true,
    resolvePaths: (home, env) => {
      const rootDir = qoderHome("qoder", home, env);
      return {
        rootDir,
        mcpConfigPath: join(rootDir, "settings.json"),
        sharedWithRouting: true,
        hookConfigPath: join(rootDir, "settings.json"),
        hookScriptPath: join(rootDir, "hooks", "opencodex-advisor-notice.sh"),
        skillPath: join(rootDir, "skills", ADVISOR_MCP_SERVER_NAME, "SKILL.md"),
      };
    },
    trustNoteZh: "已写入 Qoder settings.json（mcpServers 与 UserPromptSubmit 防遗忘 Hook）及 skills/opencodex-advisor/SKILL.md；首次使用请在 Qoder 设置 -> MCP 页确认已启用且允许调用。",
    trustNoteEn: "Written to Qoder settings.json (mcpServers + UserPromptSubmit hook) and skills/opencodex-advisor/SKILL.md; verify it is enabled in Qoder Settings -> MCP.",
  },
  "qoder-cn": {
    id: "qoder-cn",
    label: "Qoder CN",
    defaultAutoMount: true,
    mcpContainer: "mcpServers",
    entryFormat: "qoder",
    supportsHooks: true,
    supportsSkills: true,
    resolvePaths: (home, env) => {
      const rootDir = qoderHome("qoder-cn", home, env);
      return {
        rootDir,
        mcpConfigPath: join(rootDir, "settings.json"),
        sharedWithRouting: true,
        hookConfigPath: join(rootDir, "settings.json"),
        hookScriptPath: join(rootDir, "hooks", "opencodex-advisor-notice.sh"),
        skillPath: join(rootDir, "skills", ADVISOR_MCP_SERVER_NAME, "SKILL.md"),
      };
    },
    trustNoteZh: "已写入 Qoder CN settings.json（mcpServers 与 UserPromptSubmit 防遗忘 Hook）及 skills/opencodex-advisor/SKILL.md；首次使用请在 Qoder CN 设置 -> MCP 页确认已启用且允许调用。",
    trustNoteEn: "Written to Qoder CN settings.json (mcpServers + UserPromptSubmit hook) and skills/opencodex-advisor/SKILL.md; verify it is enabled in Qoder CN Settings -> MCP.",
  },
  commandcode: {
    id: "commandcode",
    label: "Command Code",
    defaultAutoMount: true,
    mcpContainer: "mcpServers",
    entryFormat: "commandcode",
    supportsHooks: false,
    supportsSkills: false,
    resolvePaths: (home, env) => {
      const override = env.COMMANDCODE_CONFIG_DIR?.trim();
      const rootDir = override ? resolve(home, override) : join(home, ".commandcode");
      return {
        rootDir,
        mcpConfigPath: join(rootDir, "mcp.json"),
        sharedWithRouting: false,
      };
    },
    trustNoteZh: "已写入 Command Code mcp.json；若客户端开启工具确认，请允许 opencodex-advisor。",
    trustNoteEn: "Written to Command Code mcp.json; approve opencodex-advisor if prompted on first call.",
  },
  cline: {
    id: "cline",
    label: "Cline CLI",
    defaultAutoMount: true,
    mcpContainer: "mcpServers",
    entryFormat: "cline",
    supportsHooks: false,
    supportsSkills: false,
    resolvePaths: (home, env) => {
      const settingsDir = clineSettingsDir(home, env);
      return {
        rootDir: dirname(dirname(settingsDir)),
        mcpConfigPath: join(settingsDir, "cline_mcp_settings.json"),
        sharedWithRouting: false,
      };
    },
    trustNoteZh: "已写入 cline_mcp_settings.json（timeout: 900 秒）；首次调用时请在 Cline 中确认允许 consult_advisor（如需自动放行请在 Cline 设置中自行开启）。",
    trustNoteEn: "Written to cline_mcp_settings.json (timeout: 900s); approve consult_advisor when prompted in Cline (or opt into auto-approve in Cline settings).",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    defaultAutoMount: true,
    mcpContainer: "mcp",
    entryFormat: "opencode",
    supportsHooks: false,
    supportsSkills: true,
    resolvePaths: (home, env) => {
      const cfgPath = opencodeConfigFile(home, env);
      return {
        rootDir: dirname(cfgPath),
        mcpConfigPath: cfgPath,
        sharedWithRouting: true,
        skillPath: join(dirname(cfgPath), "skills", ADVISOR_MCP_SERVER_NAME, "SKILL.md"),
      };
    },
    trustNoteZh: "已写入 opencode.json 的 mcp.opencodex-advisor（enabled: true, timeout: 900000ms），并同步安装防遗忘 Skill。",
    trustNoteEn: "Written to opencode.json under mcp.opencodex-advisor (enabled: true, timeout: 900000ms) alongside the reminder Skill.",
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    defaultAutoMount: false,
    mcpContainer: "mcpServers",
    entryFormat: "claude",
    supportsHooks: false,
    supportsSkills: true,
    resolvePaths: (home, env) => {
      const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() ? resolve(home, env.CLAUDE_CONFIG_DIR.trim()) : join(home, ".claude");
      const claudeJson = env.CLAUDE_CONFIG_DIR?.trim() ? join(claudeDir, ".claude.json") : join(home, ".claude.json");
      return {
        rootDir: claudeDir,
        mcpConfigPath: claudeJson,
        sharedWithRouting: false,
        skillPath: join(claudeDir, "skills", ADVISOR_MCP_SERVER_NAME, "SKILL.md"),
      };
    },
    trustNoteZh: "Claude Code 走 OpenCodex 代理时已内置原生 advisor 工具；如需同时挂载外部 MCP，首次启动需在 CLI 中确认信任。",
    trustNoteEn: "Claude Code already receives built-in proxy advisor when routed; enabling external MCP requires confirming it on next launch.",
  },
};

function resolveSafeHome(options?: AdvisorMcpSyncOptions): string | undefined {
  if (options?.homeDir) return options.homeDir;
  if (process.env.OCX_TEST_HOME_GUARD === "1" || isBunTestFileProcess()) return undefined;
  return homedir();
}

/**
 * Client config-directory overrides (QODER_CONFIG_DIR, WORKBUDDY_CONFIG_DIR, ...) come from the real environment only
 * when the caller also uses the real home. An explicit homeDir (tests, previews) without an explicit env never picks up
 * the host's overrides, so it cannot reach a real client configuration.
 */
function advisorClientEnv(options?: AdvisorMcpSyncOptions): NodeJS.ProcessEnv {
  return options?.env ?? (options?.homeDir ? {} : process.env);
}

function resolveOpencodeConfigDir(options?: AdvisorMcpSyncOptions): string {
  if (options?.configDir) return resolve(options.configDir);
  const envHome = options?.env?.OPENCODEX_HOME?.trim();
  if (envHome) {
    const baseHome = options?.homeDir ?? homedir();
    if (envHome === "~") return resolve(baseHome);
    if (envHome.startsWith("~/") || envHome.startsWith("~\\")) {
      return resolve(baseHome, envHome.slice(2));
    }
    return resolve(envHome);
  }
  if (options?.homeDir) return resolve(options.homeDir, ".opencodex");
  return resolve(getConfigDir());
}

export function advisorCommandArgs(
  configDir: string,
  options?: AdvisorMcpSyncOptions,
): { command: string; args: string[]; env: Record<string, string> } {
  const cliEntry = options?.sourceEntrypoint ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.ts");
  const args = selfLaunchArgv(["advisor", "mcp"], {
    ...(options?.isStandaloneExecutable !== undefined ? { isStandaloneExecutable: options.isStandaloneExecutable } : {}),
    sourceEntrypoint: cliEntry,
  });
  return {
    command: options?.execPath ?? process.execPath,
    args,
    env: {
      OPENCODEX_HOME: configDir,
      NO_PROXY: "localhost,127.0.0.1,::1,*.local",
      no_proxy: "localhost,127.0.0.1,::1,*.local",
    },
  };
}

function buildMcpEntry(spec: ClientSpec, configDir: string, options?: AdvisorMcpSyncOptions): JsonObj {
  const { command, args, env } = advisorCommandArgs(configDir, options);
  switch (spec.entryFormat) {
    case "workbuddy":
      return {
        command,
        args,
        env: { ...env, OCX_ADVISOR_MCP_WAIT_MS: LONG_MCP_CONSULT_WAIT_MS },
        timeout: ADVISOR_MCP_TIMEOUT_MS,
        description: "OpenCodex Advisor MCP server (consult the configured stronger expert model)",
      };
    case "qoder":
      return {
        transport: "stdio",
        command,
        args,
        env,
      };
    case "commandcode":
      return { command, args, env };
    case "cline":
      return {
        command,
        args,
        env: { ...env, OCX_ADVISOR_MCP_WAIT_MS: LONG_MCP_CONSULT_WAIT_MS },
        timeout: CLINE_ADVISOR_MCP_TIMEOUT_SECONDS,
        disabled: false,
      };
    case "opencode":
      return {
        type: "local",
        command: [command, ...args],
        environment: { ...env, OCX_ADVISOR_MCP_WAIT_MS: LONG_MCP_CONSULT_WAIT_MS },
        timeout: ADVISOR_MCP_TIMEOUT_MS,
        enabled: true,
      };
    case "claude":
      return {
        type: "stdio",
        command,
        args,
        env,
      };
  }
}

function readJsonObject(path: string): { text: string | null; doc: JsonObj | null; parseError: boolean } {
  if (!existsSync(path)) return { text: null, doc: {}, parseError: false };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { text: null, doc: null, parseError: true };
    const text = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return { text, doc: null, parseError: true };
    return { text, doc: parsed, parseError: false };
  } catch {
    return { text: null, doc: null, parseError: true };
  }
}

function backupOnceBeforeEdit(configDir: string, clientId: AdvisorMcpClientId, targetPath: string, text: string | null): void {
  if (text === null) return;
  const backupDir = join(configDir, "advisor-mcp-backups", clientId);
  const backupPath = join(backupDir, `${basename(targetPath)}.bak`);
  if (existsSync(backupPath)) return;
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  atomicWriteFile(backupPath, text);
}

/**
 * When Advisor MCP touches a JSON file already owned by OpenCodex Routing (Qoder/Qoder CN/OpenCode),
 * update the recorded fileFingerprint ONLY when no external edit occurred prior to our change so
 * the Routing dashboard stays in `current` instead of falsely warning about drift.
 */
function syncOwnershipFingerprintIfClean(
  configDir: string,
  clientId: AdvisorMcpClientId,
  configPath: string,
  beforeText: string | null,
  afterText: string,
): void {
  if (beforeText === null) return;
  const dir = integrationsDir(configDir);
  const records = readRecords(dir);
  const record = records[clientId as keyof typeof records] as OwnershipRecord | undefined;
  if (!record || record.configPath !== configPath) return;
  const beforeFp = fingerprint(beforeText);
  if (record.fileFingerprint !== beforeFp) return;
  const afterFp = fingerprint(afterText);
  // The ownership record follows the file, so Routing does not read Advisor's edit as a conflict. The Undo journal
  // deliberately does not: restoring the pre-routing snapshot would also remove Advisor's MCP entry and hooks, so Undo
  // must see this edit as drift and ask before replacing the file (it backs the current file up first).
  writeRecord({ ...record, fileFingerprint: afterFp }, dir);
}

/** POSIX single-quoting: no expansion, command substitution or word splitting happens inside the quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildNoticeHookScript(configDir: string, execPath = process.execPath): string {
  const configFileLiteral = shellQuote(join(configDir, "config.json"));
  const bunLiteral = shellQuote(execPath);
  return `#!/bin/sh
${ADVISOR_HOOK_MARKER}
# Remind external client models that OpenCodex Advisor MCP (\`consult_advisor\`) is active.
set -eu

STDIN_PAYLOAD=""
if [ ! -t 0 ]; then
  STDIN_PAYLOAD=$(cat 2>/dev/null || true)
fi

BUN_BIN=${bunLiteral}
CFG_PATH=${configFileLiteral}
SESSION_ID=""
PROXY_PORT="10100"

[ -f "$CFG_PATH" ] && [ -x "$BUN_BIN" ] || exit 0
if [ -f "$CFG_PATH" ] && [ -x "$BUN_BIN" ]; then
  META=$(BUN_BE_BUN=1 HOOK_STDIN="$STDIN_PAYLOAD" OCX_CFG="$CFG_PATH" "$BUN_BIN" -e '
    import { readFileSync } from "node:fs";
    let ok = "0";
    let port = "10100";
    try {
      const cfg = JSON.parse(readFileSync(process.env.OCX_CFG || "", "utf8"));
      if (typeof cfg?.port === "number" && cfg.port > 0) port = String(cfg.port);
      const adv = cfg?.advisor;
      if (adv?.enabled === true && typeof adv?.model === "string" && adv.model.trim() !== "" && adv?.contextSharingConsent === "v1") ok = "1";
    } catch { /* ignore unreadable config */ }
    let sid = "";
    try {
      const parsed = JSON.parse(process.env.HOOK_STDIN || "{}");
      if (typeof parsed?.session_id === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(parsed.session_id)) {
        sid = parsed.session_id;
      }
    } catch { /* ignore malformed hook stdin */ }
    console.log(ok + "\\t" + port + "\\t" + sid);
  ' 2>/dev/null || echo "0\t10100\t")
  ADVISOR_OK=$(printf '%s' "$META" | cut -f1)
  PROXY_PORT=$(printf '%s' "$META" | cut -f2)
  SESSION_ID=$(printf '%s' "$META" | cut -f3)
  [ "$ADVISOR_OK" = "1" ] || exit 0
fi

curl -sS --noproxy '*' --max-time 0.3 "http://127.0.0.1:\${PROXY_PORT}/healthz" >/dev/null 2>&1 || exit 0

cat <<'EOF'
[opencodex-advisor] The stronger OpenCodex expert advisor MCP tool \`consult_advisor\` (MCP server \`opencodex-advisor\` / lazy tool \`mcp__opencodex_advisor__consult_advisor\` or \`mcp__opencodex-advisor__consult_advisor\`) is active and ready.
Consult it PROACTIVELY (not only when asked) before committing to a complex/high-risk architecture design, after 2 failed repair attempts on the same issue, or for final verification. If MCP lazy-loading is active, use \`mcp_get\` / \`mcp_call\` on \`mcp__opencodex_advisor__consult_advisor\` with a focused \`question\` and optional \`context\`.
EOF
if [ -n "$SESSION_ID" ]; then
  printf 'Pass sessionId="%s" when available. In full-context mode, OpenCodex may attach a matching local session transcript if found. ' "$SESSION_ID"
else
  printf 'In full-context mode, OpenCodex may attach a matching local session transcript when a session or task ID is available. '
fi
cat <<'EOF'
If it returns status="in_progress" with nextCallArguments ({ "consultationId": "...", "afterElapsedMs": <elapsedMs> }), immediately call it again with nextCallArguments to keep waiting cleanly until finished.
EOF
`;
}

const ADVISOR_SKILL_CONTENT = `---
name: opencodex-advisor
description: Consult the stronger OpenCodex Advisor expert model proactively when making tricky architectural decisions, after 2 failed repair attempts, or before concluding high-risk tasks.
---
${ADVISOR_SKILL_MARKER}

# OpenCodex Advisor (\`consult_advisor\`)

You have access to the stronger OpenCodex Advisor model via \`consult_advisor\` under MCP server \`opencodex-advisor\` (in clients with MCP lazy-loading such as Qoder, call \`mcp_get\` / \`mcp_call\` with \`mcp__opencodex_advisor__consult_advisor\` or \`mcp__opencodex-advisor__consult_advisor\`).

## When to consult proactively
1. **Before locking a complex/high-risk architecture plan**: concurrency/state-machine edge cases, multi-process synchronization, cross-file refactors.
2. **Stuck debugging**: after 2 repair attempts hit the same or similar error — do not blindly guess a 3rd fix before getting an independent review.
3. **Final verification**: before declaring a non-trivial fix complete.

## How to invoke
- Direct MCP clients: call \`consult_advisor({ question, context?, sessionId? })\`.
- Lazy-loading MCP clients (e.g. Qoder): call \`mcp_get({ toolName: "mcp__opencodex_advisor__consult_advisor" })\` or \`mcp_call({ toolName: "mcp__opencodex_advisor__consult_advisor", arguments: { question, context?, sessionId? } })\`.
- Pass \`sessionId\` when available. In full-context mode, OpenCodex may attach a matching local session transcript if found.
- If the call returns \`status: "in_progress"\` with \`consultationId\` and \`elapsedMs\`, immediately poll again with \`{ "consultationId": "...", "afterElapsedMs": <elapsedMs> }\` (updating \`afterElapsedMs\` each round avoids duplicate-tool-call guards).
`;

/** The hook command OpenCodex registers: the quoted script path, so spaces and shell metacharacters stay literal. */
export function advisorHookCommand(hookScriptPath: string): string {
  return shellQuote(hookScriptPath);
}

/** A hook item running exactly this command. */
function isHookItemWithCommand(item: unknown, command: string): boolean {
  return isPlainObject(item) && typeof item.command === "string" && item.command === command;
}

/** Whether any group runs the Advisor hook command for this script path (used for status only). */
function entryMatchesAdvisorHook(entry: unknown, hookScriptPath: string): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(item => isHookItemWithCommand(item, advisorHookCommand(hookScriptPath)));
}

/**
 * What OpenCodex installed for each client besides the MCP entry: the hook registration (hook config file and exact
 * command), the hook script and the skill file. A registration OpenCodex did not record is the user's and is never
 * rewritten or removed, like an unrecorded MCP entry.
 */
const ADVISOR_ARTIFACT_OWNERSHIP_FILE = "advisor-hook-registrations.json";
/** `scriptHookConfigPath` is the hook config that may run the script, recorded even when the registration is the user's. */
interface OwnedArtifacts {
  hookConfigPath?: string;
  command?: string;
  hookScriptPath?: string;
  hookScriptSha256?: string;
  scriptHookConfigPath?: string;
  skillPath?: string;
  skillSha256?: string;
}
type OwnedArtifactRecords = Record<string, OwnedArtifacts>;
const ARTIFACT_FIELDS = ["hookConfigPath", "command", "hookScriptPath", "hookScriptSha256", "scriptHookConfigPath", "skillPath", "skillSha256"] as const;

function contentSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A regular, non-symlink file's text; null when missing, undefined when it is something else or unreadable. */
function readPlainTextFile(path: string): string | null | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return readFileSync(path, "utf8");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? null : undefined;
  }
}

/**
 * A hook script or skill file is OpenCodex's only when a record names this path with the hash of exactly this content;
 * a marker alone is not ownership. "same" is unrecorded content identical to what OpenCodex would write.
 */
function managedFileState(
  artifacts: OwnedArtifactRecords, path: string, desired: string, kind: "hook" | "skill",
): "missing" | "owned" | "same" | "foreign" {
  const text = readPlainTextFile(path);
  if (text === null) return "missing";
  if (text === undefined) return "foreign";
  const target = canonicalClientPath(path);
  const sha = contentSha256(text);
  const recorded = Object.values(artifacts).some(record => kind === "hook"
    ? !!record.hookScriptPath && canonicalClientPath(record.hookScriptPath) === target && record.hookScriptSha256 === sha
    : !!record.skillPath && canonicalClientPath(record.skillPath) === target && record.skillSha256 === sha);
  if (recorded) return "owned";
  return text === desired ? "same" : "foreign";
}

function readOwnedArtifacts(configDir: string): OwnedArtifactRecords {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, ADVISOR_ARTIFACT_OWNERSHIP_FILE), "utf8")) as unknown;
    if (!isPlainObject(parsed)) return {};
    const owned: OwnedArtifactRecords = {};
    for (const [clientId, value] of Object.entries(parsed)) {
      if (!isPlainObject(value)) continue;
      const record: OwnedArtifacts = {};
      for (const key of ARTIFACT_FIELDS) if (typeof value[key] === "string") record[key] = value[key];
      owned[clientId] = record;
    }
    return owned;
  } catch {
    return {};
  }
}

function writeOwnedArtifacts(configDir: string, owned: OwnedArtifactRecords): void {
  const kept = Object.fromEntries(Object.entries(owned).filter(([, record]) => Object.keys(record).length > 0));
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  atomicWriteFile(join(configDir, ADVISOR_ARTIFACT_OWNERSHIP_FILE), `${JSON.stringify(kept, null, 2)}\n`);
}

/** The single-command group OpenCodex appends to `UserPromptSubmit`. */
function advisorHookGroupText(command: string): string {
  return JSON.stringify({ hooks: [{ type: "command", command }] });
}

/** Where `command` appears: whole groups exactly as OpenCodex writes them, and how many other items run it. */
/** The script path inside a command OpenCodex built with `shellQuote`. */
function scriptPathOfCommand(command: string): string {
  return command.startsWith("'") && command.endsWith("'") ? command.slice(1, -1).replaceAll("'\\''", "'") : command;
}

/** Any hook item that invokes the script, quoted or not, or as part of a longer command. */
function hookItemRunsScript(item: unknown, command: string): boolean {
  if (!isPlainObject(item) || typeof item.command !== "string") return false;
  return item.command === command || item.command.includes(scriptPathOfCommand(command));
}

function locateHookCommand(entries: readonly unknown[], command: string): { exact: number[]; other: number } {
  const groupText = advisorHookGroupText(command);
  const exact: number[] = [];
  let other = 0;
  entries.forEach((entry, index) => {
    if (JSON.stringify(entry) === groupText) {
      exact.push(index);
      return;
    }
    if (isPlainObject(entry) && Array.isArray(entry.hooks)) {
      other += entry.hooks.filter(item => hookItemRunsScript(item, command)).length;
    }
  });
  return { exact, other };
}

/** Whether any hook in the file still invokes the script of `command`, in any form; an unreadable file counts as yes. */
function hookStillRegistered(hookConfigPath: string, command: string): boolean {
  const read = readJsonObject(hookConfigPath);
  if (read.parseError || !read.doc) return true;
  const list = isPlainObject(read.doc.hooks) && Array.isArray(read.doc.hooks.UserPromptSubmit) ? read.doc.hooks.UserPromptSubmit : [];
  return list.some(entry => isPlainObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some(item => hookItemRunsScript(item, command)));
}

/**
 * Cleanup OpenCodex still owes: artifacts of a client that was unmounted, or that lived in a config directory the
 * client no longer uses. Each item is retried on every mount, unmount and sync until it resolves; an item whose file
 * cannot be read or whose ownership is ambiguous stays queued instead of being dropped or forced.
 */
const ADVISOR_PENDING_CLEANUP_FILE = "advisor-pending-cleanup.json";
type PendingCleanup =
  | { kind: "mcp"; clientId: string; container: string; configPath: string; entry: string; routingShared?: boolean }
  | { kind: "hook"; clientId: string; hookConfigPath: string; command: string; routingShared?: boolean }
  | { kind: "file"; clientId: string; path: string; marker: "hook" | "skill"; sha256?: string; hookConfigPath?: string; command?: string };

function pendingKey(item: PendingCleanup): string {
  if (item.kind === "mcp") return `mcp:${canonicalClientPath(item.configPath)}:${item.entry}`;
  if (item.kind === "hook") return `hook:${canonicalClientPath(item.hookConfigPath)}:${item.command}`;
  return `file:${canonicalClientPath(item.path)}`;
}

function readPendingCleanup(configDir: string): PendingCleanup[] {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, ADVISOR_PENDING_CLEANUP_FILE), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingCleanup => isPlainObject(item) && typeof item.clientId === "string" && (
      (item.kind === "mcp" && typeof item.configPath === "string" && typeof item.entry === "string" && typeof item.container === "string")
      || (item.kind === "hook" && typeof item.hookConfigPath === "string" && typeof item.command === "string")
      || (item.kind === "file" && typeof item.path === "string" && (item.marker === "hook" || item.marker === "skill"))));
  } catch {
    return [];
  }
}

function writePendingCleanup(configDir: string, items: readonly PendingCleanup[]): void {
  if (items.length === 0 && !existsSync(join(configDir, ADVISOR_PENDING_CLEANUP_FILE))) return;
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  atomicWriteFile(join(configDir, ADVISOR_PENDING_CLEANUP_FILE), `${JSON.stringify(items, null, 2)}\n`);
}

function queuePendingCleanup(configDir: string, items: readonly PendingCleanup[]): void {
  if (items.length === 0) return;
  const merged = new Map(readPendingCleanup(configDir).map(item => [pendingKey(item), item]));
  for (const item of items) merged.set(pendingKey(item), item);
  writePendingCleanup(configDir, [...merged.values()]);
}

/**
 * Move this client's recorded artifacts into the cleanup queue. With `keepCurrent`, artifacts still at the client's
 * current paths stay recorded (a mount after the config directory moved); without it everything is queued (unmount).
 */
function queueRecordedArtifacts(spec: ClientSpec, paths: ResolvedClientPaths, configDir: string, keepCurrent: boolean): void {
  const same = (recorded: string | undefined, current: string | undefined) =>
    !!recorded && !!current && canonicalClientPath(recorded) === canonicalClientPath(current);
  const items: PendingCleanup[] = [];
  const mcpRecords = readOwnedAdvisorEntries(configDir);
  const mcpRecord = mcpRecords[spec.id];
  if (mcpRecord && !(keepCurrent && same(mcpRecord.configPath, paths.mcpConfigPath))) {
    items.push({
      kind: "mcp", clientId: spec.id, container: spec.mcpContainer, configPath: mcpRecord.configPath, entry: mcpRecord.entry,
      routingShared: !!paths.sharedWithRouting && same(mcpRecord.configPath, paths.mcpConfigPath),
    });
    const { [spec.id]: _queued, ...rest } = mcpRecords;
    writeOwnedAdvisorEntries(configDir, rest);
  }
  const artifacts = readOwnedArtifacts(configDir);
  const record: OwnedArtifacts = { ...(artifacts[spec.id] ?? {}) };
  const hookMoved = !!record.hookConfigPath && !(keepCurrent && same(record.hookConfigPath, paths.hookConfigPath));
  if (hookMoved && record.hookConfigPath && record.command) {
    items.push({
      kind: "hook", clientId: spec.id, hookConfigPath: record.hookConfigPath, command: record.command,
      routingShared: !!paths.sharedWithRouting && same(record.hookConfigPath, paths.hookConfigPath) && paths.hookConfigPath === paths.mcpConfigPath,
    });
  }
  if (record.hookScriptPath && !(keepCurrent && same(record.hookScriptPath, paths.hookScriptPath))) {
    // The script stays while any hook in the config that may run it still does, whoever registered that hook.
    const scriptConfig = record.scriptHookConfigPath ?? record.hookConfigPath;
    items.push({ kind: "file", clientId: spec.id, path: record.hookScriptPath, marker: "hook",
      ...(record.hookScriptSha256 ? { sha256: record.hookScriptSha256 } : {}),
      ...(scriptConfig ? { hookConfigPath: scriptConfig, command: advisorHookCommand(record.hookScriptPath) } : {}) });
    delete record.hookScriptPath;
    delete record.hookScriptSha256;
    delete record.scriptHookConfigPath;
  }
  if (record.skillPath && !(keepCurrent && same(record.skillPath, paths.skillPath))) {
    items.push({ kind: "file", clientId: spec.id, path: record.skillPath, marker: "skill",
      ...(record.skillSha256 ? { sha256: record.skillSha256 } : {}) });
    delete record.skillPath;
    delete record.skillSha256;
  }
  if (hookMoved) {
    delete record.hookConfigPath;
    delete record.command;
  }
  if (JSON.stringify(record) !== JSON.stringify(artifacts[spec.id] ?? {})) {
    writeOwnedArtifacts(configDir, { ...artifacts, [spec.id]: record });
  }
  queuePendingCleanup(configDir, items);
}

function unlinkOwnedFile(item: Extract<PendingCleanup, { kind: "file" }>): boolean {
  try {
    unlinkSync(item.path);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    return false;
  }
  if (item.marker === "skill") {
    const skillDir = dirname(item.path);
    try {
      const dirStat = lstatSync(skillDir);
      if (dirStat.isDirectory() && !dirStat.isSymbolicLink() && readdirSync(skillDir).length === 0) rmdirSync(skillDir);
    } catch {
      // Leave the directory when it is not empty or changed concurrently.
    }
  }
  return true;
}

/** Work through the cleanup queue (optionally one client's items). Returns what changed and what still needs attention. */
function reconcilePendingCleanup(
  configDir: string,
  protectedPaths?: ProtectedClientPaths,
  onlyClient?: string,
): { changed: boolean; errors: Array<{ clientId: string; message: string }> } {
  const pending = readPendingCleanup(configDir);
  if (pending.length === 0) return { changed: false, errors: [] };
  const mcpRecords = readOwnedAdvisorEntries(configDir);
  const artifacts = readOwnedArtifacts(configDir);
  const keep: PendingCleanup[] = [];
  const errors: Array<{ clientId: string; message: string }> = [];
  let changed = false;
  // Registrations before files, so a hook script goes only after nothing runs it.
  const ordered = [...pending.filter(item => item.kind !== "file"), ...pending.filter(item => item.kind === "file")];
  const step = (item: PendingCleanup): void => {
    const clientId = item.clientId as AdvisorMcpClientId;
    if (item.kind === "mcp") {
      const target = canonicalClientPath(item.configPath);
      // Another client still records this exact entry in this file: it is in use, not left over.
      if (Object.values(mcpRecords).some(record => canonicalClientPath(record.configPath) === target && record.entry === item.entry)) return;
      if (protectedPaths?.mcpPaths.has(target)) { keep.push(item); return; }
      if (!existsSync(item.configPath)) return;
      const read = readJsonObject(item.configPath);
      if (read.parseError || !read.doc) {
        keep.push(item);
        errors.push({ clientId, message: `Refused to edit invalid JSON in ${item.configPath}; Advisor cleanup will retry` });
        return;
      }
      if (!isPlainObject(read.doc[item.container])) return;
      const container = { ...(read.doc[item.container] as JsonObj) };
      if (!Object.hasOwn(container, ADVISOR_MCP_SERVER_NAME) || JSON.stringify(container[ADVISOR_MCP_SERVER_NAME]) !== item.entry) return;
      backupOnceBeforeEdit(configDir, clientId, item.configPath, read.text);
      delete container[ADVISOR_MCP_SERVER_NAME];
      const nextText = `${JSON.stringify({ ...read.doc, [item.container]: container }, null, 2)}\n`;
      atomicWriteFile(item.configPath, nextText);
      if (item.routingShared) syncOwnershipFingerprintIfClean(configDir, clientId, item.configPath, read.text, nextText);
      changed = true;
      return;
    }
    if (item.kind === "hook") {
      const target = canonicalClientPath(item.hookConfigPath);
      if (Object.values(artifacts).some(record => record.command === item.command && !!record.hookConfigPath
        && canonicalClientPath(record.hookConfigPath) === target)) return;
      if (protectedPaths?.hookConfigPaths.has(target)) { keep.push(item); return; }
      if (!existsSync(item.hookConfigPath)) return;
      const read = readJsonObject(item.hookConfigPath);
      if (read.parseError || !read.doc) {
        keep.push(item);
        errors.push({ clientId, message: `Refused to edit invalid JSON in ${item.hookConfigPath}; Advisor cleanup will retry` });
        return;
      }
      const hooks = isPlainObject(read.doc.hooks) ? { ...read.doc.hooks } : {};
      const list = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
      const { exact, other } = locateHookCommand(list, item.command);
      if (exact.length === 0 && other === 0) return;
      // Only one group exactly as OpenCodex wrote it, and nothing else running the command, is provably ours.
      if (exact.length !== 1 || other !== 0) { keep.push(item); return; }
      list.splice(exact[0]!, 1);
      if (list.length === 0) delete hooks.UserPromptSubmit;
      else hooks.UserPromptSubmit = list;
      const nextDoc = { ...read.doc };
      if (Object.keys(hooks).length === 0) delete nextDoc.hooks;
      else nextDoc.hooks = hooks;
      const nextText = `${JSON.stringify(nextDoc, null, 2)}\n`;
      backupOnceBeforeEdit(configDir, clientId, item.hookConfigPath, read.text);
      atomicWriteFile(item.hookConfigPath, nextText);
      if (item.routingShared) syncOwnershipFingerprintIfClean(configDir, clientId, item.hookConfigPath, read.text, nextText);
      changed = true;
      return;
    }
    const target = canonicalClientPath(item.path);
    if (Object.values(artifacts).some(record => [record.hookScriptPath, record.skillPath]
      .some(path => !!path && canonicalClientPath(path) === target))) return;
    const protectedSet = item.marker === "hook" ? protectedPaths?.hookScriptPaths : protectedPaths?.skillPaths;
    if (protectedSet?.has(target)) { keep.push(item); return; }
    // Only the exact content OpenCodex recorded writing is removed; a changed or unrecorded file is the user's.
    const text = readPlainTextFile(item.path);
    if (typeof text !== "string" || !item.sha256 || contentSha256(text) !== item.sha256) return;
    // A registration (the user's, or one whose ownership is ambiguous) still runs this script, or nothing says which
    // config could run it: keep it.
    if (item.marker === "hook" && (!item.hookConfigPath || !item.command || hookStillRegistered(item.hookConfigPath, item.command))) {
      keep.push(item);
      return;
    }
    if (unlinkOwnedFile(item)) changed = true;
  };
  for (const item of ordered) {
    if (onlyClient !== undefined && item.clientId !== onlyClient) {
      keep.push(item);
      continue;
    }
    // One failing item (a write or unlink error) stays queued and is reported; the rest still run.
    try {
      step(item);
    } catch (error) {
      if (!keep.includes(item)) keep.push(item);
      const where = item.kind === "mcp" ? item.configPath : item.kind === "hook" ? item.hookConfigPath : item.path;
      errors.push({ clientId: item.clientId, message: `Advisor cleanup of ${where} failed and will retry: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  writePendingCleanup(configDir, keep);
  return { changed, errors };
}


interface ProtectedClientPaths {
  mcpPaths: Set<string>;
  hookConfigPaths: Set<string>;
  hookScriptPaths: Set<string>;
  skillPaths: Set<string>;
}

function inspectManagedTextFile(filePath: string, marker: string): "owned" | "unowned" | "missing" {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return "unowned";
    return readFileSync(filePath, "utf8").includes(marker) ? "owned" : "unowned";
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "missing";
    return "unowned";
  }
}

function isSafeTargetDir(dirPath: string): boolean {
  try {
    const stat = lstatSync(dirPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
}

function mountHooksAndSkill(
  spec: ClientSpec,
  paths: ResolvedClientPaths,
  configDir: string,
  options?: AdvisorMcpSyncOptions,
): { changed: boolean } {
  let changed = false;
  const artifacts = readOwnedArtifacts(configDir);
  const record: OwnedArtifacts = { ...(artifacts[spec.id] ?? {}) };
  if (spec.supportsHooks && paths.hookConfigPath && paths.hookScriptPath) {
    const desiredHookScript = buildNoticeHookScript(configDir, options?.execPath ?? process.execPath);
    // Write only a missing script or one OpenCodex recorded unchanged; identical unrecorded content is used as it is.
    const scriptState = managedFileState(artifacts, paths.hookScriptPath, desiredHookScript, "hook");
    if (scriptState === "missing" || scriptState === "owned") {
      mkdirSync(dirname(paths.hookScriptPath), { recursive: true, mode: 0o700 });
      if (readPlainTextFile(paths.hookScriptPath) !== desiredHookScript) {
        atomicWriteFile(paths.hookScriptPath, desiredHookScript);
        changed = true;
      }
      chmodSync(paths.hookScriptPath, 0o755);
      record.hookScriptPath = resolve(paths.hookScriptPath);
      record.hookScriptSha256 = contentSha256(desiredHookScript);
      record.scriptHookConfigPath = resolve(paths.hookConfigPath);
    }

    const command = advisorHookCommand(paths.hookScriptPath);
    const read = readJsonObject(paths.hookConfigPath);
    if (!read.parseError && read.doc) {
      const next = { ...read.doc };
      const hooks = isPlainObject(next.hooks) ? { ...next.hooks } : {};
      const existing = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
      const { exact, other } = locateHookCommand(existing, command);
      const target = canonicalClientPath(paths.hookConfigPath);
      const recordedHere = Object.values(artifacts).some(owned => owned.command === command && !!owned.hookConfigPath
        && canonicalClientPath(owned.hookConfigPath) === target);
      if (exact.length === 0 && other === 0) {
        existing.push(JSON.parse(advisorHookGroupText(command)) as JsonObj);
        hooks.UserPromptSubmit = existing;
        next.hooks = hooks;
        const nextText = `${JSON.stringify(next, null, 2)}\n`;
        backupOnceBeforeEdit(configDir, spec.id, paths.hookConfigPath, read.text);
        mkdirSync(dirname(paths.hookConfigPath), { recursive: true, mode: 0o700 });
        atomicWriteFile(paths.hookConfigPath, nextText);
        if (paths.sharedWithRouting && paths.hookConfigPath === paths.mcpConfigPath) {
          syncOwnershipFingerprintIfClean(configDir, spec.id, paths.hookConfigPath, read.text, nextText);
        }
        changed = true;
        record.hookConfigPath = resolve(paths.hookConfigPath);
        record.command = command;
      } else if (exact.length === 1 && other === 0 && recordedHere) {
        record.hookConfigPath = resolve(paths.hookConfigPath);
        record.command = command;
      }
      // Otherwise the command is already registered by the user, or ambiguously: leave the file and the record alone.
    }
  }
  if (spec.supportsSkills && paths.skillPath) {
    const skillState = managedFileState(artifacts, paths.skillPath, ADVISOR_SKILL_CONTENT, "skill");
    if (skillState === "missing" || skillState === "owned") {
      mkdirSync(dirname(paths.skillPath), { recursive: true, mode: 0o700 });
      if (readPlainTextFile(paths.skillPath) !== ADVISOR_SKILL_CONTENT) {
        atomicWriteFile(paths.skillPath, ADVISOR_SKILL_CONTENT);
        changed = true;
      }
      record.skillPath = resolve(paths.skillPath);
      record.skillSha256 = contentSha256(ADVISOR_SKILL_CONTENT);
    }
  }
  if (JSON.stringify(record) !== JSON.stringify(artifacts[spec.id] ?? {})) {
    writeOwnedArtifacts(configDir, { ...artifacts, [spec.id]: record });
  }
  return { changed };
}


function readTrustStatus(spec: ClientSpec, paths: ResolvedClientPaths, mcpEntry: unknown): AdvisorMcpTrustStatus {
  if (!isPlainObject(mcpEntry)) return "not_mounted";
  if (paths.approvalsPath) {
    const approvals = readJsonObject(paths.approvalsPath);
    if (!approvals.parseError && approvals.doc) {
      const approved = Object.keys(approvals.doc).some(key => key.endsWith(`::${ADVISOR_MCP_SERVER_NAME}`));
      return approved ? "trusted" : "action_required";
    }
    return "action_required";
  }
  if (spec.id === "cline") {
    const disabled = mcpEntry.disabled === true;
    const autoApprove = Array.isArray(mcpEntry.autoApprove) && mcpEntry.autoApprove.includes("consult_advisor");
    return !disabled && autoApprove ? "trusted" : "needs_confirmation";
  }
  if (spec.id === "opencode") {
    return mcpEntry.enabled === false ? "needs_confirmation" : "auto_enabled";
  }
  return "needs_confirmation";
}

function readRoutedClientSet(configDir: string): Set<string> {
  const records = readRecords(integrationsDir(configDir));
  return new Set(Object.keys(records));
}

export function inspectAdvisorMcpClientStatus(
  clientId: AdvisorMcpClientId,
  config: Pick<OcxConfig, "advisor">,
  options?: AdvisorMcpSyncOptions,
  routedSet?: Set<string>,
): AdvisorMcpClientStatus {
  const spec = CLIENT_SPECS[clientId];
  const home = resolveSafeHome(options);
  const env = advisorClientEnv(options);
  if (!home) {
    const settings = resolveAdvisorSettings(config);
    return {
      clientId,
      label: spec.label,
      detected: false,
      routed: false,
      mounted: false,
      selected: settings.mcpClients ? settings.mcpClients.includes(clientId) : false,
      defaultAutoMount: spec.defaultAutoMount,
      supportsHooks: spec.supportsHooks,
      supportsSkills: spec.supportsSkills,
      hooksMounted: false,
      skillMounted: false,
      trustStatus: "not_mounted",
      configPath: "",
      trustNoteZh: spec.trustNoteZh,
      trustNoteEn: spec.trustNoteEn,
    };
  }
  const configDir = resolveOpencodeConfigDir(options);
  const paths = spec.resolvePaths(home, env);
  const routed = (routedSet ?? readRoutedClientSet(configDir)).has(clientId);
  const read = readJsonObject(paths.mcpConfigPath);
  const container = read.doc && isPlainObject(read.doc[spec.mcpContainer]) ? (read.doc[spec.mcpContainer] as JsonObj) : undefined;
  const mcpEntry = container?.[ADVISOR_MCP_SERVER_NAME];
  const mounted = isPlainObject(mcpEntry);
  const detected = mounted || routed || existsSync(paths.rootDir) || existsSync(paths.mcpConfigPath);

  let hooksMounted = false;
  if (spec.supportsHooks && paths.hookConfigPath && paths.hookScriptPath) {
    const hooksDoc = readJsonObject(paths.hookConfigPath);
    const submitArr = hooksDoc.doc && isPlainObject(hooksDoc.doc.hooks) && Array.isArray(hooksDoc.doc.hooks.UserPromptSubmit)
      ? hooksDoc.doc.hooks.UserPromptSubmit
      : [];
    hooksMounted = submitArr.some(entry => entryMatchesAdvisorHook(entry, paths.hookScriptPath!));
  }
  const skillMounted = Boolean(
    spec.supportsSkills
    && paths.skillPath
    && inspectManagedTextFile(paths.skillPath, ADVISOR_SKILL_MARKER) === "owned",
  );

  const settings = resolveAdvisorSettings(config);
  const selected = settings.mcpClients
    ? settings.mcpClients.includes(clientId)
    : settings.autoMountMcp && spec.defaultAutoMount && routed;

  return {
    clientId,
    label: spec.label,
    detected,
    routed,
    mounted,
    selected,
    defaultAutoMount: spec.defaultAutoMount,
    supportsHooks: spec.supportsHooks,
    supportsSkills: spec.supportsSkills,
    hooksMounted,
    skillMounted,
    trustStatus: readTrustStatus(spec, paths, mcpEntry),
    configPath: paths.mcpConfigPath,
    ...(paths.hookConfigPath ? { hookConfigPath: paths.hookConfigPath } : {}),
    ...(paths.skillPath ? { skillPath: paths.skillPath } : {}),
    trustNoteZh: spec.trustNoteZh,
    trustNoteEn: spec.trustNoteEn,
  };
}

export function listAdvisorMcpClientStatuses(
  config: Pick<OcxConfig, "advisor">,
  options?: AdvisorMcpSyncOptions,
): AdvisorMcpClientStatus[] {
  const home = resolveSafeHome(options);
  const routedSet = home ? readRoutedClientSet(resolveOpencodeConfigDir(options)) : new Set<string>();
  return ADVISOR_MCP_CLIENT_IDS.map(clientId => inspectAdvisorMcpClientStatus(clientId, config, options, routedSet));
}

const ADVISOR_MCP_OWNERSHIP_FILE = "advisor-mcp-entries.json";
type OwnedAdvisorEntries = Record<string, { configPath: string; entry: string }>;

/** The exact `opencodex-advisor` entries this computer wrote, so an entry a user created under that name is never replaced or removed. */
function readOwnedAdvisorEntries(configDir: string): OwnedAdvisorEntries {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, ADVISOR_MCP_OWNERSHIP_FILE), "utf8")) as unknown;
    if (!isPlainObject(parsed)) return {};
    const owned: OwnedAdvisorEntries = {};
    for (const [clientId, value] of Object.entries(parsed)) {
      if (isPlainObject(value) && typeof value.configPath === "string" && typeof value.entry === "string") {
        owned[clientId] = { configPath: value.configPath, entry: value.entry };
      }
    }
    return owned;
  } catch {
    return {};
  }
}

function writeOwnedAdvisorEntries(configDir: string, owned: OwnedAdvisorEntries): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  atomicWriteFile(join(configDir, ADVISOR_MCP_OWNERSHIP_FILE), `${JSON.stringify(owned, null, 2)}\n`);
}

/** An existing entry is ours only when we recorded writing exactly these bytes at this path. Matching content alone is not ownership. */
function ownsAdvisorEntry(owned: OwnedAdvisorEntries, clientId: string, configPath: string, currentText: string, includeShared = false): boolean {
  const slot = CLIENT_SPECS[clientId as AdvisorMcpClientId]?.mcpContainer;
  return Object.entries(owned).some(([recordClient, record]) =>
    (recordClient === clientId || (includeShared && CLIENT_SPECS[recordClient as AdvisorMcpClientId]?.mcpContainer === slot))
    && canonicalClientPath(record.configPath) === canonicalClientPath(configPath) && record.entry === currentText);
}

export function mountAdvisorMcpForClient(
  clientId: AdvisorMcpClientId,
  options?: AdvisorMcpSyncOptions,
): { ok: boolean; changed: boolean; error?: string; status?: AdvisorMcpClientStatus } {
  const home = resolveSafeHome(options);
  if (!home) return { ok: true, changed: false };
  const spec = CLIENT_SPECS[clientId];
  const env = advisorClientEnv(options);
  const configDir = resolveOpencodeConfigDir(options);
  const paths = spec.resolvePaths(home, env);

  const read = readJsonObject(paths.mcpConfigPath);
  if (read.parseError || !read.doc) {
    return { ok: false, changed: false, error: `Refused to overwrite invalid JSON in ${paths.mcpConfigPath}` };
  }
  if (spec.supportsHooks && paths.hookConfigPath && paths.hookScriptPath) {
    if (!isSafeTargetDir(dirname(paths.hookScriptPath))) {
      return { ok: false, changed: false, error: `Refused to write hook into unsafe directory ${dirname(paths.hookScriptPath)}` };
    }
    const desiredHookScript = buildNoticeHookScript(configDir, options?.execPath ?? process.execPath);
    if (managedFileState(readOwnedArtifacts(configDir), paths.hookScriptPath, desiredHookScript, "hook") === "foreign") {
      return { ok: false, changed: false, error: `Refused to overwrite a hook script OpenCodex did not record writing in ${paths.hookScriptPath}` };
    }
    if (paths.hookConfigPath !== paths.mcpConfigPath) {
      const hooksRead = readJsonObject(paths.hookConfigPath);
      if (hooksRead.parseError || !hooksRead.doc) {
        return { ok: false, changed: false, error: `Refused to overwrite invalid JSON in ${paths.hookConfigPath}` };
      }
    }
  }
  if (spec.supportsSkills && paths.skillPath) {
    if (!isSafeTargetDir(dirname(paths.skillPath))) {
      return { ok: false, changed: false, error: `Refused to write skill into unsafe directory ${dirname(paths.skillPath)}` };
    }
    if (managedFileState(readOwnedArtifacts(configDir), paths.skillPath, ADVISOR_SKILL_CONTENT, "skill") === "foreign") {
      return { ok: false, changed: false, error: `Refused to overwrite a skill file OpenCodex did not record writing in ${paths.skillPath}` };
    }
  }

  const container = isPlainObject(read.doc[spec.mcpContainer]) ? { ...(read.doc[spec.mcpContainer] as JsonObj) } : {};
  const desired = buildMcpEntry(spec, configDir, options);
  const currentText = JSON.stringify(container[ADVISOR_MCP_SERVER_NAME] ?? null);
  const desiredText = JSON.stringify(desired);
  let changed = false;
  const owned = readOwnedAdvisorEntries(configDir);
  const ownedEntry = Object.hasOwn(container, ADVISOR_MCP_SERVER_NAME) && ownsAdvisorEntry(owned, clientId, paths.mcpConfigPath, currentText, true);
  // An unrecorded entry is the user's. If it already says exactly what we would write it serves Advisor as it is, but
  // it stays unrecorded so OpenCodex never deletes it; any other content is refused.
  const userEntry = Object.hasOwn(container, ADVISOR_MCP_SERVER_NAME) && !ownedEntry;
  if (userEntry && currentText !== desiredText) {
    return { ok: false, changed: false, error: `Refused to replace the ${ADVISOR_MCP_SERVER_NAME} MCP entry in ${paths.mcpConfigPath}: OpenCodex did not write it` };
  }
  // The destination is acceptable. Anything this client recorded under a config directory it no longer uses is
  // queued for cleanup before its records are replaced, so moving the directory never orphans it.
  queueRecordedArtifacts(spec, paths, configDir, true);

  if (currentText !== desiredText) {
    backupOnceBeforeEdit(configDir, spec.id, paths.mcpConfigPath, read.text);
    container[ADVISOR_MCP_SERVER_NAME] = desired;
    const nextDoc = { ...read.doc, [spec.mcpContainer]: container };
    const nextText = `${JSON.stringify(nextDoc, null, 2)}\n`;
    mkdirSync(dirname(paths.mcpConfigPath), { recursive: true, mode: 0o700 });
    atomicWriteFile(paths.mcpConfigPath, nextText);
    if (paths.sharedWithRouting) {
      syncOwnershipFingerprintIfClean(configDir, clientId, paths.mcpConfigPath, read.text, nextText);
    }
    changed = true;
  }
  const record = { configPath: resolve(paths.mcpConfigPath), entry: desiredText };
  if (!userEntry && (owned[clientId]?.configPath !== record.configPath || owned[clientId]?.entry !== record.entry)) {
    writeOwnedAdvisorEntries(configDir, { ...owned, [clientId]: record });
  }

  const hookSkillRes = mountHooksAndSkill(spec, paths, configDir, options);
  changed = changed || hookSkillRes.changed;
  const cleanup = reconcilePendingCleanup(configDir, collectProtectedPaths(new Set([clientId]), home, env), clientId);
  changed = changed || cleanup.changed;
  return { ok: true, changed, status: inspectAdvisorMcpClientStatus(clientId, {}, options) };
}

export function unmountAdvisorMcpForClient(
  clientId: AdvisorMcpClientId,
  options?: AdvisorMcpSyncOptions,
  protectedPaths?: ProtectedClientPaths,
): { ok: boolean; changed: boolean; error?: string } {
  const home = resolveSafeHome(options);
  if (!home) return { ok: true, changed: false };
  const spec = CLIENT_SPECS[clientId];
  const env = advisorClientEnv(options);
  const configDir = resolveOpencodeConfigDir(options);
  const paths = spec.resolvePaths(home, env);

  // Everything this client recorded, wherever it was recorded, goes through the cleanup queue; nothing unrecorded does.
  queueRecordedArtifacts(spec, paths, configDir, false);
  const cleanup = reconcilePendingCleanup(configDir, protectedPaths, clientId);
  if (cleanup.errors.length > 0) return { ok: false, changed: cleanup.changed, error: cleanup.errors[0]!.message };
  return { ok: true, changed: cleanup.changed };
}


function computeDesiredAdvisorMcpTargets(
  config: Pick<OcxConfig, "advisor">,
  routedSet: Set<string>,
): Set<AdvisorMcpClientId> {
  const settings = resolveAdvisorSettings(config);
  const desiredTargets = new Set<AdvisorMcpClientId>();
  if (!advisorRunnable(settings)) return desiredTargets;
  if (settings.mcpClients) {
    for (const id of settings.mcpClients) desiredTargets.add(id);
  } else if (settings.autoMountMcp) {
    for (const id of ADVISOR_MCP_CLIENT_IDS) {
      if (CLIENT_SPECS[id].defaultAutoMount && routedSet.has(id)) {
        desiredTargets.add(id);
      }
    }
  }
  return desiredTargets;
}

function collectProtectedPaths(
  targets: Iterable<AdvisorMcpClientId>,
  home: string,
  env: NodeJS.ProcessEnv,
): ProtectedClientPaths {
  const protectedPaths: ProtectedClientPaths = {
    mcpPaths: new Set(),
    hookConfigPaths: new Set(),
    hookScriptPaths: new Set(),
    skillPaths: new Set(),
  };
  for (const id of targets) {
    const paths = CLIENT_SPECS[id].resolvePaths(home, env);
    protectedPaths.mcpPaths.add(canonicalClientPath(paths.mcpConfigPath));
    if (paths.hookConfigPath) protectedPaths.hookConfigPaths.add(canonicalClientPath(paths.hookConfigPath));
    if (paths.hookScriptPath) protectedPaths.hookScriptPaths.add(canonicalClientPath(paths.hookScriptPath));
    if (paths.skillPath) protectedPaths.skillPaths.add(canonicalClientPath(paths.skillPath));
  }
  return protectedPaths;
}

/**
 * Reconcile Advisor MCP + hooks/skills for one client when its Routing toggle changes,
 * gating mounts on `advisorRunnable` (including current consent) and preserving any shared
 * custom config paths still owned by another active client.
 */
export function reconcileAdvisorMcpForRoutedClient(
  clientId: AdvisorMcpClientId,
  routedEnabled: boolean,
  config: Pick<OcxConfig, "advisor">,
  options?: AdvisorMcpSyncOptions,
): { ok: boolean; changed: boolean; error?: string; status?: AdvisorMcpClientStatus } {
  const home = resolveSafeHome(options);
  if (!home) return { ok: true, changed: false };
  const settings = resolveAdvisorSettings(config);
  if (routedEnabled) {
    if (!advisorRunnable(settings)) return { ok: true, changed: false };
    const shouldMount = settings.mcpClients
      ? settings.mcpClients.includes(clientId)
      : settings.autoMountMcp && CLIENT_SPECS[clientId].defaultAutoMount;
    return shouldMount ? mountAdvisorMcpForClient(clientId, options) : { ok: true, changed: false };
  }
  if (!settings.autoMountMcp || settings.mcpClients !== undefined) {
    return { ok: true, changed: false };
  }
  const env = advisorClientEnv(options);
  const configDir = resolveOpencodeConfigDir(options);
  const routedSet = readRoutedClientSet(configDir);
  routedSet.delete(clientId);
  const remainingTargets = computeDesiredAdvisorMcpTargets(config, routedSet);
  const protectedPaths = collectProtectedPaths(remainingTargets, home, env);
  return unmountAdvisorMcpForClient(clientId, options, protectedPaths);
}

/**
 * Reconcile Advisor MCP + hooks/skills across compatible clients based on current Advisor settings
 * and active Routing ownership records. Runs only against explicit or non-test homes.
 */
export function syncAdvisorMcpClients(
  config: Pick<OcxConfig, "advisor">,
  options?: AdvisorMcpSyncOptions,
): AdvisorMcpSyncResult {
  const home = resolveSafeHome(options);
  if (!home) {
    return {
      mounted: [],
      unmounted: [],
      errors: [],
      statuses: listAdvisorMcpClientStatuses(config, options),
    };
  }
  const env = advisorClientEnv(options);
  const configDir = resolveOpencodeConfigDir(options);
  const routedSet = readRoutedClientSet(configDir);
  const desiredTargets = computeDesiredAdvisorMcpTargets(config, routedSet);
  const protectedPaths = collectProtectedPaths(desiredTargets, home, env);

  const mounted: AdvisorMcpClientId[] = [];
  const unmounted: AdvisorMcpClientId[] = [];
  const errors: Array<{ clientId: AdvisorMcpClientId; message: string }> = [];

  for (const id of ADVISOR_MCP_CLIENT_IDS) {
    if (!desiredTargets.has(id)) continue;
    try {
      const res = mountAdvisorMcpForClient(id, options);
      if (!res.ok && res.error) errors.push({ clientId: id, message: res.error });
      else if (res.changed) mounted.push(id);
    } catch (error) {
      errors.push({
        clientId: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const id of ADVISOR_MCP_CLIENT_IDS) {
    if (desiredTargets.has(id)) continue;
    try {
      const paths = CLIENT_SPECS[id].resolvePaths(home, env);
      const status = inspectAdvisorMcpClientStatus(id, config, options, routedSet);
      const recordedPath = readOwnedAdvisorEntries(configDir)[id]?.configPath;
      const hasUnprotectedMounted =
        (!!recordedPath && canonicalClientPath(recordedPath) !== canonicalClientPath(paths.mcpConfigPath)
          && !protectedPaths.mcpPaths.has(canonicalClientPath(recordedPath)))
        || (status.mounted && !protectedPaths.mcpPaths.has(canonicalClientPath(paths.mcpConfigPath)))
        || (status.hooksMounted && (!paths.hookConfigPath || !protectedPaths.hookConfigPaths.has(canonicalClientPath(paths.hookConfigPath))))
        || (status.skillMounted && (!paths.skillPath || !protectedPaths.skillPaths.has(canonicalClientPath(paths.skillPath))));
      if (hasUnprotectedMounted) {
        const res = unmountAdvisorMcpForClient(id, options, protectedPaths);
        if (!res.ok && res.error) errors.push({ clientId: id, message: res.error });
        else if (res.changed) unmounted.push(id);
      }
    } catch (error) {
      errors.push({
        clientId: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const cleanup = reconcilePendingCleanup(configDir, protectedPaths);
    for (const error of cleanup.errors) {
      if (!errors.some(existing => existing.message === error.message)) errors.push({ clientId: error.clientId as AdvisorMcpClientId, message: error.message });
    }
  } catch (error) {
    // The queue file itself could not be read or written; the items stay where they are for the next sync.
    errors.push({ clientId: ADVISOR_MCP_CLIENT_IDS[0], message: `Advisor cleanup queue could not be updated: ${error instanceof Error ? error.message : String(error)}` });
  }

  return {
    mounted,
    unmounted,
    errors,
    statuses: listAdvisorMcpClientStatuses(config, options),
  };
}
