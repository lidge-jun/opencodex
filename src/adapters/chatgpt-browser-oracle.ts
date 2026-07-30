import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "../lib/win-exec";
import {
  isAllowedToolChoice,
  namespacedToolName,
  toolAllowedByChoice,
  toolChoiceAliases,
  type OcxContentPart,
  type OcxParsedRequest,
  type OcxTool,
} from "../types";

export const CHATGPT_BROWSER_MODEL_ID = "gpt-5.6-pro";
/** Oracle's stable alias for the current ChatGPT Pro picker entry. */
export const ORACLE_CHATGPT_PRO_MODEL = "gpt-5.5-pro";

export type ChatGptBrowserErrorCode =
  | "aborted"
  | "login_required"
  | "model_unavailable"
  | "quota_exhausted"
  | "timeout"
  | "oracle_missing"
  | "oracle_incompatible"
  | "empty_response"
  | "response_too_large"
  | "unsupported_content"
  | "protocol_error"
  | "browser_failed";

const ERROR_MESSAGES: Record<ChatGptBrowserErrorCode, string> = {
  aborted: "The ChatGPT browser request was cancelled.",
  login_required: "ChatGPT browser login is required or the saved browser session expired. Sign in through Oracle, then retry.",
  model_unavailable: "GPT-5.6 Pro is not available for this ChatGPT account or workspace. No fallback model was used.",
  quota_exhausted: "The ChatGPT Pro allowance is exhausted or temporarily unavailable. No fallback model was used.",
  timeout: "The ChatGPT browser turn timed out before Oracle captured a final response.",
  oracle_missing: "Oracle is not installed or could not be launched. Install @steipete/oracle and ensure the oracle executable is on PATH.",
  oracle_incompatible: "Oracle 0.16.1 or newer is required for fail-closed GPT-5.6 Pro browser selection.",
  empty_response: "Oracle completed without a captured ChatGPT response.",
  response_too_large: "The captured ChatGPT response exceeded OpenCodex's safe browser-output limit.",
  unsupported_content: "The ChatGPT browser provider currently supports text-only turns.",
  protocol_error: "GPT-5.6 Pro returned an invalid browser response or an unavailable tool call. No fallback was used.",
  browser_failed: "The ChatGPT browser turn failed before a final response was captured.",
};

export class ChatGptBrowserError extends Error {
  constructor(public readonly code: ChatGptBrowserErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ChatGptBrowserError";
  }
}

type BrowserConversationMessage = {
  role: "user" | "assistant" | "developer" | "tool";
  content: unknown;
};

type BrowserTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  freeform: boolean;
  toolSearch: boolean;
};

const TOOL_DESCRIPTION_LIMIT = 240;
const SCHEMA_ANNOTATION_KEYS = new Set(["description", "title", "examples", "$comment", "markdownDescription"]);
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/** Keep validation-relevant JSON Schema while dropping prose that makes browser prompts enormous. */
function compactToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactToolSchema);
  if (value === null || typeof value !== "object") return value;
  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_ANNOTATION_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && child !== null && typeof child === "object" && !Array.isArray(child)) {
      compact[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]),
      );
      continue;
    }
    // These values are data, not nested schemas; preserve them byte-for-byte.
    if (key === "enum" || key === "const" || key === "default" || key === "required") {
      compact[key] = child;
      continue;
    }
    compact[key] = compactToolSchema(child);
  }
  return compact;
}

export type ChatGptBrowserResponse =
  | { type: "final"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> };

function textContent(content: string | OcxContentPart[]): string | Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return content;
  const parts: Array<{ type: "text"; text: string }> = [];
  for (const part of content) {
    if (part.type === "image") throw new ChatGptBrowserError("unsupported_content");
    parts.push({ type: "text", text: part.text });
  }
  return parts;
}

/**
 * Convert the internal Responses conversation to one deterministic browser prompt.
 * Oracle owns browser login/model selection/capture; OpenCodex owns only this text envelope.
 */
