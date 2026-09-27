import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { mapReasoningEffort } from "../../reasoning-effort";
import { buildSystemPrompt } from "../coding-agent/protocol";
import { baseScopedEnv, runCodingAgentTurn, type CodingAgentDeps } from "../coding-agent/turn";
import { CLAUDE_CLI_PROFILES, type ClaudeCliProfile } from "./profiles";

export type { SpawnFn } from "../coding-agent/turn";
export type ClaudeCliAdapterDeps = CodingAgentDeps;

/**
 * Quiet the CLI's own outbound traffic.
 *
 * The spawned turn is infrastructure, not somebody's editor: nobody reads its usage metrics, its
 * crash reports describe a process the operator never launched by hand, and an auto-updater
 * swapping the binary underneath a running proxy is skew rather than a feature. The shared scoped
 * env inherits none of these keys, so these values are the ones the turn runs with.
 */
export const CLAUDE_CLI_QUIET_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
};

/**
 * Build the scoped child-process environment for one Claude Code turn.
 *
 * No credential is layered here on purpose. Claude Code reads the operator's own sign-in (the
 * macOS Keychain entry, or `~/.claude/.credentials.json` elsewhere), which is exactly the property
 * this provider exists for: the token never enters OpenCodex, its config, or a child environment.
 *
 * The shared base env also drops every inherited `ANTHROPIC_*` variable, which is what keeps a
 * `claude` the operator already points at this proxy from looping back into it.
 *
 * `USER` is the one inherited name added back, and it is not a credential: the CLI resolves its own
 * sign-in by account name, so a scoped env without it makes a signed-in machine answer "not logged
 * in". Measured with `claude auth status` under `env -i`: `USER` alone reports `loggedIn: true`,
 * `LOGNAME` alone or neither reports `loggedIn: false`.
 */
export function buildChildEnv(_profile: ClaudeCliProfile, _apiKey: string): Record<string, string> {
  const env: Record<string, string> = {
    ...baseScopedEnv(),
    ...CLAUDE_CLI_QUIET_ENV,
  };
  const user = process.env.USER;
  if (user) env.USER = user;
  return env;
}

/**
 * Build the headless Claude Code arguments for one turn.
 *
 * Tool ownership stays with the client: `--tools ""` disables every built-in tool and
 * `--strict-mcp-config` (with no `--mcp-config`) keeps user, project and plugin MCP servers out, so
 * the harness can neither read, write, exec nor browse the operator's tree. `--setting-sources ""`
 * stops the CLI from loading CLAUDE.md, skills, hooks, plugins and output styles into a proxied
 * turn, which is what makes the request deterministic instead of dependent on the host's setup.
 *
 * The system prompt REPLACES the Claude Code preset rather than appending to it. The caller's system
 * and developer prompts are the contract this turn answers under; leaving the harness preset in
 * place would put a second, contradictory instruction set in front of them and would describe tools
 * this turn deliberately does not have.
 *
 * It travels as a `--system-prompt-file` path rather than inline, because argv is world-readable
 * through process listing — the same reason the CodeBuddy adapter stages its folded prompt. The
 * staging file is passed by `runTurn`, which always writes one: omitting the flag is not "no system
 * prompt", it is "Claude Code's preset", so a caller that sends neither a system nor a developer
 * prompt gets an empty file instead. Verified against 2.1.270 by reading the `prompt_snapshot`
 * attachment the CLI writes into a session transcript — a file holding MARKER snapshots `["MARKER"]`,
 * an empty file snapshots `[""]`, and an omitted flag snapshots the fourteen-block harness preset.
 *
 * `--no-session-persistence` keeps every turn stateless. The client replays its own conversation
 * and `buildConversationInput` projects it into the single stream-json user frame the CLI accepts.
 *
 * There is deliberately no `--max-turns` here: the Claude Code CLI exposes no such flag (the Agent
 * SDK sets it on the turn budget instead), and with no tool channel a single `-p` turn cannot loop.
 */
