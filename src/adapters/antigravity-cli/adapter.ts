import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../base";
import { loadConfig } from "../../config";
import { InvalidProviderEgressError, resolveProviderEgress } from "../../lib/provider-egress";
import type { SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import { isStandaloneBinary } from "../../lib/standalone";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import { modelRecordValue } from "../../reasoning-effort";
import { inspectBatchDispatcher } from "../coding-agent/batch-dispatcher";
import { isBatchDispatcher, resolveCodingAgentBinary, resolveProfileByBaseUrl } from "../coding-agent/profile";
import {
  CodingAgentProtocolError,
  projectedHistoryCharLimit,
  readJsonLines,
  type StreamMessage,
} from "../coding-agent/protocol";
import {
  baseScopedEnv,
  codeBuddyMcpInvocation,
  redactSecrets,
  runCodingAgentTurn,
  type CodingAgentDeps,
} from "../coding-agent/turn";
import {
  ANTIGRAVITY_CLI_CONTEXT_WINDOW,
  ANTIGRAVITY_CLI_PROFILES,
  findAntigravityCliBinary,
  resolveAntigravityCliModelSlug,
} from "./profiles";
import { normalizeAntigravityComparablePath } from "./pretool-guard";
import {
  addRawAntigravityUsage,
  ANTIGRAVITY_BRIDGE_AGENT_NAME,
  AntigravityTerminalRefusalProtocolError,
  buildAntigravityAgentMarkdown,
  buildAntigravityCliConversationInput,
  buildAntigravityCliRulesMarkdown,
  buildAntigravityCliToolBridge,
  capUtf8Bytes,
  classifyAntigravityCliError,
  createAntigravityStreamState,
  extractAntigravityStagedImages,
  flushAntigravityBridgedToolCalls,
  mapAntigravityStreamFrame,
  partitionAntigravityMessages,
  redactAntigravityLogText,
  releaseAntigravityToolBudgets,
  stableAntigravityMessageText,
  type AntigravityCliToolBridge,
  type AntigravityStreamState,
  type RawAntigravityUsage,
} from "./protocol";
import {
  AntigravitySessionPool,
  buildAntigravitySessionSignature,
  createTurnFrameStopHandle,
  defaultAntigravitySessionPool,
  removeAntigravityPathBestEffort,
  WarmAntigravitySession,
  type WarmParkedToolCall,
} from "./session-pool";

const CAPTURE_MCP_SERVER_PATH = fileURLToPath(new URL("../codebuddy/mcp-server.ts", import.meta.url));
const PRE_TOOL_GUARD_PATH = fileURLToPath(new URL("./pretool-guard.ts", import.meta.url));

const DEFAULT_TOOL_BATCH_COALESCE_MS = 80;
const DEFAULT_UNDECLARED_TOOL_GRACE_MS = 10_000;
const DEFAULT_BRIDGED_CAPTURE_TIMEOUT_MS = 90_000;
const DEFAULT_PRELUDE_TRANSIENT_RETRIES = 2;
const DEFAULT_PRELUDE_RETRY_DELAY_MS = 300;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const MAX_LOG_ERROR_BYTES = 2048;
const ANTIGRAVITY_COLD_SINGLE_FRAME_CHAR_LIMIT = 180_000;
const ANTIGRAVITY_EGRESS_PROBE_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const LOOPBACK_NO_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"] as const;

function extractRequestId(incoming: IncomingMeta): string {
  const direct = incoming.requestId?.trim();
  if (direct) return direct;
  const header = incoming.headers?.get("x-opencodex-request-id")
    ?? incoming.headers?.get("x-request-id")
    ?? incoming.headers?.get("request-id")
    ?? incoming.headers?.get("x-ocx-request-id");
  return header?.trim() || "unknown";
}

export type { SpawnFn } from "../coding-agent/turn";

export type AntigravityCliAdapterDeps = CodingAgentDeps & {
  /** Quiet window after a parked tool step to coalesce sibling parallel tool calls (ms). */
  toolBatchCoalesceMs?: number;
  /** Max wait for a PreToolUse-intercepted undeclared tool step to report denial before failing closed (ms). */
  undeclaredToolGraceMs?: number;
  /** Max silence window while waiting for a live bridged MCP tool call to write its capture file (ms). */
  bridgedCaptureTimeoutMs?: number;
  /** Automatic retries on transient upstream transport failures (`EOF`, `ECONNRESET`) before any output is emitted. */
  maxPreludeRetries?: number;
  /** Base backoff delay between transient pre-output retries (ms). */
  preludeRetryDelayMs?: number;
  /** Explicit outbound proxy URL override for tests (`null` forces direct egress). */
  outboundProxy?: string | null;
  /** Override `~/.gemini/antigravity-cli/brain` root for sessionless transcript cleanup in tests. */
  brainDir?: string;
  /** Enable warm multi-turn / tool-continuation session reuse (defaults to `true` when `spawn` is not mocked). */
  enableSessionPool?: boolean;
  /** Custom warm session pool instance for hermetic tests. */
  sessionPool?: AntigravitySessionPool;
  /** Optional isolated HOME/USERPROFILE directory on Windows (pass `false` to disable automatic isolation). */
  isolatedHomeDir?: string | false;
};

export interface AntigravityHookEnvPaths {
  execPath: string;
  guardPath: string;
  allowedToolsPath: string;
}

export interface AntigravityOutboundProxyEnv {
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy: string;
}

function buildLoopbackSafeNoProxy(providerNoProxy?: string | string[]): string {
  const seen = new Set<string>();
  const items: string[] = [];
  const pushMany = (raw: string | string[] | undefined): void => {
    if (!raw) return;
    const parts = Array.isArray(raw) ? raw : raw.split(",");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(trimmed);
    }
  };
  pushMany(providerNoProxy);
  pushMany(process.env.NO_PROXY);
  pushMany(process.env.no_proxy);
  pushMany([...LOOPBACK_NO_PROXY_HOSTS]);
  return items.join(",");
}

function isSelfProxyUrl(rawUrl: string | undefined, ownPort: number | undefined): boolean {
  if (!rawUrl || !ownPort) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    return isLoopback && Number(parsed.port) === ownPort;
  } catch {
    return false;
  }
}

export function resolveAntigravityOutboundProxyEnv(
  provider: OcxProviderConfig,
  deps: AntigravityCliAdapterDeps = {},
): AntigravityOutboundProxyEnv | undefined {
  const egress = resolveProviderEgress({
    providerName: "antigravity-cli",
    provider,
    url: ANTIGRAVITY_EGRESS_PROBE_URL,
  });
  if (egress.kind === "direct") {
    return { noProxy: "*" };
  }
  const noProxy = buildLoopbackSafeNoProxy(provider.noProxy);
  if (egress.kind === "proxy") {
    return egress.transport === "socks5"
      ? { allProxy: egress.proxyUrl, httpProxy: egress.proxyUrl, httpsProxy: egress.proxyUrl, noProxy }
      : { httpProxy: egress.proxyUrl, httpsProxy: egress.proxyUrl, noProxy };
  }
  if (deps.outboundProxy !== undefined) {
    if (deps.outboundProxy === null) return undefined;
    const trimmed = deps.outboundProxy.trim();
    if (!trimmed) return undefined;
    return /^socks5h?:\/\//i.test(trimmed)
      ? { allProxy: trimmed, httpProxy: trimmed, httpsProxy: trimmed, noProxy }
      : { httpProxy: trimmed, httpsProxy: trimmed, noProxy };
  }
  if (deps.spawn !== undefined) return undefined;

  let ownPort: number | undefined;
  let configuredProxy: string | undefined;
  try {
    const cfg = loadConfig();
    ownPort = typeof cfg.port === "number" ? cfg.port : undefined;
    if (typeof cfg.proxy === "string") {
      const trimmed = cfg.proxy.trim();
      const lower = trimmed.toLowerCase();
      if (trimmed && lower !== "auto" && lower !== "direct") configuredProxy = trimmed;
    }
  } catch {
    // Fall back to process.env when config cannot be read.
  }

  let httpProxy = process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim();
  let httpsProxy = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  let allProxy = process.env.ALL_PROXY?.trim() || process.env.all_proxy?.trim();
  if (!httpProxy && !httpsProxy && !allProxy && configuredProxy) {
    if (/^socks5h?:\/\//i.test(configuredProxy)) {
      allProxy = configuredProxy;
    } else {
      httpProxy = configuredProxy;
      httpsProxy = configuredProxy;
    }
  }
  if (isSelfProxyUrl(httpProxy, ownPort)) httpProxy = undefined;
  if (isSelfProxyUrl(httpsProxy, ownPort)) httpsProxy = undefined;
  if (isSelfProxyUrl(allProxy, ownPort)) allProxy = undefined;
  if (!httpProxy && !httpsProxy && !allProxy) return undefined;
  if (allProxy && !httpProxy && !httpsProxy) {
    httpProxy = allProxy;
    httpsProxy = allProxy;
  }
  return { httpProxy, httpsProxy, allProxy, noProxy };
}