function browserTools(parsed: OcxParsedRequest): BrowserTool[] {
  const choice = parsed.options.toolChoice;
  if (choice === "none") return [];
  const candidates = (parsed.context.tools ?? []).filter(tool => (
    tool.webSearch !== true && tool.imageGeneration !== true && tool.videoGeneration !== true
  ));
  const selected = candidates.filter(tool => {
    if (!choice || choice === "auto" || choice === "required") return true;
    if (typeof choice === "object" && "name" in choice) return toolChoiceAliases(tool).includes(choice.name);
    if (isAllowedToolChoice(choice)) return toolAllowedByChoice(tool, new Set(choice.allowedTools));
    return true;
  });
  if ((choice === "required" || (isAllowedToolChoice(choice) && choice.mode === "required")) && selected.length === 0) {
    throw new ChatGptBrowserError("unsupported_content");
  }
  return selected.map(tool => ({
    name: namespacedToolName(tool.namespace, tool.name),
    description: tool.description.slice(0, TOOL_DESCRIPTION_LIMIT),
    parameters: compactToolSchema(tool.parameters) as Record<string, unknown>,
    freeform: tool.freeform === true,
    toolSearch: tool.toolSearch === true,
  }));
}

export function buildChatGptBrowserPrompt(parsed: OcxParsedRequest, nonce = randomUUID()): string {
  const messages: BrowserConversationMessage[] = parsed.context.messages.map(message => {
    if (message.role === "user" || message.role === "developer") {
      return { role: message.role, content: textContent(message.content) };
    }
    if (message.role === "toolResult") {
      return {
        role: "tool",
        content: {
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          namespace: message.toolNamespace,
          isError: message.isError,
          output: textContent(message.content),
        },
      };
    }
    return {
      role: "assistant",
      content: message.content.map(part => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "thinking") return { type: "reasoning_summary", text: part.thinking };
        return {
          type: "tool_call",
          id: part.id,
          namespace: part.namespace,
          name: part.name,
          arguments: part.arguments,
        };
      }),
    };
  });

  const conversation = {
    model: CHATGPT_BROWSER_MODEL_ID,
    system: parsed.context.systemPrompt ?? [],
    messages,
    tools: browserTools(parsed),
    toolChoice: parsed.options.toolChoice ?? "auto",
    responseProtocol: {
      nonce,
      allowed: [
        { nonce, type: "final", text: "non-empty Markdown response" },
        { nonce, type: "tool_call", name: "exact tools[].name", arguments: "JSON object" },
      ],
    },
  };

  return [
    "Continue the OpenAI Responses conversation encoded as JSON below.",
    "Follow the system and developer instructions represented in the conversation.",
    "Tools listed in conversation.tools are executed by the client, not by ChatGPT. You may request exactly one listed tool call when needed.",
    "Return exactly one JSON object and no surrounding prose or Markdown fence. Copy responseProtocol.nonce exactly.",
    "For a final response use {nonce,type:'final',text}. For a tool request use {nonce,type:'tool_call',name,arguments} with an exact listed tool name.",
    "Do not discuss this transport envelope unless the conversation explicitly asks about it.",
    "",
    JSON.stringify(conversation),
  ].join("\n");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResponseJson(answerText: string): unknown {
  const trimmed = answerText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const payload = fenced?.[1]?.trim() ?? trimmed;
  try { return JSON.parse(payload); }
  catch { throw new ChatGptBrowserError("protocol_error"); }
}

