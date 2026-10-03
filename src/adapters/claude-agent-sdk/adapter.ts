/**
 * The Claude Agent SDK row: a Claude subscription spent through Anthropic's own harness.
 *
 * What this adapter is NOT is the construction that shipped in 2.65.0 — a one-shot `claude -p` turn
 * with the caller's prompt swapped in for the harness preset, no session and the tools stripped —
 * which was against Anthropic's terms: a subscription licensed for Anthropic's own harnesses, spent
 * as an API for a third-party agent loop, and the usage accounts get suspended over. This adapter is
 * the correction and takes the route Meridian takes, with the harness doing the work: the turn runs
 * through the Claude Agent SDK (`./sdk-turn.ts` documents the run), the caller's instructions are
 * APPENDED to the harness preset instead of replacing it, and the client's tool catalog reaches the
 * model through an in-process MCP server that captures calls and executes nothing. Still a grey area
 * — the client is not Claude Code — and `anthropic-apikey` remains the route here without an
 * interpretation question.
 */
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { CLAUDE_CLI_PROFILES } from "./profiles";
import { buildClaudeAgentSdkToolBridge } from "./sdk-bridge";
import { runClaudeAgentSdkTurn, type ClaudeAgentSdkDeps } from "./sdk-turn";

export { CLAUDE_CLI_QUIET_ENV, buildChildEnv } from "./env";
export type { ClaudeAgentSdkDeps } from "./sdk-turn";
/** Historical name for the same seam: the row changed transport, not its injectables. */
export type ClaudeCliAdapterDeps = ClaudeAgentSdkDeps;

/**
 * Refuse image input the way the Qoder presets do.
 *
 * The harness parses an image block in its input without complaint, but nothing verifies that a
 * headless turn hands those bytes to the model, and an image the harness drops produces a confident
 * answer to the wrong question. The row therefore publishes text-only models — `noVisionModels` on
 * the registry entry — and refuses a direct image here; an operator with the vision sidecar on the
 * request path still gets images captioned into text before they reach this adapter.
 */
function hasImageInput(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === "image"),
  );
}

/**
 * Turn the harness's unauthenticated turn into the one action a subscription user can take.
 *
 * An unauthenticated harness does not fail the process: it emits an ordinary terminal `result` frame
 * with `is_error: true` and the text "Not logged in · Please run /login", which the shared mapper
 * reports as a generic 401. Nothing in that reaches for the harness's own sign-in, so the operator is
 * left guessing whether the key, the provider row or the account is wrong.
 *
 * The error code keeps its historical `claude_cli_` prefix: logs and client messages already carry
 * that identifier, and renaming it would be churn without a reader.
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
 * Create the Claude Agent SDK adapter: one harness-run turn per request.
 *
 * As with CodeBuddy and Qoder, `runTurn` owns the turn and the HTTP path is disabled — the harness
 * performs the transport, and OpenCodex contributes the request projection, the tool catalog, the
 * stream mapping and the turn's lifecycle.
 */
export function createClaudeAgentSdkAdapter(
  provider: OcxProviderConfig,
  deps: ClaudeAgentSdkDeps = {},
): ProviderAdapter {
  return {
    name: "claude-agent-sdk",

    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Claude Agent SDK adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      if (hasImageInput(parsed)) {
        emit({
          type: "error",
          message: "Claude Agent SDK image input is not enabled because this route has no verified multimodal contract.",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
        });
        return;
      }
      // The catalog is validated before the harness starts: an unbuildable one is the client's 400,
      // not a turn that dies somewhere inside the agent loop.
      let toolBridge;
      try {
        toolBridge = await buildClaudeAgentSdkToolBridge(parsed);
      } catch (err) {
        emit({
          type: "error",
          message: `Invalid Claude tool catalog: ${err instanceof Error ? err.message : String(err)}`,
          status: 400,
          errorType: "invalid_request_error",
          code: "tool_catalog_invalid",
          retryable: false,
        });
        return;
      }
      await runClaudeAgentSdkTurn({
        profiles: CLAUDE_CLI_PROFILES,
        provider,
        parsed,
        incoming,
        emit: withClaudeLoginHint(emit),
        ...(toolBridge ? { toolBridge } : {}),
        deps,
      });
    },
  };
}
