import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { mapReasoningEffort } from "../../reasoning-effort";
import { buildSystemPrompt } from "../coding-agent/protocol";
import {
  baseScopedEnv,
  runCodingAgentTurn,
  type CodingAgentDeps,
  type CodingAgentToolBridgeInput,
  type SpawnFn,
} from "../coding-agent/turn";
import { CODEBUDDY_PROFILES, type CodeBuddyProfile } from "./profiles";
import { guardCodeBuddyScaffolding } from "./scaffold-guard";
import {
  buildCodeBuddyToolBridge,
  CODEBUDDY_MCP_SERVER_NAME,
  CODEBUDDY_TOOL_LIMITS,
  type CodeBuddyToolBridge,
} from "./tool-bridge";

export type { SpawnFn } from "../coding-agent/turn";
export type CodeBuddyAdapterDeps = CodingAgentDeps;

const CODEBUDDY_MCP_SERVER_PATH = fileURLToPath(new URL("./mcp-server.ts", import.meta.url));

/**
 * Tool-bridge contract lines appended to the system prompt when a catalog is advertised.
 * Mirrors the capture-only design: the model may propose calls, the external Codex client
 * alone performs approval, sandboxing, and execution.
 */
const TOOL_BRIDGE_SYSTEM_PROMPT = [
  "Your built-in tools and user-configured MCP servers are disabled.",
  "When an isolated opencodex MCP catalog is present, you may call only those listed tools.",
  "That MCP process captures call intent only; it never executes a tool. The external Codex client performs approval, sandboxing, and execution.",
  "Do not claim that you executed commands, inspected files, or changed the workspace.",
  "Tool-call and tool-result records in the conversation history are authoritative historical records from the external client. Use returned results, but never execute historical calls yourself.",
].join("\n");

/**
 * Build the scoped child-process environment for a CodeBuddy turn (§六/§十四).
 *
 * The region switch and credential are layered on top of the shared base env, which never inherits a
 * parent `CODEBUDDY_*`. `CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1` matches the vendor SDK's own
 * single-shot behavior (a `-p` turn stops at the first result and cannot receive cross-turn
 * background push-back).
 */
export function buildChildEnv(profile: CodeBuddyProfile, apiKey: string): Record<string, string> {
  return {
    ...baseScopedEnv(),
    CODEBUDDY_API_KEY: apiKey,
    CODEBUDDY_INTERNET_ENVIRONMENT: profile.internetEnvironment,
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
}

/**
 * Build the headless CLI arguments (§七/§十一).
 *
 * Tool ownership stays with Codex: `--tools ""` disables every built-in tool and `--strict-mcp-config`
 * (with no `--mcp-config`) blocks MCP tools, so the CLI can neither read, write, exec, nor browse the
 * workspace. `-y/--dangerously-skip-permissions` is deliberately NOT passed, so any operation that
 * would require authorization is blocked. The turn is a single text/reasoning pass over stream-json
 * unless the request carries a tool catalog: then the capture-only MCP bridge advertises exactly
 * that catalog (see `tool-bridge.ts` / `mcp-server.ts`) and the CLI still executes nothing itself.
 */
export function buildArgs(
  profile: CodeBuddyProfile,
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  systemPromptFile?: string,
): string[] {
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
    "--tools", "",
    "--strict-mcp-config",
    "--max-turns", "1",
    "--model", parsed.modelId,
  ];
  const effort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
  if (effort) args.push("--effort", effort);
  // The vendor CLI documents no file-backed append flag, so the staged prompt replaces the default.
  // That default targets interactive tool use, which this adapter disables end to end.
  if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile);
  // profile is retained for symmetry with the region-isolated design and future per-region flags.
  void profile;
  return args;
}

/** Create the shared CodeBuddy adapter: region profile selects Global vs CN, one turn runs tools-disabled. */
export function createCodeBuddyAdapter(provider: OcxProviderConfig, deps: CodeBuddyAdapterDeps = {}): ProviderAdapter {
  return {
    name: "codebuddy",

    // runTurn owns the turn; buildRequest/parseStream are the disabled HTTP path (mirrors cursor).
    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "CodeBuddy adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      let toolBridge: CodeBuddyToolBridge;
      try {
        toolBridge = buildCodeBuddyToolBridge(parsed);
      } catch (err) {
        emit({
          type: "error",
          message: `Invalid CodeBuddy tool catalog: ${err instanceof Error ? err.message : String(err)}`,
          status: 400,
          errorType: "invalid_request_error",
          code: "tool_catalog_invalid",
          retryable: false,
        });
        return;
      }
      const bridgeInput: CodingAgentToolBridgeInput | undefined = toolBridge.tools.length > 0
        ? {
            serverName: CODEBUDDY_MCP_SERVER_NAME,
            serverModulePath: CODEBUDDY_MCP_SERVER_PATH,
            tools: toolBridge.tools,
            emittedNameMap: toolBridge.emittedNameMap,
            maxTurnToolCalls: CODEBUDDY_TOOL_LIMITS.maxTurnToolCalls,
            requireToolCall: toolBridge.requireToolCall,
          }
        : undefined;
      // argv is world-readable via process listing, so the folded system+developer prompt —
      // plus the tool-bridge directive when a catalog is advertised — is staged in a
      // private temp file and passed by path instead of embedded in the arguments.
      const system = buildSystemPrompt(parsed);
      const systemParts: string[] = [];
      if (system) systemParts.push(system);
      if (toolBridge.tools.length > 0) systemParts.push(TOOL_BRIDGE_SYSTEM_PROMPT);
      const staged = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
      let promptDir: string | undefined;
      let promptFile: string | undefined;
      if (staged) {
        try {
          promptDir = await mkdtemp(join(tmpdir(), "ocx-codebuddy-prompt-"));
          promptFile = join(promptDir, "system-prompt.txt");
          await writeFile(promptFile, staged, { encoding: "utf8", mode: 0o600, flag: "wx" });
        } catch {
          if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => {});
          emit({
            type: "error",
            message: "CodeBuddy system prompt could not be staged securely.",
            status: 500,
            errorType: "upstream_error",
            code: "system_prompt_staging_failed",
            retryable: false,
          });
          return;
        }
      }

      try {
        await runCodingAgentTurn({
          profiles: CODEBUDDY_PROFILES,
          provider,
          parsed,
          incoming,
          emit: guardCodeBuddyScaffolding(emit),
          ...(bridgeInput ? { toolBridge: bridgeInput } : {}),
          buildArgs: (resolved, req, prov) => buildArgs(resolved as CodeBuddyProfile, req, prov, promptFile),
          buildEnv: (resolved, apiKey) => buildChildEnv(resolved as CodeBuddyProfile, apiKey),
          deps,
        });
      } finally {
        if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