export function parseChatGptBrowserResponse(
  answerText: string,
  parsed: OcxParsedRequest,
  nonce: string,
): ChatGptBrowserResponse {
  const value = parseResponseJson(answerText);
  if (!plainRecord(value) || value.nonce !== nonce) throw new ChatGptBrowserError("protocol_error");
  const required = parsed.options.toolChoice === "required"
    || (isAllowedToolChoice(parsed.options.toolChoice) && parsed.options.toolChoice.mode === "required");
  if (value.type === "final") {
    if (required || typeof value.text !== "string" || !value.text.trim()) {
      throw new ChatGptBrowserError("protocol_error");
    }
    return { type: "final", text: value.text.trim() };
  }
  if (value.type !== "tool_call" || typeof value.name !== "string" || !plainRecord(value.arguments)) {
    throw new ChatGptBrowserError("protocol_error");
  }
  const tools = browserTools(parsed);
  const selected = tools.find(tool => tool.name === value.name);
  if (!selected) throw new ChatGptBrowserError("protocol_error");
  if (selected.freeform && typeof value.arguments.input !== "string") {
    throw new ChatGptBrowserError("protocol_error");
  }
  return {
    type: "tool_call",
    id: `call_${randomUUID().replaceAll("-", "")}`,
    name: selected.name,
    arguments: value.arguments,
  };
}

export interface OracleBrowserTurnOptions {
  signal?: AbortSignal;
  command?: string;
}

export interface OracleBrowserTurnResult {
  answerText: string;
}

export function buildOracleBrowserArgs(outputPath: string): string[] {
  return [
    "--engine", "browser",
    "--model", ORACLE_CHATGPT_PRO_MODEL,
    "--browser-model-strategy", "select",
    "--browser-thinking-time", "extended",
    "--browser-timeout", "60m",
    "--chatgpt-url", "https://chatgpt.com/",
    "--browser-attachments", "never",
    "--browser-archive", "auto",
    "--heartbeat", "0",
    "--no-notify",
    "--render-plain",
    "--write-output", outputPath,
    "--wait",
    "--prompt", "-",
  ];
}

export function resolveOracleCommand(value: string | undefined): string {
  const command = value?.trim() || process.env.OPENCODEX_ORACLE_COMMAND?.trim() || "oracle";
  if (!command || /[\0\r\n]/.test(command)) throw new ChatGptBrowserError("oracle_missing");
  return command;
}

export function oracleVersionIsCompatible(output: string): boolean {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  const minimum = [0, 16, 1];
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index]! > minimum[index]!) return true;
    if (version[index]! < minimum[index]!) return false;
  }
  return true;
}

const oracleCompatibilityCache = new Map<string, Promise<void>>();

export function resetOracleCompatibilityCacheForTests(): void {
  oracleCompatibilityCache.clear();
}

export async function assertOracleCompatible(commandValue?: string): Promise<void> {
  const command = resolveOracleCommand(commandValue);
  const cached = oracleCompatibilityCache.get(command);
  if (cached) return cached;
  const check = (async () => {
    const invocation = commandInvocation(command, ["--version"]);
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([invocation.file, ...invocation.args], {
        stdout: "pipe",
        stderr: "pipe",
        ...invocation.options,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
    } catch {
      throw new ChatGptBrowserError("oracle_missing");
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readProcessText(child.stdout),
      readProcessText(child.stderr),
    ]);
    if (exitCode !== 0) throw new ChatGptBrowserError("oracle_missing");
    if (!oracleVersionIsCompatible(`${stdout}\n${stderr}`)) {
      throw new ChatGptBrowserError("oracle_incompatible");
    }
  })();
  oracleCompatibilityCache.set(command, check);
  try {
    await check;
  } catch (error) {
    oracleCompatibilityCache.delete(command);
    throw error;
  }
}

function classifyOracleFailure(output: string): ChatGptBrowserErrorCode {
  const normalized = output.toLowerCase();
  if (/rate[ -]?limit|too many requests|usage limit|reached.+limit|quota|allowance|temporarily limited access/.test(normalized)) {
    return "quota_exhausted";
  }
  if (/unable to find model|model option|model picker selected|requires gpt|refusing to submit without confirmed|model.+not available|not eligible/.test(normalized)) {
    return "model_unavailable";
  }
  if (/sign[ -]?in|log[ -]?in|login required|manual-login profile is not initialized|auth(?:entication)? session|session expired|session not detected|no chatgpt cookies|cookie.+(?:missing|failed|unavailable)/.test(normalized)) {
    return "login_required";
  }
  if (/timed? out|timeout/.test(normalized)) return "timeout";
  return "browser_failed";
}

