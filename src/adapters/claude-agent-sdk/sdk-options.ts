/**
 * Option assembly for one Claude Agent SDK turn.
 *
 * Kept pure and separate from the runner so the two properties this row is judged by are readable in
 * one place: the harness keeps its own preset (the caller's instructions are APPENDED), and the
 * client keeps tool ownership (no built-in tools, no settings, one in-process MCP catalog).
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mapReasoningEffort } from "../../reasoning-effort";
import type { OcxParsedRequest, OcxProviderConfig } from "../../types";
import { buildSystemPrompt } from "../coding-agent/protocol";
import { TOOL_BRIDGE_SYSTEM_PROMPT } from "../coding-agent/tool-bridge-directive";

/** The SDK's `Options.effort` roster (sdk.d.ts `EffortLevel`); anything else is dropped, not sent. */
const SDK_EFFORT_VALUES = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/**
 * System prompt for a proxied turn: the harness preset, with the caller's contract appended.
 *
 * The preset stays on purpose. This row exists to let Anthropic's own harness run the turn, and a
 * harness without its own instructions is not that: the previous construction REPLACED the preset,
 * which is part of what made the shipped 2.65.0 turn a puppet rather than an agent. The caller's
 * system and developer prompts follow as an appended block, and the capture-only bridge directive
 * joins them when a tool catalog is advertised.
 */
export function buildAgentSdkSystemPrompt(
  parsed: OcxParsedRequest,
  hasToolCatalog: boolean,
): NonNullable<Options["systemPrompt"]> {
  const parts: string[] = [];
  const system = buildSystemPrompt(parsed);
  if (system) parts.push(system);
  if (hasToolCatalog) parts.push(TOOL_BRIDGE_SYSTEM_PROMPT);
  return {
    type: "preset",
    preset: "claude_code",
    ...(parts.length > 0 ? { append: parts.join("\n\n") } : {}),
  };
}

/** Map the caller's reasoning effort onto an effort level the SDK accepts, or drop it. */
export function buildAgentSdkEffort(
  provider: OcxProviderConfig,
  parsed: OcxParsedRequest,
): Options["effort"] | undefined {
  const effort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
  if (effort === undefined || !SDK_EFFORT_VALUES.has(effort)) return undefined;
  return effort as Options["effort"];
}

/** The capture-only catalog as the SDK needs it: the in-process server plus its rendered names. */
export interface AgentSdkToolCatalog {
  serverName: string;
  /** The in-process MCP server the SDK connects for this turn (see `./sdk-bridge.ts`). */
  instance: McpServer;
  /** Rendered `mcp__<server>__<tool>` names, i.e. the only tools this turn may call. */
  allowedNames: readonly string[];
}

export interface AgentSdkOptionInput {
  provider: OcxProviderConfig;
  parsed: OcxParsedRequest;
  /** Scoped child environment; the SDK REPLACES the whole environment with it. */
  env: Record<string, string>;
  abortController: AbortController;
  /** Bounded stderr sink; the SDK hands raw CLI stderr lines here. */
  onStderr: (chunk: string) => void;
  toolCatalog?: AgentSdkToolCatalog;
  /** Claude Code build to drive; the one the SDK ships is used when this is absent. */
  executablePath?: string;
}

/**
 * Build the Agent SDK options for one turn.
 *
 * The settings that matter, and why:
 * - `tools: []` disables every built-in tool, so the harness can neither read, write, exec nor
 *   browse the operator's tree.
 * - `settingSources: []` and `strictMcpConfig: true` keep CLAUDE.md, skills, hooks, plugins and the
 *   machine's own MCP servers out of a proxied turn: the request is what the client sent.
 * - `persistSession: false` leaves no transcript behind. The client replays its own conversation,
 *   so the harness needs no memory of it, and the operator's `~/.claude` projects directory is not
 *   where another client's conversation belongs.
 * - `includePartialMessages: true` is what produces `stream_event` deltas instead of one block at
 *   the end of the turn.
 * - The tool catalog is served from THIS process (`type: "sdk"`), so no extra executable, no argv
 *   and no temp file is involved in advertising it.
 */
export function buildAgentSdkTurnOptions(input: AgentSdkOptionInput): Options {
  const { provider, parsed, toolCatalog } = input;
  const effort = buildAgentSdkEffort(provider, parsed);
  return {
    model: parsed.modelId,
    systemPrompt: buildAgentSdkSystemPrompt(parsed, toolCatalog !== undefined),
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    includePartialMessages: true,
    env: input.env,
    abortController: input.abortController,
    stderr: input.onStderr,
    ...(effort !== undefined ? { effort } : {}),
    ...(input.executablePath !== undefined ? { pathToClaudeCodeExecutable: input.executablePath } : {}),
    ...(toolCatalog !== undefined
      ? {
          mcpServers: {
            [toolCatalog.serverName]: {
              type: "sdk" as const,
              name: toolCatalog.serverName,
              instance: toolCatalog.instance,
            },
          },
          allowedTools: [...toolCatalog.allowedNames],
        }
      : {}),
  };
}
