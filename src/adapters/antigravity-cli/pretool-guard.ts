import { readFileSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { projectedHistoryCharLimit } from "../coding-agent/protocol";
import { ANTIGRAVITY_CLI_CONTEXT_WINDOW } from "./profiles";

/**
 * Hard ceiling on PreToolUse hook stdin payload size (bytes).
 * Computed as `Math.max(32 MiB, projectedHistoryCharLimit(ANTIGRAVITY_CLI_CONTEXT_WINDOW) * 4)`
 * (worst-case 4 UTF-8 bytes per projected history char, with a 32 MiB floor) so full-context
 * turns carrying serialized conversation/transcript fields still reach policy evaluation.
 */
export const MAX_HOOK_STDIN_BYTES = Math.max(
  32 * 1024 * 1024,
  projectedHistoryCharLimit(ANTIGRAVITY_CLI_CONTEXT_WINDOW) * 4,
);
const FAIL_CLOSED_GUARD_JSON = '{"decision":"deny","reason":"PreToolUse guard internal error."}\n';

const ALLOWED_IMAGE_READ_ARG_KEYS: ReadonlySet<string> = new Set([
  "Path",
  "AbsolutePath",
  "toolSummary",
  "toolAction",
  "waitForPreviousTools",
  "WaitForPreviousTools",
]);

interface PreToolDecision {
  decision: "allow" | "deny";
  reason?: string;
}

export interface AntigravityPreToolPolicy {
  tools: ReadonlySet<string>;
  imagePaths?: ReadonlySet<string>;
  turnDir?: string;
  platform?: NodeJS.Platform;
}

export interface AntigravityAllowedToolsFileShape {
  tools?: string[];
  imagePaths?: string[];
  turnDir?: string;
}

export function normalizeAntigravityComparablePath(
  rawPath: string,
  turnDir?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  if (platform === "win32") {
    const candidate = trimmed.replace(/\//g, "\\");
    const resolved = win32.isAbsolute(candidate)
      ? win32.normalize(candidate)
      : turnDir
        ? win32.resolve(turnDir.replace(/\//g, "\\"), candidate)
        : "";
    return resolved ? resolved.replace(/\\+$/, "").toLowerCase() : "";
  }
  const resolved = posix.isAbsolute(trimmed)
    ? posix.normalize(trimmed)
    : turnDir
      ? posix.resolve(turnDir, trimmed)
      : "";
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

function loadAllowedPolicy(
  allowedToolsPath: string,
  platform: NodeJS.Platform = process.platform,
): AntigravityPreToolPolicy {
  if (!allowedToolsPath) return { tools: new Set(), platform };
  try {
    const raw = JSON.parse(readFileSync(allowedToolsPath, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      return {
        tools: new Set(raw.filter((item): item is string => typeof item === "string" && item.length > 0)),
        platform,
      };
    }
    if (!raw || typeof raw !== "object") return { tools: new Set(), platform };
    const obj = raw as AntigravityAllowedToolsFileShape;
    const turnDir = typeof obj.turnDir === "string" && obj.turnDir.length > 0 ? obj.turnDir : undefined;
    const tools = new Set(
      Array.isArray(obj.tools)
        ? obj.tools.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [],
    );
    const imagePaths = new Set<string>();
    if (Array.isArray(obj.imagePaths)) {
      for (const entry of obj.imagePaths) {
        if (typeof entry !== "string" || !entry) continue;
        const normalized = normalizeAntigravityComparablePath(entry, turnDir, platform);
        if (normalized) imagePaths.add(normalized);
        try {
          const real = normalizeAntigravityComparablePath(realpathSync(entry), turnDir, platform);
          if (real) imagePaths.add(real);
        } catch {
          // Staged image may already be cleaned up or mocked in tests.
        }
      }
    }
    return { tools, imagePaths, turnDir, platform };
  } catch {
    return { tools: new Set(), platform };
  }
}

export function isAllowedAntigravityStagedImageReadArgs(
  rawArgs: unknown,
  policy: Omit<AntigravityPreToolPolicy, "tools">,
): boolean {
  const imagePaths = policy.imagePaths;
  if (!imagePaths || imagePaths.size === 0) return false;
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return false;
  const args = rawArgs as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!ALLOWED_IMAGE_READ_ARG_KEYS.has(key)) return false;
  }
  const candidates: string[] = [];
  if (args.Path !== undefined) {
    if (typeof args.Path !== "string") return false;
    candidates.push(args.Path);
  }
  if (args.AbsolutePath !== undefined) {
    if (typeof args.AbsolutePath !== "string") return false;
    candidates.push(args.AbsolutePath);
  }
  if (candidates.length === 0) return false;
  const platform = policy.platform ?? process.platform;
  for (const candidate of candidates) {
    const normalized = normalizeAntigravityComparablePath(candidate, policy.turnDir, platform);
    if (!normalized) return false;
    if (imagePaths.has(normalized)) continue;
    let realMatched = false;
    try {
      const real = normalizeAntigravityComparablePath(realpathSync(candidate), policy.turnDir, platform);
      realMatched = Boolean(real && imagePaths.has(real));
    } catch {
      realMatched = false;
    }
    if (!realMatched) return false;
  }
  return true;
}

export function evaluateAntigravityPreToolInput(
  stdinText: string,
  allowedOrPolicy: ReadonlySet<string> | AntigravityPreToolPolicy,
): PreToolDecision {
  const policy: AntigravityPreToolPolicy = "tools" in allowedOrPolicy
    ? allowedOrPolicy
    : { tools: allowedOrPolicy };
  const hasImages = (policy.imagePaths?.size ?? 0) > 0;

  if (policy.tools.size === 0 && !hasImages) {
    return {
      decision: "deny",
      reason: "Tools are disabled for this turn.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    return {
      decision: "deny",
      reason: "Malformed PreToolUse payload.",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      decision: "deny",
      reason: "Invalid PreToolUse payload.",
    };
  }
  const record = parsed as Record<string, unknown>;
  const toolCall = record.toolCall && typeof record.toolCall === "object" && !Array.isArray(record.toolCall)
    ? (record.toolCall as Record<string, unknown>)
    : undefined;
  const toolName = typeof toolCall?.name === "string"
    ? toolCall.name
    : typeof record.tool_name === "string"
      ? record.tool_name
      : "";

  if (toolName && policy.tools.has(toolName)) {
    return { decision: "allow" };
  }
  if ((toolName === "read_file" || toolName === "view_file") && hasImages) {
    const rawArgs = toolCall?.args ?? toolCall?.parameters ?? record.tool_input;
    if (isAllowedAntigravityStagedImageReadArgs(rawArgs, policy)) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason:
        "view_file is permitted strictly on exact staged .ocx-images/* paths without StartLine, EndLine, or ContentOffset.",
    };
  }
  return {
    decision: "deny",
    reason:
      "Only the declared turn tool catalog is permitted; built-in tools (including call_mcp_tool) and external MCP tools are blocked. Call the allowed mcp_ocx_turn_bridge_* tool directly.",
  };
}

async function readBoundedStdin(stream: AsyncIterable<Uint8Array | string>): Promise<{ text: string; overflow: boolean }> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    bytes += buf.byteLength;
    if (bytes > MAX_HOOK_STDIN_BYTES) {
      return { text: "", overflow: true };
    }
    parts.push(decoder.decode(buf, { stream: true }));
  }
  parts.push(decoder.decode());
  return { text: parts.join(""), overflow: false };
}

export async function runAntigravityPreToolGuard(
  allowedToolsPath: string,
  stdin: AsyncIterable<Uint8Array | string> = process.stdin,
  writeStdout: (text: string) => void = text => { process.stdout.write(text); },
): Promise<number> {
  try {
    const policy = loadAllowedPolicy(allowedToolsPath);
    const { text, overflow } = await readBoundedStdin(stdin);
    const verdict: PreToolDecision = overflow
      ? { decision: "deny", reason: "PreToolUse payload exceeded the byte ceiling." }
      : evaluateAntigravityPreToolInput(text, policy);
    writeStdout(`${JSON.stringify(verdict)}\n`);
    return 0;
  } catch {
    try {
      writeStdout(FAIL_CLOSED_GUARD_JSON);
    } catch {
      // Nothing else can be written if stdout itself is broken.
    }
    return 0;
  }
}

const isDirectEntry = (import.meta as { main?: boolean }).main === true;
if (isDirectEntry) {
  runAntigravityPreToolGuard(process.argv[2] ?? "").then(
    code => process.exit(code),
    () => {
      try {
        process.stdout.write(FAIL_CLOSED_GUARD_JSON);
      } catch {
        // Ignore broken pipe on exit.
      }
      process.exit(0);
    },
  );
}
