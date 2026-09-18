import type { ResponsesRequestContext } from "./core-options";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import { emptyCompletionRetryEnabled } from "./empty-completion-guard";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export function createResponsesCompletionPolicy(
  requestContext: Pick<ResponsesRequestContext, "config" | "options">,
  sidecarState: Pick<ResponsesSidecarAuth, "routedCompaction">,
) {
  const { config, options } = requestContext;
  const { routedCompaction } = sidecarState;


  // Empty-completion guard (codex-router PR #145 port): a 200 that completes with no output
  // text and no tool call is a failure the client cannot see — it silently records the turn as
  // done. The guard holds pre-content adapter events, suppresses the terminal of an empty
  // turn, retries the IDENTICAL request once, and surfaces a stated error when the retry is
  // empty or fails. This is a top-level config opt-in; OCX_EMPTY_COMPLETION_RETRY=0 is a
  // disable-only emergency override. Compaction turns and combo attempts keep their own
  // machinery (the combo preflight already handles empty streams). Native Chat-to-Chat
  // requests return from handleChatCompletions before entering Responses core, so they are
  // intentionally outside this guard and retain their existing one-send wire behavior.
  const emptyCompletionGuardEnabled =
    emptyCompletionRetryEnabled(config)
    && !options.comboAttempt
    && !routedCompaction;

  return {
    emptyCompletionGuardEnabled,
  };
}

export type ResponsesCompletionPolicy = Exclude<ReturnType<typeof createResponsesCompletionPolicy>, Response>;
