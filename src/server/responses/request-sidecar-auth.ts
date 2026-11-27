import { CodexInstallationIdUnavailableError } from "../../codex/installation-id";
import type { ResponsesRequestContext } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { OcxConfig, OcxParsedRequest } from "../../types";
import type { ComboTargetRoute } from "../../combos/request-capability";
import { ComboVisionDescriptionUnavailableError, policyCandidateRefusalResponse } from "./policy-request-scope";
import { intersectAdmissionModelScopes, resolveAdmissionModelScope } from "../admission-model-scope";
import { captureAdmissionPolicy } from "../capture-admission-policy";
import type { ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider, supportsNativeResponsesCompactionTrigger } from "../../providers/openai-tiers";
import { omitEarlierCompactionImages } from "../../responses/compaction-images";
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

type SidecarRequestContext = Pick<ResponsesRequestContext, "options" | "config" | "req">;

/** The config vision planning reads: a combo request plans with its request-start sidecar settings. */
export function responsesVisionConfig({ config, options }: Pick<SidecarRequestContext, "config" | "options">): OcxConfig {
  const admitted = options.comboVisionSidecar;
  return admitted ? { ...config, visionSidecar: admitted.settings } : config;
}

async function resolveResponsesOpenAiSidecar(
  { options, config, req }: SidecarRequestContext,
  route: Pick<ComboTargetRoute, "codexAccountId">,
): Promise<ResolvedOpenAiForwardSidecar | undefined> {
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
    return await resolveFirstUsableOpenAiSidecar(
      candidates,
      sidecarHeaders,
      config,
      {
        admission: options.admission,
        signal: options.abortSignal,
        codexAuthPolicy: options.codexAuthPolicy,
        // Account-qualified native routes are passthrough, so their in-turn helper is vision.
        // Scope its cooldown and outcome to the helper model, not the routed text model.
        ...(route.codexAccountId !== undefined
          ? { exactAccount: { accountId: route.codexAccountId, modelId: resolveOpenAiVisionModel(responsesVisionConfig({ config, options })) } }
          : {}),
        beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
      },
    );
  } catch (err) {
    // Sidecars are optional helpers for an otherwise independent routed turn.
    // An unavailable/cooling/expired Multi credential disables the helper; it
    // must not turn a valid routed-provider request into a Codex-auth failure.
    if (
      !(err instanceof CodexInstallationIdUnavailableError)
      && !(err instanceof CodexPoolAuthenticationError)
      && !(err instanceof CodexAuthContextError)
      && !(err instanceof CodexAccountCooldownError)
      && !(err instanceof CodexThreadAffinityExpiredError)
      && !(err instanceof CodexMainProfileDrainingError)
    ) throw err;
  }
}

function responsesVisionPlan(
  { config, options }: SidecarRequestContext,
  { provider, providerName, modelId }: ComboTargetRoute,
  parsed: OcxParsedRequest,
  openAiSidecar: ResolvedOpenAiForwardSidecar | undefined,
) {
  const admissionScope = visionAdmissionScope(config, options);
  const plan = planVisionSidecar(responsesVisionConfig({ config, options }), provider, modelId, parsed, openAiSidecar, {
    admission: options.admission, codexAuthPolicy: options.codexAuthPolicy, providerName,
    admissionScope,
  });
  if (plan?.backend === "routed") {
    const callerPolicy = options.advisorAdmissionPolicy ?? captureAdmissionPolicy(config, options.admission, admissionScope);
    plan.advisorAdmissionPolicy = { ...callerPolicy, modelScope: admissionScope ?? callerPolicy.modelScope };
  }
  return plan;
}

function visionAdmissionScope(config: SidecarRequestContext["config"], options: SidecarRequestContext["options"]) {
  return intersectAdmissionModelScopes(
    options.admissionScope ?? resolveAdmissionModelScope(config, options.admission),
    options.advisorAdmissionPolicy?.modelScope,
  );
}