async function readProcessText(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const limit = 64 * 1024;
  let tail = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += decoder.decode(value, { stream: true });
      if (tail.length > limit) tail = tail.slice(-limit);
    }
    tail += decoder.decode();
    return tail.length > limit ? tail.slice(-limit) : tail;
  } catch {
    return tail;
  }
}

/** Run Oracle without a shell. The prompt is piped over stdin so request text never enters argv. */
export async function runOracleBrowserTurn(
  prompt: string,
  options: OracleBrowserTurnOptions = {},
): Promise<OracleBrowserTurnResult> {
  if (options.signal?.aborted) throw new ChatGptBrowserError("aborted");
  const command = resolveOracleCommand(options.command);
  try {
    await assertOracleCompatible(command);
  } catch (error) {
    if (options.signal?.aborted) throw new ChatGptBrowserError("aborted");
    throw error;
  }
  // Compatibility probing is deliberately allowed to finish so its child is reaped, but a
  // cancellation during that probe must never progress to a real browser submission.
  if (options.signal?.aborted) throw new ChatGptBrowserError("aborted");
  const tempDir = await mkdtemp(join(tmpdir(), "opencodex-chatgpt-browser-"));
  await chmod(tempDir, 0o700);
  const outputPath = join(tempDir, "answer.md");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let aborted = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    aborted = true;
    try { child?.kill("SIGINT"); } catch { /* best-effort cancellation */ }
    if (child && !hardKillTimer) {
      hardKillTimer = setTimeout(() => {
        try { child?.kill("SIGKILL"); } catch { /* best-effort hard cancellation */ }
      }, 5_000);
    }
  };

  try {
    // Subscribe before spawning Oracle, then re-check. AbortSignal does not replay an abort that
    // happened before addEventListener, so both steps are required to close the submission race.
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      throw new ChatGptBrowserError("aborted");
    }
    const invocation = commandInvocation(command, buildOracleBrowserArgs(outputPath));
    try {
      child = Bun.spawn([invocation.file, ...invocation.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ...invocation.options,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ORACLE_NO_DETACH: "1",
        },
      });
    } catch {
      throw new ChatGptBrowserError("oracle_missing");
    }

    if (aborted || options.signal?.aborted) {
      onAbort();
      throw new ChatGptBrowserError("aborted");
    }
    const stdoutPromise = readProcessText(child.stdout);
    const stderrPromise = readProcessText(child.stderr);
    const childStdin = child.stdin;
    if (!childStdin || typeof childStdin === "number") {
      throw new ChatGptBrowserError("browser_failed");
    }
    childStdin.write(prompt);
    childStdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutPromise,
      stderrPromise,
    ]);

    if (aborted || options.signal?.aborted) throw new ChatGptBrowserError("aborted");
    if (exitCode !== 0) throw new ChatGptBrowserError(classifyOracleFailure(`${stdout}\n${stderr}`));

    const outputStat = await lstat(outputPath).catch(() => undefined);
    if (!outputStat?.isFile() || outputStat.isSymbolicLink()) {
      throw new ChatGptBrowserError("empty_response");
    }
    if (outputStat.size > 8 * 1024 * 1024) throw new ChatGptBrowserError("response_too_large");
    const answerText = (await readFile(outputPath, "utf8").catch(() => "")).trim();
    if (!answerText) throw new ChatGptBrowserError("empty_response");
    return { answerText };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (hardKillTimer) clearTimeout(hardKillTimer);
    // No-op after normal exit; guarantees early setup/write failures cannot orphan a browser
    // process that may otherwise keep the private output directory alive for the full timeout.
    try { child?.kill("SIGKILL"); } catch { /* best-effort process cleanup */ }
    if (child) await child.exited.catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