export function buildArgs(
  _profile: ClaudeCliProfile,
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
    "--setting-sources", "",
    "--model", parsed.modelId,
  ];
  const effort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
  if (effort) args.push("--effort", effort);
  if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile);
  return args;
}

/**
 * Refuse image input the way the Qoder presets do.
 *
 * The CLI parses an image frame in its stream-json input without complaint (verified against
 * 2.1.270), but nothing verifies that a headless turn hands those bytes to the model, and an image
 * the harness drops produces a confident answer to the wrong question. v1 therefore publishes
 * text-only models — `noVisionModels` on the registry row — and refuses a direct image here; an
 * operator with the vision sidecar on the request path still gets images captioned into text before
 * they reach this adapter.
 */
function hasImageInput(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === "image"),
  );
}

/**
 * Turn the CLI's unauthenticated turn into the one action a subscription user can take.
 *
 * An unauthenticated `claude` does not fail the process: it emits an ordinary terminal `result`
 * frame with `is_error: true` and the text "Not logged in · Please run /login", which the shared
 * mapper reports as a generic 401. Nothing in that reaches for the CLI's own sign-in, so the
 * operator is left guessing whether the key, the provider row or the account is wrong.
 */
export function withClaudeLoginHint(emit: (event: AdapterEvent) => void): (event: AdapterEvent) => void {
  return event => {
    if (event.type === "error" && event.status === 401 && /not logged in|please run \/login/i.test(event.message)) {
      emit({
        ...event,
        code: "claude_cli_not_logged_in",
        message:
          "Claude Code is not signed in, so this subscription provider has no account to spend. " +
          "Run `claude` once and sign in (or `claude setup-token`), then retry. " +
          `CLI reported: ${event.message}`,
      });
      return;
    }
    emit(event);
  };
}

/**
 * Create the Claude Code CLI adapter: one headless, tools-disabled, sessionless turn per request.
 *
 * As with CodeBuddy and Qoder, `runTurn` owns the turn and the HTTP path is disabled — the CLI
 * performs the transport, and OpenCodex contributes the request projection, the stream mapping and
 * the process lifecycle.
 */
export function createClaudeCliAdapter(provider: OcxProviderConfig, deps: ClaudeCliAdapterDeps = {}): ProviderAdapter {
  return {
    name: "claude-cli",

    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Claude Code CLI adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      if (hasImageInput(parsed)) {
        emit({
          type: "error",
          message: "Claude Code CLI image input is not enabled because the CLI provider route has no verified multimodal contract.",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
        });
        return;
      }
      // argv is world-readable via process listing, so the folded system+developer prompt is staged
      // in a private per-turn file and passed by path. The file is written even when the caller
      // sends no prompt at all: the flag has to be present either way, and an empty replacement is
      // what keeps the harness preset out of the turn.
      let promptDir: string | undefined;
      let promptFile: string | undefined;
      try {
        promptDir = await mkdtemp(join(tmpdir(), "ocx-claude-cli-prompt-"));
        promptFile = join(promptDir, "system-prompt.txt");
        await writeFile(promptFile, buildSystemPrompt(parsed) ?? "", { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch {
        if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => {});
        emit({
          type: "error",
          message: "Claude Code system prompt could not be staged securely.",
          status: 500,
          errorType: "upstream_error",
          code: "system_prompt_staging_failed",
          retryable: false,
        });
        return;
      }
      try {
        await runCodingAgentTurn({
          profiles: CLAUDE_CLI_PROFILES,
          provider,
          parsed,
          incoming,
          emit: withClaudeLoginHint(emit),
          buildArgs: (profile, req, prov) => buildArgs(profile as ClaudeCliProfile, req, prov, promptFile),
          buildEnv: (profile, apiKey) => buildChildEnv(profile as ClaudeCliProfile, apiKey),
          deps,
        });
      } finally {
        if (promptDir) await rm(promptDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