/** Use the child's real planner and auth rules, then return any unused recovery probe. */
export async function canDescribeComboImages(
  context: SidecarRequestContext,
  route: ComboTargetRoute,
  parsed: OcxParsedRequest,
): Promise<boolean> {
  if (context.options.visionDescribeTerminal) return false;
  const openAiSidecar = shouldResolveOpenAiVisionSidecar(responsesVisionConfig(context), route.provider, route.modelId, parsed, route.providerName,
    visionAdmissionScope(context.config, context.options))
    ? await resolveResponsesOpenAiSidecar(context, route) : undefined;
  try {
    const plan = responsesVisionPlan(context, route, parsed, openAiSidecar);
    return plan !== undefined && plan.maxDescriptionsPerTurn > 0;
  } finally {
    openAiSidecar?.releaseProbeLease?.();
  }
}

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function prepareResponsesSidecarAuth(
  requestContext: SidecarRequestContext,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "route"
    | "selectedForwardHeaders"
    | "translatorBudget"
  >,
  transportState: Pick<ResponsesTransport, "adapter" | "isPassthrough">,
) {
  const { options, config } = requestContext;
  const { parsed, route, translatorBudget } = requestState;
  const { isPassthrough } = transportState;


  let openAiSidecar: ResolvedOpenAiForwardSidecar | undefined;
  const visionDescribeTerminal = options.visionDescribeTerminal === true;
  const skipVision = visionDescribeTerminal || options.comboOmitImages === true;
  const routedCompaction = parsed._compactionRequest === true
    && (!supportsNativeResponsesCompactionTrigger(route.provider) || parsed._portableCompaction === true);
  const preserveCompactionPrefix = routedCompaction && transportState.adapter.name === "anthropic";
  if (routedCompaction) parsed.context.messages = omitEarlierCompactionImages(parsed.context.messages);
  const needsOpenAiVision = !skipVision
    && shouldResolveOpenAiVisionSidecar(responsesVisionConfig(requestContext), route.provider, route.modelId, parsed, route.providerName,
      visionAdmissionScope(config, options));
  // LOCAL PATCH (runturn-websearch): runTurn adapters can run the web-search
  // sidecar through src/web-search/run-turn-loop.ts, so resolve the helper
  // credential for them too. The passthrough bridge stays fetch-only.
  // A prefix-preserving summary resolves the helper like the ordinary turn, only to decide whether
  // the synthetic web_search is declared; it never searches (#7307).
  const needsOpenAiSearch = (!routedCompaction || preserveCompactionPrefix)
    && (transportState.adapter.runTurn
      ? shouldResolveOpenAiWebSearchSidecar(config, parsed, isPassthrough)
      : (shouldResolveOpenAiWebSearchSidecar(config, parsed, isPassthrough)
        || shouldResolveOpenAiPassthroughWebSearchBridge(route.provider, parsed, isPassthrough)));
  if (needsOpenAiVision || needsOpenAiSearch) {
    openAiSidecar = await resolveResponsesOpenAiSidecar(requestContext, route);
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Describe each
  // attached image through the selected sidecar backend and replace it with text BEFORE the main
  // call, so the text-only model can reason about it.
  // Terminal describe fence (roadmap 180): the sidecar's OWN loopback describe
  // call must never plan another describe. The flag arrives from the Chat
  // surface (whose bridge rebuilds headers) or as the raw header for native
  // Responses callers. Marked + text-only routed model → strip, depth cap 1.
  const visionPlan = skipVision
    ? undefined
    : responsesVisionPlan(requestContext, route, parsed, openAiSidecar);
  const recordSidecarOutcome = openAiSidecar?.recordOutcome;
  if (visionPlan && (!options.comboRequiresVisionPlan || visionPlan.maxDescriptionsPerTurn > 0)) {
    try {
      const complete = await describeImagesInPlace(
        parsed,
        visionPlan,
        openAiSidecar?.headers ?? requestState.selectedForwardHeaders,
        options.abortSignal,
        recordSidecarOutcome,
        translatorBudget,
        options.comboRequiresVisionPlan,
      );
      if (!complete && options.comboRequiresVisionPlan) {
        openAiSidecar?.releaseProbeLease?.();
        openAiSidecar = undefined;
        return policyCandidateRefusalResponse(new ComboVisionDescriptionUnavailableError())!;
      }
    } finally {
      // Local validation can reject every image before the sidecar fetch records an outcome.
      // Vision-only turns must hand that unused cooldown probe back; when a fetch did run the
      // outcome already consumed it, so this generation-bound release is a safe no-op.
      if (!needsOpenAiSearch) openAiSidecar?.releaseProbeLease?.();
    }
  } else if (requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName)) {
    // Image capability is not positively proven but no sidecar plan is dispatchable: fail closed.
    // Never forward raw image bytes to an unverified upstream.
    if (options.comboRequiresVisionPlan) {
      openAiSidecar?.releaseProbeLease?.();
      return policyCandidateRefusalResponse(new ComboVisionDescriptionUnavailableError())!;
    }
    stripImagesInPlace(parsed, translatorBudget);
    if (!needsOpenAiSearch) openAiSidecar?.releaseProbeLease?.();
  }

  return {
    openAiSidecar,
    routedCompaction,
    preserveCompactionPrefix,
  };
}

export type ResponsesSidecarAuth = Exclude<Awaited<ReturnType<typeof prepareResponsesSidecarAuth>>, Response>;