/**
 * Scoped child-process environment for one Antigravity CLI turn.
 *
 * Preserves the operator's OS keyring / home reachability so `agy` can read its own Google sign-in
 * without OpenCodex ever touching or storing the OAuth token, while stripping unconfigured ambient
 * vendor/proxy env vars and forwarding only OpenCodex's validated outbound proxy (with loopback
 * `NO_PROXY` guards). On Windows (where `agy` authenticates via Windows Credential Manager
 * independent of `USERPROFILE`), an isolated empty home directory skips booting user global MCP
 * servers (`~/.gemini/config/mcp_config.json`) and global rules/skills.
 */
export function buildChildEnv(
  hookPaths?: AntigravityHookEnvPaths,
  isolatedHomeDir?: string,
  outboundProxy?: AntigravityOutboundProxyEnv,
): Record<string, string> {
  const env: Record<string, string> = {
    ...baseScopedEnv(),
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const key of ["USER", "LOGNAME", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  if (isolatedHomeDir) {
    env.HOME = isolatedHomeDir;
    env.USERPROFILE = isolatedHomeDir;
  }
  if (outboundProxy) {
    if (outboundProxy.httpProxy) {
      env.HTTP_PROXY = outboundProxy.httpProxy;
      env.http_proxy = outboundProxy.httpProxy;
    }
    if (outboundProxy.httpsProxy) {
      env.HTTPS_PROXY = outboundProxy.httpsProxy;
      env.https_proxy = outboundProxy.httpsProxy;
    }
    if (outboundProxy.allProxy) {
      env.ALL_PROXY = outboundProxy.allProxy;
      env.all_proxy = outboundProxy.allProxy;
    }
    env.NO_PROXY = outboundProxy.noProxy;
    env.no_proxy = outboundProxy.noProxy;
  }
  if (hookPaths) {
    env.OCX_AGY_EXEC = hookPaths.execPath;
    env.OCX_AGY_GUARD = hookPaths.guardPath;
    env.OCX_AGY_ALLOWED = hookPaths.allowedToolsPath;
  }
  return env;
}

/**
 * Build headless `agy` arguments for one turn.
 *
 * Note `--print=` (with `=`): `agy` parses flags with Go's flag style, where a bare `-p` followed by
 * `--output-format` consumes `--output-format` as the inline prompt string and exits with code 2.
 * `--agent ocx_bridge` selects the staged `.agents/agents/ocx_bridge/agent.md` profile, replacing
 * `agy`'s built-in IDE system prompt and setting `inheritMcp: false`.
 */
export function buildArgs(resolvedModelSlug: string, settingsPath: string): string[] {
  return [
    "--print=",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--disable-slash-commands",
    "--agent", ANTIGRAVITY_BRIDGE_AGENT_NAME,
    "--settings", settingsPath,
    "--model", resolvedModelSlug,
  ];
}

/** Official `https://antigravity.google/schemas/v1/settings.json` payload for an isolated turn. */
export function buildAntigravitySettings(
  turnDir: string,
  toolBridge?: AntigravityCliToolBridge,
  hasStagedImages = false,
): Record<string, unknown> {
  const allow: string[] = [];
  if (hasStagedImages) allow.push("read_file(.ocx-images/*)");
  if (toolBridge) allow.push(`mcp(${toolBridge.serverName}/*)`);

  // `agy` evaluates `deny` ahead of `allow` in every mode. When staged images are present, narrow
  // `read_file` deny rules to staged metadata files while `ocx-pretool-guard` enforces exact path
  // membership inside `.ocx-images/*`.
  const readDeny = hasStagedImages
    ? [
        "read_file(settings.json)",
        "read_file(allowed-tools.json)",
        "read_file(catalog.json)",
        "read_file(captured-calls.jsonl)",
        "read_file(tool-results.jsonl)",
        "read_file(.agents/*)",
      ]
    : ["read_file(*)"];

  return {
    agentMode: "",
    allowNonWorkspaceAccess: false,
    artifactReviewPolicy: "asks-for-review",
    disableSlashCommands: true,
    enableTerminalSandbox: false,
    historySize: 0,
    modelProvider: "",
    notifications: false,
    showFeedbackSurvey: false,
    showTips: false,
    toolPermission: "request-review",
    trustedWorkspaces: [turnDir],
    useG1Credits: false,
    permissions: {
      allow,
      deny: [
        "command(*)",
        ...readDeny,
        "write_file(*)",
        "read_url(*)",
        "execute_url(*)",
        ...(toolBridge ? [] : ["mcp(*)"]),
      ],
    },
  };
}

function hasUnsafeHookPathChar(value: string): boolean {
  return /["\r\n]/.test(value);
}

interface CapturedMcpCallRecord {
  seq?: number;
  name: string;
  arguments: Record<string, unknown>;
}

function readCapturedMcpCalls(
  capturePath: string,
  pending: ReadonlyArray<{ mcpAlias: string }>,
  minSeq = 1,
): { ready: boolean; calls: CapturedMcpCallRecord[] } {
  let raw = "";
  try {
    raw = readFileSync(capturePath, "utf8");
  } catch {
    return { ready: false, calls: [] };
  }
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  const calls: CapturedMcpCallRecord[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.name === "string") {
          const seq = typeof rec.seq === "number" && Number.isInteger(rec.seq) && rec.seq > 0
            ? rec.seq
            : undefined;
          if (seq !== undefined && seq < minSeq) continue;
          const args = rec.arguments && typeof rec.arguments === "object" && !Array.isArray(rec.arguments)
            ? (rec.arguments as Record<string, unknown>)
            : {};
          calls.push({ seq, name: rec.name, arguments: args });
        }
      }
    } catch {
      return { ready: false, calls: [] };
    }
  }
  const used = new Set<number>();
  for (const item of pending) {
    const idx = calls.findIndex((c, i) => !used.has(i) && c.name === item.mcpAlias);
    if (idx < 0) return { ready: false, calls };
    used.add(idx);
  }
  return { ready: true, calls };
}

export function buildAntigravityHooksConfig(
  platform: NodeJS.Platform = process.platform,
  standalone = isStandaloneBinary(),
): Record<string, unknown> {
  // `if 1==1` prevents `cmd.exe /c` outer-quote stripping when `%OCX_AGY_EXEC%` contains spaces
  // without invoking `call`'s second `%VAR%` / `^` batch-expansion pass on runtime/temp paths.
  const command = platform === "win32"
    ? (standalone
      ? 'if 1==1 "%OCX_AGY_EXEC%" __antigravity-hook "%OCX_AGY_ALLOWED%"'
      : 'if 1==1 "%OCX_AGY_EXEC%" "%OCX_AGY_GUARD%" "%OCX_AGY_ALLOWED%"')
    : (standalone
      ? '"$OCX_AGY_EXEC" __antigravity-hook "$OCX_AGY_ALLOWED"'
      : '"$OCX_AGY_EXEC" "$OCX_AGY_GUARD" "$OCX_AGY_ALLOWED"');
  return {
    "ocx-pretool-guard": {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command,
            },
          ],
        },
      ],
    },
  };
}

