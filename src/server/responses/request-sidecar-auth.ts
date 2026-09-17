import type { ResponsesRequestContext } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import {
  shouldResolveOpenAiVisionSidecar,
  resolveOpenAiVisionModel,
  planVisionSidecar,
  describeImagesInPlace,
  requiresVisionPreprocessing,
  stripImagesInPlace,
} from "../../vision";
import { shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { shouldResolveOpenAiPassthroughWebSearchBridge } from "../../web-search/passthrough-bridge";
import {
  listOpenAiForwardSidecarCandidates,
  captureExplicitOpenAiCallerAuth,
  resolveFirstUsableOpenAiSidecar,
} from "../../providers/openai-sidecar";
import {
  tryClaimNativeMainProfileForTurn as tryClaimStoredSidecarMainProfile,
} from "../../codex/native-main-admission";
import { codexAccountSelectionForTurn } from "../lifecycle";
import {
  CodexPoolAuthenticationError,
  CodexAuthContextError,
  CodexAccountCooldownError,
  CodexThreadAffinityExpiredError,
  CodexMainProfileDrainingError,
} from "../../codex/auth-context";

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function prepareResponsesSidecarAuth(
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "req">,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "route"
    | "selectedForwardHeaders"
    | "translatorBudget"
  >,
  transportState: Pick<ResponsesTransport, "adapter" | "isPassthrough">,
) {
  const { options, config, req } = requestContext;
  const { parsed, route, translatorBudget } = requestState;
  const { isPassthrough } = transportState;


  let openAiSidecar: ResolvedOpenAiForwardSidecar | undefined;
  const visionDescribeTerminal = options.visionDescribeTerminal === true;
  const routedCompaction = parsed._compactionRequest === true
    && (!isCanonicalOpenAiForwardProvider(route.provider) || parsed._portableCompaction === true);
  const needsOpenAiVision = !visionDescribeTerminal
    && shouldResolveOpenAiVisionSidecar(config, route.provider, route.modelId, parsed, route.providerName);
  const needsOpenAiSearch = !routedCompaction && !transportState.adapter.runTurn
    && (shouldResolveOpenAiWebSearchSidecar(config, parsed, isPassthrough)
      || shouldResolveOpenAiPassthroughWebSearchBridge(route.provider, parsed, isPassthrough));
  if (needsOpenAiVision || needsOpenAiSearch) {
    try {
      const candidates = listOpenAiForwardSidecarCandidates(config);
      let sidecarAuth = options.openAiSidecarAuth;
      if (!sidecarAuth && options.allowStoredOpenAiSidecarAuth === true
        && route.codexAccountId === undefined
        && candidates.some(candidate => candidate.accountMode === "direct")
        && tryClaimStoredSidecarMainProfile(options.turnAdmissionLease)) {
        // Request-local helper authority only: never promote this pair to caller, primary,
        // or retry credentials. Claim before reading so profile switches remain fenced.
        try {
          const { getMainAccountToken } = await import("../../codex/main-account");
          const token = getMainAccountToken();
          if (token) sidecarAuth = captureExplicitOpenAiCallerAuth(new Headers({
            authorization: `Bearer ${token.accessToken}`, "chatgpt-account-id": token.chatgptAccountId,
          }), config);
        } catch { /* stored enrichment is optional */ }
      }
      // Preserve explicit OpenAI helper auth across route changes without returning it to
      // primary-provider headers or alternate-main retry. The resolver revalidates scope.
      const sidecarHeaders = new Headers(req.headers);
      sidecarHeaders.delete("authorization");
      sidecarHeaders.delete("chatgpt-account-id");
      if (sidecarAuth) {
        sidecarHeaders.set("authorization", sidecarAuth.authorization);
        sidecarHeaders.set("chatgpt-account-id", sidecarAuth.chatgptAccountId);
      }
      openAiSidecar = await resolveFirstUsableOpenAiSidecar(
        candidates,
        sidecarHeaders,
        config,
        {
          admission: options.admission,
          codexAuthPolicy: options.codexAuthPolicy,
          // Account-qualified native routes are passthrough, so their in-turn helper is vision.
          // Scope its cooldown and outcome to the helper model, not the routed text model.
          ...(route.codexAccountId !== undefined
            ? { exactAccount: { accountId: route.codexAccountId, modelId: resolveOpenAiVisionModel(config) } }
            : {}),
          beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
        },
      );
    } catch (err) {
      // Sidecars are optional helpers for an otherwise independent routed turn.
      // An unavailable/cooling/expired Multi credential disables the helper; it
      // must not turn a valid routed-provider request into a Codex-auth failure.
      if (
        !(err instanceof CodexPoolAuthenticationError)
        && !(err instanceof CodexAuthContextError)
        && !(err instanceof CodexAccountCooldownError)
        && !(err instanceof CodexThreadAffinityExpiredError)
        && !(err instanceof CodexMainProfileDrainingError)
      ) throw err;
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Describe each
  // attached image through the selected sidecar backend and replace it with text BEFORE the main
  // call, so the text-only model can reason about it.
  // Terminal describe fence (roadmap 180): the sidecar's OWN loopback describe
  // call must never plan another describe. The flag arrives from the Chat
  // surface (whose bridge rebuilds headers) or as the raw header for native
  // Responses callers. Marked + text-only routed model → strip, depth cap 1.
  const visionPlan = visionDescribeTerminal
    ? undefined
    : planVisionSidecar(config, route.provider, route.modelId, parsed, openAiSidecar, {
      admission: options.admission, codexAuthPolicy: options.codexAuthPolicy, providerName: route.providerName,
    });
  const recordSidecarOutcome = openAiSidecar?.recordOutcome;
  if (visionPlan) {
    await describeImagesInPlace(
      parsed,
      visionPlan,
      openAiSidecar?.headers ?? requestState.selectedForwardHeaders,
      options.abortSignal,
      recordSidecarOutcome,
      translatorBudget,
    );
  } else if (requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName)) {
    // Image capability is not positively proven but no sidecar plan is dispatchable: fail closed.
    // Never forward raw image bytes to an unverified upstream.
    stripImagesInPlace(parsed, translatorBudget);
  }

  return {
    openAiSidecar,
    routedCompaction,
  };
}

export type ResponsesSidecarAuth = Exclude<Awaited<ReturnType<typeof prepareResponsesSidecarAuth>>, Response>;
