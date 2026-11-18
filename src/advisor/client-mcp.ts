/**
 * Manage per-client `opencodex-advisor` MCP registration, anti-forgetting hooks/skills, and
 * bidirectional Advisor <-> Routing synchronization for compatible external coding clients.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
import { isBunTestFileProcess } from "../lib/test-home-guard";
import type { OcxConfig } from "../types";
import {
  ADVISOR_MCP_CLIENT_IDS,
  isAdvisorMcpClientId,
  normalizeAdvisorMcpClients,
  resolveAdvisorSettings,
  type AdvisorMcpClientId,
} from "./settings";

export const ADVISOR_MCP_SERVER_NAME = "opencodex-advisor";
export const ADVISOR_MCP_TIMEOUT_MS = 900_000;
export const CLINE_ADVISOR_MCP_TIMEOUT_SECONDS = 900;
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
    trustNoteZh: "已写入 cline_mcp_settings.json（timeout: 900 秒，autoApprove: [\"consult_advisor\"]）。",
    trustNoteEn: "Written to cline_mcp_settings.json (timeout: 900s, autoApprove: [\"consult_advisor\"]).",
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

function resolveOpencodeConfigDir(options?: AdvisorMcpSyncOptions): string {
  if (options?.configDir) return options.configDir;
  if (options?.homeDir) return join(options.homeDir, ".opencodex");
  return getConfigDir();
}

function advisorCommandArgs(): { command: string; args: string[]; env: Record<string, string> } {
  const cliEntry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.ts");
  return {
    command: process.execPath,
    args: [cliEntry, "advisor", "mcp"],
    env: {
      NO_PROXY: "localhost,127.0.0.1,::1,*.local",
      no_proxy: "localhost,127.0.0.1,::1,*.local",
    },
  };
}

function buildMcpEntry(spec: ClientSpec): JsonObj {
  const { command, args, env } = advisorCommandArgs();
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
        autoApprove: ["consult_advisor"],
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
  if (record.fileFingerprint !== fingerprint(beforeText)) return;
  writeRecord({ ...record, fileFingerprint: fingerprint(afterText) }, dir);
}

function buildNoticeHookScript(configDir: string): string {
  const bunBin = process.execPath;
  const configFileLiteral = JSON.stringify(join(configDir, "config.json"));
  const bunLiteral = JSON.stringify(bunBin);
  return `#!/bin/sh
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

if [ -f "$CFG_PATH" ] && [ -x "$BUN_BIN" ]; then
  META=$(HOOK_STDIN="$STDIN_PAYLOAD" OCX_CFG="$CFG_PATH" "$BUN_BIN" -e '
    import { readFileSync } from "node:fs";
    let ok = "0";
    let port = "10100";
    try {
      const cfg = JSON.parse(readFileSync(process.env.OCX_CFG || "", "utf8"));
      if (typeof cfg?.port === "number" && cfg.port > 0) port = String(cfg.port);
      const adv = cfg?.advisor;
      if (adv?.enabled === true && typeof adv?.model === "string" && adv.model.trim() !== "") ok = "1";
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
  printf 'Pass sessionId="%s" so OpenCodex attaches the exact full session transcript directly. ' "$SESSION_ID"
else
  printf 'OpenCodex automatically attaches your active local session transcript alongside any context you pass. '
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

# OpenCodex Advisor (\`consult_advisor\`)

You have access to the stronger OpenCodex Advisor model via \`consult_advisor\` under MCP server \`opencodex-advisor\` (in clients with MCP lazy-loading such as Qoder, call \`mcp_get\` / \`mcp_call\` with \`mcp__opencodex_advisor__consult_advisor\` or \`mcp__opencodex-advisor__consult_advisor\`).

## When to consult proactively
1. **Before locking a complex/high-risk architecture plan**: concurrency/state-machine edge cases, multi-process synchronization, cross-file refactors.
2. **Stuck debugging**: after 2 repair attempts hit the same or similar error — do not blindly guess a 3rd fix before getting an independent review.
3. **Final verification**: before declaring a non-trivial fix complete.

## How to invoke
- Direct MCP clients: call \`consult_advisor({ question, context?, sessionId? })\`.
- Lazy-loading MCP clients (e.g. Qoder): call \`mcp_get({ toolName: "mcp__opencodex_advisor__consult_advisor" })\` or \`mcp_call({ toolName: "mcp__opencodex_advisor__consult_advisor", arguments: { question, context?, sessionId? } })\`.
- Pass \`sessionId\` when available so OpenCodex attaches your local session transcript cleanly.
- If the call returns \`status: "in_progress"\` with \`consultationId\` and \`elapsedMs\`, immediately poll again with \`{ "consultationId": "...", "afterElapsedMs": <elapsedMs> }\` (updating \`afterElapsedMs\` each round avoids duplicate-tool-call guards).
`;

function entryMatchesAdvisorHook(entry: unknown, hookScriptPath: string): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(item => isPlainObject(item)
    && typeof item.command === "string"
    && (item.command === hookScriptPath || item.command.endsWith("opencodex-advisor-notice.sh")));
}

function mountHooksAndSkill(spec: ClientSpec, paths: ResolvedClientPaths, configDir: string): void {
  if (spec.supportsHooks && paths.hookConfigPath && paths.hookScriptPath) {
    mkdirSync(dirname(paths.hookScriptPath), { recursive: true, mode: 0o700 });
    atomicWriteFile(paths.hookScriptPath, buildNoticeHookScript(configDir));
    chmodSync(paths.hookScriptPath, 0o755);

    const read = readJsonObject(paths.hookConfigPath);
    if (!read.parseError && read.doc) {
      const next = { ...read.doc };
      const hooks = isPlainObject(next.hooks) ? { ...next.hooks } : {};
      const existing = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
      const alreadyHasHook = existing.some(entry => entryMatchesAdvisorHook(entry, paths.hookScriptPath!))
        && existing.filter(entry => entryMatchesAdvisorHook(entry, paths.hookScriptPath!)).length === 1;
      const filtered = existing.filter(entry => !entryMatchesAdvisorHook(entry, paths.hookScriptPath!));
      filtered.push({
        hooks: [{ type: "command", command: paths.hookScriptPath }],
      });
      hooks.UserPromptSubmit = filtered;
      next.hooks = hooks;
      const nextText = `${JSON.stringify(next, null, 2)}\n`;
      if (!alreadyHasHook || read.text !== nextText) {
        backupOnceBeforeEdit(configDir, spec.id, paths.hookConfigPath, read.text);
        mkdirSync(dirname(paths.hookConfigPath), { recursive: true, mode: 0o700 });
        atomicWriteFile(paths.hookConfigPath, nextText);
        if (paths.sharedWithRouting && paths.hookConfigPath === paths.mcpConfigPath) {
          syncOwnershipFingerprintIfClean(configDir, spec.id, paths.hookConfigPath, read.text, nextText);
        }
      }
    }
  }
  if (spec.supportsSkills && paths.skillPath) {
    mkdirSync(dirname(paths.skillPath), { recursive: true, mode: 0o700 });
    atomicWriteFile(paths.skillPath, ADVISOR_SKILL_CONTENT);
  }
}

function unmountHooksAndSkill(spec: ClientSpec, paths: ResolvedClientPaths, configDir: string): void {
  if (spec.supportsHooks && paths.hookConfigPath && paths.hookScriptPath) {
    const read = readJsonObject(paths.hookConfigPath);
    if (!read.parseError && read.doc && isPlainObject(read.doc.hooks)) {
      const hooks = { ...read.doc.hooks };
      if (Array.isArray(hooks.UserPromptSubmit)) {
        const nextArr = hooks.UserPromptSubmit.filter(entry => !entryMatchesAdvisorHook(entry, paths.hookScriptPath!));
        if (nextArr.length !== hooks.UserPromptSubmit.length) {
          backupOnceBeforeEdit(configDir, spec.id, paths.hookConfigPath, read.text);
          if (nextArr.length === 0) delete hooks.UserPromptSubmit;
          else hooks.UserPromptSubmit = nextArr;
          const nextDoc = { ...read.doc };
          if (Object.keys(hooks).length === 0) delete nextDoc.hooks;
          else nextDoc.hooks = hooks;
          const nextText = `${JSON.stringify(nextDoc, null, 2)}\n`;
          atomicWriteFile(paths.hookConfigPath, nextText);
          if (paths.sharedWithRouting && paths.hookConfigPath === paths.mcpConfigPath) {
            syncOwnershipFingerprintIfClean(configDir, spec.id, paths.hookConfigPath, read.text, nextText);
          }
        }
      }
    }
    try {
      rmSync(paths.hookScriptPath, { force: true });
    } catch { /* ignore */ }
  }
  if (spec.supportsSkills && paths.skillPath) {
    try {
      rmSync(dirname(paths.skillPath), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
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
  const env = options?.env ?? process.env;
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
  const skillMounted = Boolean(spec.supportsSkills && paths.skillPath && existsSync(paths.skillPath));

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

export function mountAdvisorMcpForClient(
  clientId: AdvisorMcpClientId,
  options?: AdvisorMcpSyncOptions,
): { ok: boolean; changed: boolean; error?: string; status?: AdvisorMcpClientStatus } {
  const home = resolveSafeHome(options);
  if (!home) return { ok: true, changed: false };
  const spec = CLIENT_SPECS[clientId];
  const env = options?.env ?? process.env;
  const configDir = resolveOpencodeConfigDir(options);
  const paths = spec.resolvePaths(home, env);

  const read = readJsonObject(paths.mcpConfigPath);
  if (read.parseError || !read.doc) {
    return { ok: false, changed: false, error: `Refused to overwrite invalid JSON in ${paths.mcpConfigPath}` };
  }

  const container = isPlainObject(read.doc[spec.mcpContainer]) ? { ...(read.doc[spec.mcpContainer] as JsonObj) } : {};
  const desired = buildMcpEntry(spec);
  const currentText = JSON.stringify(container[ADVISOR_MCP_SERVER_NAME] ?? null);
  const desiredText = JSON.stringify(desired);
  let changed = false;

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

  mountHooksAndSkill(spec, paths, configDir);
  return { ok: true, changed, status: inspectAdvisorMcpClientStatus(clientId, {}, options) };
}

export function unmountAdvisorMcpForClient(
  clientId: AdvisorMcpClientId,
  options?: AdvisorMcpSyncOptions,
): { ok: boolean; changed: boolean; error?: string } {
  const home = resolveSafeHome(options);
  if (!home) return { ok: true, changed: false };
  const spec = CLIENT_SPECS[clientId];
  const env = options?.env ?? process.env;
  const configDir = resolveOpencodeConfigDir(options);
  const paths = spec.resolvePaths(home, env);

  let changed = false;
  if (existsSync(paths.mcpConfigPath)) {
    const read = readJsonObject(paths.mcpConfigPath);
    if (read.parseError || !read.doc) {
      return { ok: false, changed: false, error: `Refused to edit invalid JSON in ${paths.mcpConfigPath}` };
    }
    if (isPlainObject(read.doc[spec.mcpContainer])) {
      const container = { ...(read.doc[spec.mcpContainer] as JsonObj) };
      if (ADVISOR_MCP_SERVER_NAME in container) {
        backupOnceBeforeEdit(configDir, spec.id, paths.mcpConfigPath, read.text);
        delete container[ADVISOR_MCP_SERVER_NAME];
        const nextDoc = { ...read.doc, [spec.mcpContainer]: container };
        const nextText = `${JSON.stringify(nextDoc, null, 2)}\n`;
        atomicWriteFile(paths.mcpConfigPath, nextText);
        if (paths.sharedWithRouting) {
          syncOwnershipFingerprintIfClean(configDir, clientId, paths.mcpConfigPath, read.text, nextText);
        }
        changed = true;
      }
    }
  }

  unmountHooksAndSkill(spec, paths, configDir);
  return { ok: true, changed };
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
  const settings = resolveAdvisorSettings(config);
  const configDir = resolveOpencodeConfigDir(options);
  const routedSet = readRoutedClientSet(configDir);

  const desiredTargets = new Set<AdvisorMcpClientId>();
  if (settings.enabled) {
    if (settings.mcpClients) {
      for (const id of settings.mcpClients) desiredTargets.add(id);
    } else if (settings.autoMountMcp) {
      for (const id of ADVISOR_MCP_CLIENT_IDS) {
        if (CLIENT_SPECS[id].defaultAutoMount && routedSet.has(id)) {
          desiredTargets.add(id);
        }
      }
    }
  }

  const mounted: AdvisorMcpClientId[] = [];
  const unmounted: AdvisorMcpClientId[] = [];
  const errors: Array<{ clientId: AdvisorMcpClientId; message: string }> = [];

  for (const id of ADVISOR_MCP_CLIENT_IDS) {
    if (desiredTargets.has(id)) {
      const res = mountAdvisorMcpForClient(id, options);
      if (!res.ok && res.error) errors.push({ clientId: id, message: res.error });
      else if (res.changed) mounted.push(id);
    } else {
      const status = inspectAdvisorMcpClientStatus(id, config, options, routedSet);
      if (status.mounted || status.hooksMounted || status.skillMounted) {
        const res = unmountAdvisorMcpForClient(id, options);
        if (!res.ok && res.error) errors.push({ clientId: id, message: res.error });
        else if (res.changed) unmounted.push(id);
      }
    }
  }

  return {
    mounted,
    unmounted,
    errors,
    statuses: listAdvisorMcpClientStatuses(config, options),
  };
}