interface StagedAntigravityWorkspace {
  turnDir: string;
  ownedHomeDir?: string;
  effectiveHomeDir?: string;
  settingsPath: string;
  allowedToolsPath: string;
  capturePath: string;
  resultsPath: string;
  stagedImages: Array<{ index: number; relativePath: string; absolutePath: string }>;
  normalizedStagedImagePaths: Set<string>;
}

async function stageAntigravityWorkspace(options: {
  parsed: OcxParsedRequest;
  toolBridge: AntigravityCliToolBridge | undefined;
  imageSpecs: ReadonlyArray<{ index: number; fileName: string; relativePath: string; bytes: Buffer }>;
  platform: NodeJS.Platform;
  writeStagingFile: typeof writeFile;
  enableResultsChannel: boolean;
  isolatedHomeSetting: string | false | undefined;
  hasMockSpawn: boolean;
}): Promise<StagedAntigravityWorkspace> {
  const {
    parsed,
    toolBridge,
    imageSpecs,
    platform,
    writeStagingFile,
    enableResultsChannel,
    isolatedHomeSetting,
    hasMockSpawn,
  } = options;
  const hasStagedImages = imageSpecs.length > 0;
  let turnDir: string | undefined;
  let ownedHomeDir: string | undefined;

  try {
    turnDir = await mkdtemp(join(tmpdir(), "ocx-antigravity-cli-"));
    if (typeof isolatedHomeSetting === "string") {
      await mkdir(isolatedHomeSetting, { recursive: true, mode: 0o700 });
    } else if (
      isolatedHomeSetting !== false
      && platform === "win32"
      && !hasMockSpawn
      && !existsSync(join(homedir(), ".gemini", "jetski-standalone-oauth-token"))
    ) {
      ownedHomeDir = await mkdtemp(join(tmpdir(), "ocx-antigravity-home-"));
    }
    const effectiveHomeDir = typeof isolatedHomeSetting === "string" ? isolatedHomeSetting : ownedHomeDir;

    const agentsDir = join(turnDir, ".agents");
    const bridgeAgentDir = join(agentsDir, "agents", ANTIGRAVITY_BRIDGE_AGENT_NAME);
    await mkdir(bridgeAgentDir, { recursive: true, mode: 0o700 });

    const settingsPath = join(turnDir, "settings.json");
    const allowedToolsPath = join(turnDir, "allowed-tools.json");
    if (
      hasUnsafeHookPathChar(process.execPath)
      || hasUnsafeHookPathChar(PRE_TOOL_GUARD_PATH)
      || hasUnsafeHookPathChar(allowedToolsPath)
    ) {
      throw new Error("Unsafe quote or newline in PreToolUse hook path.");
    }

    const stagedImagePaths: string[] = [];
    const stagedImages: Array<{ index: number; relativePath: string; absolutePath: string }> = [];
    const normalizedStagedImagePaths = new Set<string>();

    if (hasStagedImages) {
      const imagesDir = join(turnDir, ".ocx-images");
      await mkdir(imagesDir, { recursive: true, mode: 0o700 });
      for (const spec of imageSpecs) {
        const imgPath = join(imagesDir, spec.fileName);
        await writeStagingFile(imgPath, spec.bytes, { mode: 0o600, flag: "wx" });
        stagedImagePaths.push(imgPath);
        stagedImages.push({
          index: spec.index,
          relativePath: spec.relativePath,
          absolutePath: imgPath,
        });
        const norm = normalizeAntigravityComparablePath(imgPath, turnDir, platform);
        if (norm) normalizedStagedImagePaths.add(norm);
        try {
          const realNorm = normalizeAntigravityComparablePath(realpathSync(imgPath), turnDir, platform);
          if (realNorm) normalizedStagedImagePaths.add(realNorm);
        } catch {
          // Mocked writeStagingFile in unit tests need not create real disk files.
        }
      }
    }

    let capturePath = "";
    let resultsPath = "";
    let mcpServer: { command: string; args: string[] } | undefined;
    if (toolBridge) {
      const catalogPath = join(turnDir, "catalog.json");
      capturePath = join(turnDir, "captured-calls.jsonl");
      if (enableResultsChannel) {
        resultsPath = join(turnDir, "tool-results.jsonl");
      }
      await writeStagingFile(
        catalogPath,
        JSON.stringify(toolBridge.tools),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      mcpServer = {
        command: process.execPath,
        args: codeBuddyMcpInvocation(
          CAPTURE_MCP_SERVER_PATH,
          catalogPath,
          undefined,
          capturePath,
          resultsPath || undefined,
        ),
      };
    }

    await writeStagingFile(
      join(bridgeAgentDir, "agent.md"),
      buildAntigravityAgentMarkdown(parsed, { toolBridge, hasStagedImages, mcpServer }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await writeStagingFile(
      allowedToolsPath,
      JSON.stringify({
        tools: toolBridge ? [...toolBridge.emittedNameMap.keys()] : [],
        imagePaths: stagedImagePaths,
        turnDir,
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await writeStagingFile(
      join(agentsDir, "hooks.json"),
      JSON.stringify(buildAntigravityHooksConfig(platform)),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await writeStagingFile(
      settingsPath,
      JSON.stringify(buildAntigravitySettings(turnDir, toolBridge, hasStagedImages)),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    return {
      turnDir,
      ownedHomeDir,
      effectiveHomeDir,
      settingsPath,
      allowedToolsPath,
      capturePath,
      resultsPath,
      stagedImages,
      normalizedStagedImagePaths,
    };
  } catch (err) {
    if (turnDir) await removeAntigravityPathBestEffort(turnDir);
    if (ownedHomeDir) await removeAntigravityPathBestEffort(ownedHomeDir);
    throw err;
  }
}

interface ConsumeAntigravityFramesResult {
  failClosed: boolean;
  parkedOnToolUse: boolean;
  emittedAssistantText: string;
}

async function consumeAntigravityTurnFrames(options: {
  nextFrame: () => Promise<StreamMessage | undefined>;
  state: AntigravityStreamState;
  toolBridge: AntigravityCliToolBridge | undefined;
  capturePath: string;
  minCaptureSeq: number;
  requireCaptureFileForPark: boolean;
  coalesceMs: number;
  undeclaredGraceMs: number;
  bridgedCaptureTimeoutMs: number;
  requestId: string;
  incoming: IncomingMeta;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  emitOnce: (event: AdapterEvent) => void;
  isTerminalEmitted: () => boolean;
  isProcessSettled: () => boolean;
  abortTurnAndKill: () => void;
  parkTurnOnToolUse: () => void;
}): Promise<ConsumeAntigravityFramesResult> {
  const {
    nextFrame,
    state,
    toolBridge,
    capturePath,
    minCaptureSeq,
    requireCaptureFileForPark,
    coalesceMs,
    undeclaredGraceMs,
    bridgedCaptureTimeoutMs,
    requestId,
    incoming,
    setTimeoutFn,
    clearTimeoutFn,
    emitOnce,
    isTerminalEmitted,
    isProcessSettled,
    abortTurnAndKill,
    parkTurnOnToolUse,
  } = options;

  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let undeclaredTimer: ReturnType<typeof setTimeout> | undefined;
  let lastBridgedStepAt = Date.now();
  let failClosed = false;
  let parkedOnToolUse = false;
  let emittedAssistantText = "";

  const emitTracked = (event: AdapterEvent): void => {
    if (event.type === "text_delta") emittedAssistantText += event.text;
    emitOnce(event);
  };

  const clearCoalesce = (): void => {
    if (coalesceTimer !== undefined) {
      clearTimeoutFn(coalesceTimer);
      coalesceTimer = undefined;
    }
  };
  const clearUndeclaredTimer = (): void => {
    if (undeclaredTimer !== undefined) {
      clearTimeoutFn(undeclaredTimer);
      undeclaredTimer = undefined;
    }
  };
  const emitUndeclaredToolError = (toolName: string): void => {
    failClosed = true;
    clearCoalesce();
    clearUndeclaredTimer();
    emitTracked({
      type: "error",
      message: `Antigravity CLI attempted a tool call outside the isolated catalog (${redactSecrets(toolName, undefined)}).`,
      status: 502,
      errorType: "upstream_error",
      code: "undeclared_tool_call",
      retryable: false,
      terminalRefusal: true,
    });
    abortTurnAndKill();
  };
  const syncUndeclaredTimer = (madeDenialProgress: boolean): void => {
    if (state.pendingUndeclaredTools.size === 0) {
      clearUndeclaredTimer();
      return;
    }
    if (madeDenialProgress) clearUndeclaredTimer();
    if (undeclaredTimer !== undefined) return;
    undeclaredTimer = setTimeoutFn(() => {
      undeclaredTimer = undefined;
      if (isTerminalEmitted() || failClosed || incoming.abortSignal?.aborted) return;
      const pending = state.pendingUndeclaredTools.values().next().value;
      if (pending) emitUndeclaredToolError(pending);
    }, undeclaredGraceMs);
  };
  const armToolBatchCoalesce = (delayMs = coalesceMs): void => {
    clearCoalesce();
    coalesceTimer = setTimeoutFn(() => {
      coalesceTimer = undefined;
      if (isTerminalEmitted() || failClosed || incoming.abortSignal?.aborted) return;
      if (
        isProcessSettled()
        || state.pendingUndeclaredTools.size > 0
        || state.pendingBridgedToolCalls.length === 0
      ) {
        return;
      }

      let capturedMcpCalls: CapturedMcpCallRecord[] | undefined;
      const shouldReadCapture = Boolean(
        capturePath
        && state.pendingBridgedToolCalls.length > 0
        && (requireCaptureFileForPark || existsSync(capturePath)),
      );
      if (shouldReadCapture) {
        const captured = readCapturedMcpCalls(capturePath, state.pendingBridgedToolCalls, minCaptureSeq);
        if (!captured.ready) {
          if (Date.now() - lastBridgedStepAt < bridgedCaptureTimeoutMs) {
            armToolBatchCoalesce(Math.min(25, coalesceMs));
            return;
          }
          failClosed = true;
          emitTracked({
            type: "error",
            message: "Antigravity CLI isolated MCP bridge did not receive the expected tool call payload.",
            status: 502,
            errorType: "upstream_error",
            code: "protocol_error",
            retryable: false,
            terminalRefusal: true,
          });
          abortTurnAndKill();
          return;
        }
        capturedMcpCalls = captured.calls;
      }

      try {
        const flushedEvents = flushAntigravityBridgedToolCalls(state, capturedMcpCalls);
        if (flushedEvents.length === 0) return;
        for (const event of flushedEvents) {
          emitTracked(event);
        }
      } catch (err) {
        failClosed = true;
        emitTracked({
          type: "error",
          message: redactSecrets(err instanceof Error ? err.message : String(err), undefined),
          status: 502,
          errorType: "upstream_error",
          code: isTranslatorBudgetExceededError(err) ? err.code : "protocol_error",
          retryable: false,
        });
        abortTurnAndKill();
        return;
      }

      parkedOnToolUse = true;
      emitTracked({
        type: "done",
        stopReason: "tool_use",
        endTurn: false,
        ...(state.partialUsage ? { usage: state.partialUsage } : {}),
      });
      parkTurnOnToolUse();
    }, delayMs);
  };

  try {
    while (true) {
      const frame = await nextFrame();
      if (!frame || incoming.abortSignal?.aborted) break;

      const prevPendingUndeclared = state.pendingUndeclaredTools.size;
      const prevCapturedToolCalls = state.capturedToolCalls;
      const mappedEvents = mapAntigravityStreamFrame(frame, state, toolBridge);

      if (state.initError) {
        failClosed = true;
        emitTracked({
          type: "error",
          message: state.initError,
          status: 502,
          errorType: "upstream_error",
          code: "tool_bridge_init_mismatch",
          retryable: false,
          terminalRefusal: true,
        });
        abortTurnAndKill();
        break;
      }
      if (state.missingInitBeforeTool) {
        failClosed = true;
        emitTracked({
          type: "error",
          message: "Antigravity CLI called a tool before the init handshake completed.",
          status: 502,
          errorType: "upstream_error",
          code: "tool_bridge_init_missing",
          retryable: false,
          terminalRefusal: true,
        });
        abortTurnAndKill();
        break;
      }
      if (state.undeclaredToolName) {
        emitUndeclaredToolError(state.undeclaredToolName);
        break;
      }
      syncUndeclaredTimer(state.pendingUndeclaredTools.size < prevPendingUndeclared);

      if (state.toolCallLimitExceeded) {
        failClosed = true;
        emitTracked({
          type: "error",
          message: `Antigravity CLI returned more than the ${toolBridge?.maxTurnToolCalls ?? 16}-tool-call turn limit.`,
          status: 502,
          errorType: "upstream_error",
          code: "tool_call_limit",
          retryable: false,
          terminalRefusal: true,
        });
        abortTurnAndKill();
        break;
      }

      let sawNewToolCall = state.capturedToolCalls > prevCapturedToolCalls;
      if (sawNewToolCall || (frame.type === "step_update" && state.pendingBridgedToolCalls.length > 0)) {
        lastBridgedStepAt = Date.now();
      }
      for (const event of mappedEvents) {
        if (event.type === "tool_call_end") sawNewToolCall = true;
        if (toolBridge && !state.sawInit && event.type === "done") {
          failClosed = true;
          emitTracked({
            type: "error",
            message: "Antigravity CLI ended before the tool bridge init handshake completed.",
            status: 502,
            errorType: "upstream_error",
            code: "tool_bridge_init_missing",
            retryable: false,
            terminalRefusal: true,
          });
          abortTurnAndKill();
          break;
        }
        if (
          toolBridge?.requireToolCall === true
          && !isTerminalEmitted()
          && event.type === "done"
          && event.stopReason !== "tool_use"
          && state.capturedToolCalls === 0
        ) {
          failClosed = true;
          emitTracked({
            type: "error",
            message: "Antigravity CLI finished without calling the required tool.",
            status: 502,
            errorType: "upstream_error",
            code: "tool_call_required",
            retryable: false,
            terminalRefusal: true,
          });
          abortTurnAndKill();
          break;
        }
        if (
          toolBridge
          && !isTerminalEmitted()
          && event.type === "done"
          && event.stopReason === "stop"
          && state.capturedToolCalls > 0
        ) {
          failClosed = true;
          emitTracked({
            type: "error",
            message: "Antigravity CLI settled with a text result instead of parking on the isolated tool bridge.",
            status: 502,
            errorType: "upstream_error",
            code: "protocol_error",
            retryable: false,
            terminalRefusal: true,
          });
          abortTurnAndKill();
          break;
        }
        if (event.type === "error") {
          failClosed = true;
          clearCoalesce();
          clearUndeclaredTimer();
          emitTracked({ ...event, message: redactSecrets(event.message, undefined) });
          abortTurnAndKill();
          break;
        }
        if (
          event.type === "done"
          && event.stopReason === "stop"
          && !isTerminalEmitted()
          && emittedAssistantText.length === 0
          && state.capturedToolCalls === 0
        ) {
          console.warn(
            `[antigravity-cli] empty completion requestId=${requestId} recentFrames=${JSON.stringify(state.recentFrames)}`,
          );
        }
        emitTracked(event);
      }

      if (failClosed || isTerminalEmitted()) break;
      if (state.pendingUndeclaredTools.size > 0 || state.pendingBridgedToolCalls.length === 0) {
        clearCoalesce();
      } else if (
        toolBridge
        && (sawNewToolCall || (state.pendingBridgedToolCalls.length > 0 && coalesceTimer === undefined))
      ) {
        armToolBatchCoalesce();
      }
    }

    if (
      !incoming.abortSignal?.aborted
      && !failClosed
      && !isTerminalEmitted()
      && state.pendingUndeclaredTools.size > 0
    ) {
      const pending = state.pendingUndeclaredTools.values().next().value;
      if (pending) emitUndeclaredToolError(pending);
    }
  } finally {
    clearCoalesce();
    clearUndeclaredTimer();
    releaseAntigravityToolBudgets(state);
  }

  return { failClosed, parkedOnToolUse, emittedAssistantText };
}

function sumTurnStepUsages(state: AntigravityStreamState): RawAntigravityUsage | undefined {
  let acc: RawAntigravityUsage | undefined;
  for (const raw of state.stepRawUsages.values()) {
    acc = addRawAntigravityUsage(acc, raw);
  }
  return acc;
}

export function createAntigravityCliAdapter(
  provider: OcxProviderConfig,
  deps: AntigravityCliAdapterDeps = {},
): ProviderAdapter {
  return {
    name: "antigravity-cli",

    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "Antigravity CLI adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      const coalesceMs = deps.toolBatchCoalesceMs ?? DEFAULT_TOOL_BATCH_COALESCE_MS;
      const undeclaredGraceMs = deps.undeclaredToolGraceMs ?? DEFAULT_UNDECLARED_TOOL_GRACE_MS;
      const bridgedCaptureTimeoutMs = deps.bridgedCaptureTimeoutMs
        ?? deps.undeclaredToolGraceMs
        ?? DEFAULT_BRIDGED_CAPTURE_TIMEOUT_MS;
      const maxPreludeRetries = Math.max(
        0,
        deps.maxPreludeRetries ?? (deps.spawn === undefined ? DEFAULT_PRELUDE_TRANSIENT_RETRIES : 0),
      );
      const preludeRetryDelayMs = Math.max(0, deps.preludeRetryDelayMs ?? DEFAULT_PRELUDE_RETRY_DELAY_MS);
      const platform = deps.platform ?? process.platform;
      const setTimeoutFn = deps.setTimeout ?? setTimeout;
      const clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
      const writeStagingFile = deps.writeToolBridgeFile ?? writeFile;
      const requestId = extractRequestId(incoming);
      let activeState: AntigravityStreamState | undefined;
      let lastNonZeroExit: { exitCode: number; stderr: string } | undefined;

      const waitAbortable = (delayMs: number): Promise<boolean> => {
        if (delayMs <= 0) return Promise.resolve(!incoming.abortSignal?.aborted);
        return new Promise<boolean>(resolve => {
          if (incoming.abortSignal?.aborted) {
            resolve(false);
            return;
          }
          const onAbort = (): void => {
            clearTimeoutFn(timer);
            resolve(false);
          };
          const timer = setTimeoutFn(() => {
            incoming.abortSignal?.removeEventListener("abort", onAbort);
            resolve(!incoming.abortSignal?.aborted);
          }, delayMs);
          incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      };

      const logErrorWarn = (event: Extract<AdapterEvent, { type: "error" }>): void => {
        const rawSource = activeState?.rawUpstreamError ?? event.message;
        if (activeState) activeState.rawUpstreamError = undefined;
        const redactedRaw = capUtf8Bytes(redactAntigravityLogText(rawSource), MAX_LOG_ERROR_BYTES);
        const parts = [
          "[antigravity-cli] error",
          `requestId=${requestId}`,
          `status=${event.status ?? "none"}`,
          `code=${event.code ?? "none"}`,
          `raw=${JSON.stringify(redactedRaw)}`,
        ];
        if (lastNonZeroExit) {
          parts.push(`exitCode=${lastNonZeroExit.exitCode}`);
          if (lastNonZeroExit.stderr) {
            const redactedStderrTail = capUtf8Bytes(
              redactAntigravityLogText(lastNonZeroExit.stderr),
              MAX_LOG_ERROR_BYTES,
              true,
            );
            parts.push(`stderr=${JSON.stringify(redactedStderrTail)}`);
          }
          lastNonZeroExit = undefined;
        }
        console.warn(parts.join(" "));
      };

      const observedEmit = (event: AdapterEvent): void => {
        if (event.type === "error") logErrorWarn(event);
        emit(event);
      };

      if (incoming.abortSignal?.aborted) {
        observedEmit({ type: "error", message: "Antigravity CLI turn was aborted before start.", retryable: false });
        return;
      }

      const profile = resolveProfileByBaseUrl(ANTIGRAVITY_CLI_PROFILES, provider.baseUrl);
      if (!profile) {
        observedEmit({
          type: "error",
          message: "Provider base URL is not the canonical Antigravity CLI destination.",
          status: 400,
          errorType: "invalid_request_error",
          code: "non_canonical_destination",
          retryable: false,
          terminalRefusal: true,
        });
        return;
      }

      const resolvedModelSlug = resolveAntigravityCliModelSlug(
        parsed.modelId,
        provider,
        parsed.options.reasoning,
      );
      if (!resolvedModelSlug) {
        observedEmit({
          type: "error",
          message:
            `Antigravity CLI provider supports only gemini-4-carbon, gemini-4-argon, and gemini-4-hydrogen (received: ${parsed.modelId}).`,
          status: 400,
          errorType: "invalid_request_error",
          code: "model_not_found",
          retryable: false,
          terminalRefusal: true,
        });
        return;
      }

      let toolBridge: AntigravityCliToolBridge | undefined;
      try {
        toolBridge = buildAntigravityCliToolBridge(parsed);
      } catch (err) {
        observedEmit({
          type: "error",
          message: `Invalid Antigravity CLI tool catalog: ${err instanceof Error ? err.message : String(err)}`,
          status: 400,
          errorType: "invalid_request_error",
          code: "tool_catalog_invalid",
          retryable: false,
          terminalRefusal: true,
        });
        return;
      }

      const historyCharLimit = projectedHistoryCharLimit(
        modelRecordValue(provider.modelContextWindows, parsed.modelId)
          ?? provider.contextWindow
          ?? ANTIGRAVITY_CLI_CONTEXT_WINDOW,
      );
      const baseRulesMarkdown = buildAntigravityCliRulesMarkdown(parsed, toolBridge, false);
      const toolsCatalogJson = JSON.stringify(toolBridge?.tools ?? []);
      // Deduct large system/tool-schema prompt overhead above 16 KB so cold-start or model-switch
      // replays stay safely below Cloud Code Assist's 200k input-token 429 ceiling.
      const promptOverheadChars = Math.max(0, baseRulesMarkdown.length + toolsCatalogJson.length - 16_000);
      const coldHistoryCharLimit = Math.min(
        historyCharLimit,
        Math.max(60_000, ANTIGRAVITY_COLD_SINGLE_FRAME_CHAR_LIMIT - Math.floor(promptOverheadChars * 0.7)),
      );
      const vendorNameByWire = toolBridge
        ? new Map([...toolBridge.emittedNameMap].map(([cliName, wireName]) => [wireName, cliName]))
        : undefined;

      const extractedImages = extractAntigravityStagedImages(parsed, {
        maxHistoryChars: coldHistoryCharLimit,
        vendorNameByWire,
      });
      if (extractedImages.error !== undefined) {
        observedEmit({
          type: "error",
          message: extractedImages.error,
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
          terminalRefusal: true,
        });
        return;
      }
      const imageSpecs = extractedImages.images;
      const hasStagedImages = imageSpecs.length > 0;

      const whichFn = deps.which ?? findAntigravityCliBinary;
      const binary = resolveCodingAgentBinary(profile, whichFn);
      if (!binary) {
        observedEmit({
          type: "error",
          message: `${profile.label} CLI not found on PATH. Install it with: ${profile.installHint}`,
          status: 500,
          errorType: "upstream_error",
          code: "cli_not_found",
          retryable: false,
        });
        return;
      }

      let outboundProxyEnv: AntigravityOutboundProxyEnv | undefined;
      try {
        outboundProxyEnv = resolveAntigravityOutboundProxyEnv(provider, deps);
      } catch (err) {
        if (err instanceof InvalidProviderEgressError) {
          observedEmit({
            type: "error",
            message: err.message,
            status: 400,
            errorType: "invalid_request_error",
            code: "invalid_request_error",
            retryable: false,
            terminalRefusal: true,
          });
          return;
        }
        throw err;
      }

      const poolEnabled = (deps.enableSessionPool ?? (deps.spawn === undefined))
        && !hasStagedImages
        && !parsed.options.textFormat;

      // Single-shot path (staged images, structured JSON output, or hermetic unit tests with mock spawn).
      if (!poolEnabled) {
        for (let preludeAttempt = 0; ; preludeAttempt++) {
          let workspace: StagedAntigravityWorkspace;
          try {
            workspace = await stageAntigravityWorkspace({
              parsed,
              toolBridge,
              imageSpecs,
              platform,
              writeStagingFile,
              enableResultsChannel: false,
              isolatedHomeSetting: deps.isolatedHomeDir,
              hasMockSpawn: deps.spawn !== undefined,
            });
          } catch {
            observedEmit({
              type: "error",
              message: toolBridge
                ? "Antigravity CLI tool bridge could not be staged securely."
                : "Antigravity CLI turn workspace could not be staged securely.",
              status: 500,
              errorType: toolBridge ? "server_error" : "upstream_error",
              code: toolBridge ? "tool_bridge_setup_failed" : "system_prompt_staging_failed",
              retryable: false,
            });
            return;
          }

          const state = createAntigravityStreamState(incoming.translatorBudget, {
            stagedImagePaths: workspace.normalizedStagedImagePaths,
            turnDir: workspace.turnDir,
            platform,
            suppressStepSeparator: Boolean(parsed.options.textFormat),
            deferToolCallEmission: true,
            requestId,
          });
          activeState = state;
          let singleEmittedNonTerminal = false;
          let deferredTransientError: Extract<AdapterEvent, { type: "error" }> | undefined;

          try {
            await runCodingAgentTurn({
              profiles: ANTIGRAVITY_CLI_PROFILES,
              provider,
              parsed,
              incoming,
              emit: event => {
                if (
                  event.type === "error"
                  && !singleEmittedNonTerminal
                  && preludeAttempt < maxPreludeRetries
                  && event.retryable === true
                  && event.status === 502
                  && !event.terminalRefusal
                  && !incoming.abortSignal?.aborted
                ) {
                  deferredTransientError = event;
                  return;
                }
                if (event.type !== "done" && event.type !== "error" && event.type !== "incomplete") {
                  singleEmittedNonTerminal = true;
                }
                observedEmit(event);
              },
              cwd: workspace.turnDir,
              buildArgs: () => buildArgs(resolvedModelSlug, workspace.settingsPath),
              buildEnv: () => buildChildEnv({
                execPath: process.execPath,
                guardPath: PRE_TOOL_GUARD_PATH,
                allowedToolsPath: workspace.allowedToolsPath,
              }, workspace.effectiveHomeDir, outboundProxyEnv),
              conversationInput: req => buildAntigravityCliConversationInput(req, {
                maxHistoryChars: coldHistoryCharLimit,
                vendorNameByWire,
                stagedImages: workspace.stagedImages,
              }),
              classifyFailure: failure => {
                if (failure.source === "process-exit") {
                  lastNonZeroExit = { exitCode: failure.exitCode, stderr: failure.stderrTail ?? failure.stderr };
                }
                if (/emitted forged text tool call/i.test(failure.error.message)) {
                  const { terminalRefusal: _drop, ...rest } = failure.error;
                  return { ...rest, retryable: true };
                }
                if (failure.source !== "process-exit" || !failure.stderr) return failure.error;
                const classified = classifyAntigravityCliError(failure.stderr, state.partialUsage);
                return classified.status !== 502 || classified.retryable ? classified : failure.error;
              },
              consumeStream: async ctx => {
                const iterator = readJsonLines(ctx.stdout as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
                await consumeAntigravityTurnFrames({
                  nextFrame: async () => {
                    const next = await iterator.next();
                    return next.done ? undefined : next.value;
                  },
                  state,
                  toolBridge,
                  capturePath: workspace.capturePath,
                  minCaptureSeq: 1,
                  requireCaptureFileForPark: false,
                  coalesceMs,
                  undeclaredGraceMs,
                  bridgedCaptureTimeoutMs,
                  requestId,
                  incoming,
                  setTimeoutFn,
                  clearTimeoutFn,
                  emitOnce: ctx.emitOnce,
                  isTerminalEmitted: ctx.isTerminalEmitted,
                  isProcessSettled: ctx.isProcessSettled,
                  abortTurnAndKill: () => {
                    ctx.kill();
                    ctx.stopStream();
                  },
                  parkTurnOnToolUse: () => {
                    ctx.kill();
                    ctx.stopStream();
                  },
                });
                return {
                  sawTerminalResult: state.sawTerminalResult,
                  classifyMissingResultStderr: stderr => {
                    const classified = classifyAntigravityCliError(stderr, state.partialUsage);
                    return classified.status !== 502 || classified.retryable ? classified : undefined;
                  },
                };
              },
              deps: { ...deps, which: whichFn },
            });
          } finally {
            await removeAntigravityPathBestEffort(workspace.turnDir);
            if (workspace.ownedHomeDir) {
              await removeAntigravityPathBestEffort(workspace.ownedHomeDir);
            }
            if (state.conversationId) {
              const homeRoot = workspace.effectiveHomeDir ?? homedir();
              const brainRoot = deps.brainDir ?? join(homeRoot, ".gemini", "antigravity-cli", "brain");
              await removeAntigravityPathBestEffort(join(brainRoot, state.conversationId));
            }
          }

          if (!deferredTransientError) return;
          const safeReason = capUtf8Bytes(
            redactAntigravityLogText(activeState?.rawUpstreamError ?? deferredTransientError.message),
            MAX_LOG_ERROR_BYTES,
          );
          if (activeState) activeState.rawUpstreamError = undefined;
          console.warn(
            `[antigravity-cli] transient prelude error requestId=${requestId} attempt=${preludeAttempt + 1}/${maxPreludeRetries + 1} retrying: ${JSON.stringify(safeReason)}`,
          );
          const ok = await waitAbortable(preludeRetryDelayMs * (preludeAttempt + 1));
          if (!ok) {
            observedEmit({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
            return;
          }
        }
      }

      // Pooled warm-session path: eliminates cold `agy` boot and preserves Gemini prompt cache across turns.
      const pool = deps.sessionPool ?? defaultAntigravitySessionPool;
      const rulesMarkdown = baseRulesMarkdown;
      const signature = buildAntigravitySessionSignature({
        baseUrl: outboundProxyEnv ? `${provider.baseUrl}|proxy=${JSON.stringify(outboundProxyEnv)}` : provider.baseUrl,
        resolvedModelSlug,
        rulesMarkdown,
        toolsCatalogJson,
      });

      const { conversation: nonDevMessages } = partitionAntigravityMessages(parsed.context.messages);
      const incomingBlocks = nonDevMessages.map(m => stableAntigravityMessageText(m, vendorNameByWire, parsed.modelId));

      // Attempt warm-session continuation BEFORE cold truncation so multi-turn warm sessions can
      // keep growing past 180 KB via small incremental stdin/tool-result deltas without resetting.
      let warmMatch = pool.acquireContinuation(signature, parsed, vendorNameByWire, clearTimeoutFn);
      let fullConversationLines: string[] | undefined;
      const getColdConversationLines = (): string[] => {
        fullConversationLines ??= buildAntigravityCliConversationInput(parsed, {
          maxHistoryChars: coldHistoryCharLimit,
          vendorNameByWire,
        });
        return fullConversationLines;
      };

      let freshWorkspace: StagedAntigravityWorkspace | undefined;
      if (!warmMatch) {
        try {
          freshWorkspace = await stageAntigravityWorkspace({
            parsed,
            toolBridge,
            imageSpecs: [],
            platform,
            writeStagingFile,
            enableResultsChannel: true,
            isolatedHomeSetting: deps.isolatedHomeDir,
            hasMockSpawn: deps.spawn !== undefined,
          });
        } catch {
          observedEmit({
            type: "error",
            message: toolBridge
              ? "Antigravity CLI tool bridge could not be staged securely."
              : "Antigravity CLI turn workspace could not be staged securely.",
            status: 500,
            errorType: toolBridge ? "server_error" : "upstream_error",
            code: toolBridge ? "tool_bridge_setup_failed" : "system_prompt_staging_failed",
            retryable: false,
          });
          return;
        }

        const checkArgs = buildArgs(resolvedModelSlug, freshWorkspace.settingsPath);
        if (platform === "win32" && isBatchDispatcher(binary) && checkArgs.includes("")) {
          const verdict = inspectBatchDispatcher(binary, deps.readDispatcher);
          if (!verdict.preservesEmptyArguments) {
            await removeAntigravityPathBestEffort(freshWorkspace.turnDir);
            if (freshWorkspace.ownedHomeDir) {
              await removeAntigravityPathBestEffort(freshWorkspace.ownedHomeDir);
            }
            observedEmit({
              type: "error",
              message: `${profile.label} CLI resolved to the batch dispatcher ${win32.basename(binary)}, which cannot preserve empty arguments.`,
              status: 500,
              errorType: "upstream_error",
              code: "cli_dispatcher_drops_empty_args",
              retryable: false,
            });
            return;
          }
        }
      }

      let producer: { close(): void } | undefined;
      let permit: SingleUseDispatchPermit | undefined;
      try {
        if (incoming.abortSignal?.aborted) {
          if (warmMatch) {
            pool.unregisterLive(warmMatch.session);
            await warmMatch.session.dispose();
          }
          if (freshWorkspace) {
            await removeAntigravityPathBestEffort(freshWorkspace.turnDir);
            if (freshWorkspace.ownedHomeDir) {
              await removeAntigravityPathBestEffort(freshWorkspace.ownedHomeDir);
            }
          }
          observedEmit({ type: "error", message: "Antigravity CLI turn was aborted before start.", retryable: false });
          return;
        }

        producer = incoming.sendBudget?.beginSpendProducer?.();
        const decision = incoming.sendBudget?.reserveDispatch({
          sendClass: "initial",
          targetKey: `${provider.adapter}|${profile.canonicalBaseUrl}|${parsed.modelId}`,
        });
        if (decision && !decision.allowed) throw new SendBudgetExhaustedError();
        permit = decision?.allowed ? decision.permit : undefined;
        incoming.beforePhysicalSend?.();
        if (permit && !permit.use()) throw new SendBudgetExhaustedError();
        incoming.onPhysicalSend?.({ ordinal: 1 });

        const spawnFreshSession = async (ws?: StagedAntigravityWorkspace): Promise<WarmAntigravitySession> => {
          const staged = ws ?? await stageAntigravityWorkspace({
            parsed,
            toolBridge,
            imageSpecs: [],
            platform,
            writeStagingFile,
            enableResultsChannel: true,
            isolatedHomeSetting: deps.isolatedHomeDir,
            hasMockSpawn: deps.spawn !== undefined,
          });
          const session = new WarmAntigravitySession({
            signature,
            binary,
            args: buildArgs(resolvedModelSlug, staged.settingsPath),
            env: buildChildEnv({
              execPath: process.execPath,
              guardPath: PRE_TOOL_GUARD_PATH,
              allowedToolsPath: staged.allowedToolsPath,
            }, staged.effectiveHomeDir, outboundProxyEnv),
            cwd: staged.turnDir,
            turnDir: staged.turnDir,
            ownedHomeDir: staged.ownedHomeDir,
            effectiveHomeDir: staged.effectiveHomeDir,
            capturePath: staged.capturePath,
            resultsPath: staged.resultsPath,
            platform,
            brainDirOverride: deps.brainDir,
            spawnFn: deps.spawn,
            killWindowsProcessTree: deps.killWindowsProcessTree,
            killGraceMs: deps.killGraceMs,
            reapTimeoutMs: deps.reapTimeoutMs,
            setTimeoutFn,
            clearTimeoutFn,
          });
          pool.registerLive(session);
          return session;
        };

        const executeOnSession = async (
          session: WarmAntigravitySession,
          isWarmContinuation: boolean,
          dispatchPayload: () => void,
          targetTranscriptBlocks: string[],
          allowPreludeRetry: boolean,
        ): Promise<{ retryOnFreshSession: boolean; transientPreludeError?: Extract<AdapterEvent, { type: "error" }> }> => {
          let terminalEmitted = false;
          let emittedNonTerminal = false;
          let aborted = false;
          let deferredTransientError: Extract<AdapterEvent, { type: "error" }> | undefined;
          lastNonZeroExit = undefined;

          const emitOnce = (event: AdapterEvent): void => {
            if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
              if (terminalEmitted) return;
              if (
                event.type === "error"
                && allowPreludeRetry
                && !emittedNonTerminal
                && event.retryable === true
                && event.status === 502
                && !event.terminalRefusal
                && !aborted
                && !incoming.abortSignal?.aborted
              ) {
                terminalEmitted = true;
                deferredTransientError = event;
                return;
              }
              terminalEmitted = true;
            } else {
              emittedNonTerminal = true;
            }
            observedEmit(event);
          };

          const state = createAntigravityStreamState(incoming.translatorBudget, {
            turnDir: session.turnDir,
            platform,
            suppressStepSeparator: false,
            deferToolCallEmission: true,
            sawInit: isWarmContinuation,
            seenToolStepIndices: session.seenToolStepIndices,
            conversationId: session.conversationId,
            requestId,
            usageBaseline: session.usageBaseline,
          });
          activeState = state;

          const stopHandle = createTurnFrameStopHandle(() => session.notifyTurnStop());
          const killAndDispose = (): void => {
            if (state.conversationId) session.conversationId ??= state.conversationId;
            stopHandle.stop();
            pool.unregisterLive(session);
            void session.dispose();
          };
          const onAbort = (): void => {
            aborted = true;
            killAndDispose();
          };
          incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
          const timeoutMs = deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
          const timeoutTimer = setTimeoutFn(() => {
            killAndDispose();
            emitOnce({
              type: "error",
              message: `${profile.label} turn timed out.`,
              status: 504,
              errorType: "upstream_error",
              code: "timeout",
              retryable: true,
            });
          }, timeoutMs);

          let streamErr: unknown;
          let outcome: ConsumeAntigravityFramesResult | undefined;
          session.markTurnStart();
          try {
            dispatchPayload();
            outcome = await consumeAntigravityTurnFrames({
              nextFrame: () => session.nextFrame(stopHandle),
              state,
              toolBridge,
              capturePath: session.capturePath,
              minCaptureSeq: session.nextCaptureSeq,
              requireCaptureFileForPark: Boolean(toolBridge && deps.spawn === undefined),
              coalesceMs,
              undeclaredGraceMs,
              bridgedCaptureTimeoutMs,
              requestId,
              incoming,
              setTimeoutFn,
              clearTimeoutFn,
              emitOnce,
              isTerminalEmitted: () => terminalEmitted,
              isProcessSettled: () => session.isProcessSettled(),
              abortTurnAndKill: killAndDispose,
              parkTurnOnToolUse: () => stopHandle.stop(),
            });
          } catch (err) {
            streamErr = err;
            killAndDispose();
          } finally {
            clearTimeoutFn(timeoutTimer);
            incoming.abortSignal?.removeEventListener("abort", onAbort);
          }

          if (state.conversationId) session.conversationId ??= state.conversationId;

          // If an idle warm session died before emitting anything, transparently fall back to a fresh spawn.
          if (
            isWarmContinuation
            && !terminalEmitted
            && !emittedNonTerminal
            && !aborted
            && !incoming.abortSignal?.aborted
          ) {
            pool.unregisterLive(session);
            await session.dispose();
            return { retryOnFreshSession: true };
          }

          const canParkToolUse = Boolean(
            outcome?.parkedOnToolUse
            && !outcome.failClosed
            && !streamErr
            && !aborted
            && !incoming.abortSignal?.aborted
            && !session.isProcessSettled()
            && state.flushedToolCalls.length > 0
            && state.flushedToolCalls.every(c => typeof c.seq === "number" && c.seq > 0),
          );
          const canParkIdleStop = Boolean(
            state.sawTerminalResult
            && !outcome?.failClosed
            && !streamErr
            && !aborted
            && !incoming.abortSignal?.aborted
            && !session.isProcessSettled(),
          );

          if (canParkToolUse) {
            const parkedCalls: WarmParkedToolCall[] = state.flushedToolCalls.map(call => ({
              seq: call.seq!,
              callId: call.callId,
              mcpAlias: call.mcpAlias,
              wireName: call.wireName,
              argumentsJson: call.argumentsJson,
            }));
            const maxSeq = Math.max(...parkedCalls.map(c => c.seq));
            session.nextCaptureSeq = Math.max(session.nextCaptureSeq, maxSeq + 1);
            for (const stepIdx of state.seenToolStepIndices) session.seenToolStepIndices.add(stepIdx);
            session.usageBaseline = addRawAntigravityUsage(session.usageBaseline, sumTurnStepUsages(state));
            session.transcriptBlocks = targetTranscriptBlocks;
            session.parkedToolCalls = parkedCalls;
            session.mode = "awaiting_tool_results";
            pool.park(session, setTimeoutFn, clearTimeoutFn);
            return { retryOnFreshSession: false };
          }

          if (canParkIdleStop) {
            for (const stepIdx of state.seenToolStepIndices) session.seenToolStepIndices.add(stepIdx);
            // Whether `agy` accumulates usage across user turns or resets per turn
            // (`rawResult.input_tokens < session.usageBaseline.input_tokens`), `rawResult` is the
            // exact new watermark rather than adding onto the previous `session.usageBaseline`.
            session.usageBaseline = state.resultRawUsage
              ?? addRawAntigravityUsage(session.usageBaseline, sumTurnStepUsages(state));
            session.transcriptBlocks = targetTranscriptBlocks;
            session.lastAssistantText = outcome?.emittedAssistantText ?? "";
            session.parkedToolCalls = [];
            session.mode = "idle_after_stop";
            pool.park(session, setTimeoutFn, clearTimeoutFn);
            return { retryOnFreshSession: false };
          }

          // Any error, abort, or non-parkable completion tears down and reaps the session immediately.
          pool.unregisterLive(session);
          await session.dispose();

          if (!terminalEmitted) {
            const rawStderr = session.readTurnStderr();
            const stderr = redactSecrets(rawStderr, undefined);
            const launchErr = session.getLaunchError();
            const exitCode = session.getExitCode();
            if (incoming.abortSignal?.aborted || aborted) {
              emitOnce({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
            } else if (launchErr) {
              emitOnce({
                type: "error",
                message: `${profile.label} CLI failed to start: ${redactSecrets(launchErr.message, undefined)}`,
                status: 500,
                errorType: "upstream_error",
                code: "cli_spawn_failed",
                retryable: false,
              });
            } else if (streamErr) {
              const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
              const isProto = streamErr instanceof CodingAgentProtocolError || isTranslatorBudgetExceededError(streamErr);
              const isForgedToolHallucination = /emitted forged text tool call/i.test(msg);
              emitOnce({
                type: "error",
                message: redactSecrets(msg, undefined),
                status: 502,
                errorType: "upstream_error",
                code: isTranslatorBudgetExceededError(streamErr)
                  ? streamErr.code
                  : (isProto ? "protocol_error" : "upstream_error"),
                retryable: isForgedToolHallucination,
                ...(streamErr instanceof AntigravityTerminalRefusalProtocolError && !isForgedToolHallucination
                  ? { terminalRefusal: true as const }
                  : {}),
              });
            } else if (exitCode !== null && exitCode !== 0) {
              lastNonZeroExit = { exitCode, stderr: rawStderr };
              const classified = stderr ? classifyAntigravityCliError(stderr, state.partialUsage) : undefined;
              if (classified && (classified.status !== 502 || classified.retryable)) {
                emitOnce(classified);
              } else {
                emitOnce({
                  type: "error",
                  message: stderr
                    ? `${profile.label} CLI exited with code ${exitCode}: ${stderr}`
                    : `${profile.label} CLI exited with non-zero exit code ${exitCode}`,
                  status: 502,
                  errorType: "upstream_error",
                  code: "process_exit_error",
                  retryable: false,
                });
              }
            } else {
              const classified = stderr ? classifyAntigravityCliError(stderr, state.partialUsage) : undefined;
              if (classified && (classified.status !== 502 || classified.retryable)) {
                emitOnce(classified);
              } else {
                emitOnce({
                  type: "error",
                  message: stderr
                    ? `${profile.label} CLI ended without a terminal result frame: ${stderr}`
                    : `${profile.label} CLI ended without a terminal result frame`,
                  status: 502,
                  errorType: "upstream_error",
                  code: "protocol_error",
                  retryable: false,
                });
              }
            }
          }

          if (deferredTransientError) {
            return { retryOnFreshSession: true, transientPreludeError: deferredTransientError };
          }
          return { retryOnFreshSession: false };
        };

        let preludeRetriesUsed = 0;

        if (warmMatch) {
          const match = warmMatch;
          warmMatch = undefined;
          const res = await executeOnSession(
            match.session,
            true,
            () => {
              if (match.dispatchKind === "tool_results") {
                match.session.writeToolResultsPayload(match.payload);
              } else {
                match.session.writeStdinLine(match.payload);
              }
            },
            match.nextTranscriptBlocks,
            preludeRetriesUsed < maxPreludeRetries,
          );
          if (!res.retryOnFreshSession) return;
          if (res.transientPreludeError) {
            preludeRetriesUsed += 1;
            const safeReason = capUtf8Bytes(
              redactAntigravityLogText(activeState?.rawUpstreamError ?? res.transientPreludeError.message),
              MAX_LOG_ERROR_BYTES,
            );
            if (activeState) activeState.rawUpstreamError = undefined;
            console.warn(
              `[antigravity-cli] transient prelude error requestId=${requestId} attempt=${preludeRetriesUsed}/${maxPreludeRetries + 1} retrying on fresh session: ${JSON.stringify(safeReason)}`,
            );
            const ok = await waitAbortable(preludeRetryDelayMs * preludeRetriesUsed);
            if (!ok) {
              observedEmit({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
              return;
            }
          }
        }

        while (true) {
          let session: WarmAntigravitySession;
          try {
            session = await spawnFreshSession(freshWorkspace);
            freshWorkspace = undefined;
          } catch (err) {
            if (freshWorkspace) {
              await removeAntigravityPathBestEffort(freshWorkspace.turnDir);
              if (freshWorkspace.ownedHomeDir) {
                await removeAntigravityPathBestEffort(freshWorkspace.ownedHomeDir);
              }
              freshWorkspace = undefined;
            }
            observedEmit({
              type: "error",
              message: redactSecrets(err instanceof Error ? err.message : String(err), undefined),
              status: 500,
              errorType: "upstream_error",
              code: "cli_spawn_failed",
              retryable: false,
            });
            return;
          }

          const res = await executeOnSession(
            session,
            false,
            () => {
              for (const line of getColdConversationLines()) {
                session.writeStdinLine(line);
              }
            },
            incomingBlocks,
            preludeRetriesUsed < maxPreludeRetries,
          );
          if (!res.retryOnFreshSession || !res.transientPreludeError) return;
          preludeRetriesUsed += 1;
          const safeReason = capUtf8Bytes(
            redactAntigravityLogText(activeState?.rawUpstreamError ?? res.transientPreludeError.message),
            MAX_LOG_ERROR_BYTES,
          );
          if (activeState) activeState.rawUpstreamError = undefined;
          console.warn(
            `[antigravity-cli] transient prelude error requestId=${requestId} attempt=${preludeRetriesUsed}/${maxPreludeRetries + 1} retrying on fresh session: ${JSON.stringify(safeReason)}`,
          );
          const ok = await waitAbortable(preludeRetryDelayMs * preludeRetriesUsed);
          if (!ok) {
            observedEmit({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
            return;
          }
        }
      } finally {
        if (freshWorkspace) {
          await removeAntigravityPathBestEffort(freshWorkspace.turnDir);
          if (freshWorkspace.ownedHomeDir) {
            await removeAntigravityPathBestEffort(freshWorkspace.ownedHomeDir);
          }
        }
        try { permit?.release(); }
        finally { producer?.close(); }
      }
    },
  };
}
