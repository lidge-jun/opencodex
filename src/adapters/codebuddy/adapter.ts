import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { mapReasoningEffort } from "../../reasoning-effort";
import { buildSystemPrompt } from "../coding-agent/protocol";
import { baseScopedEnv, runCodingAgentTurn, type CodingAgentDeps, type SpawnFn } from "../coding-agent/turn";
import { CODEBUDDY_PROFILES, type CodeBuddyProfile } from "./profiles";

export type { SpawnFn } from "../coding-agent/turn";
export type CodeBuddyAdapterDeps = CodingAgentDeps;

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
 * would require authorization is blocked. The turn is a single text/reasoning pass over stream-json;
 * Codex's tool catalog is not advertised in v1 (the control-protocol tool bridge is a fast-follow).
 */
export function buildArgs(profile: CodeBuddyProfile, parsed: OcxParsedRequest, provider: OcxProviderConfig): string[] {
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
  const system = buildSystemPrompt(parsed);
  if (system) args.push("--append-system-prompt", system);
  // profile is retained for symmetry with the region-isolated design and future per-region flags.
  void profile;
  return args;
}

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
      await runCodingAgentTurn({
        profiles: CODEBUDDY_PROFILES,
        provider,
        parsed,
        incoming,
        emit,
        buildArgs: (resolved, req, prov) => buildArgs(resolved as CodeBuddyProfile, req, prov),
        buildEnv: (resolved, apiKey) => buildChildEnv(resolved as CodeBuddyProfile, apiKey),
        deps,
      });
    },
  };
}
