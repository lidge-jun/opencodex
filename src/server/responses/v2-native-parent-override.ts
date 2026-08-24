import type { OcxConfig, OcxParsedRequest } from "../../types";
import { routeModel, type RouteResult } from "../../router";
import type { PolicyRequestEvidence } from "../../routing/evaluator";
import { collabSurface } from "./collaboration";
import { isThreadSpawnRequest } from "../effort-policy";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";

export type V2NativeParentOverrideDecision =
  | { kind: "skip" }
  | { kind: "reject"; message: string; trace?: unknown }
  | { kind: "override"; route: RouteResult };

export function decideV2NativeParentOverride(args: {
  kind: "responses" | "compact";
  config: OcxConfig;
  headers: Headers;
  sourceRoute: RouteResult;
  parsed?: OcxParsedRequest;
  comboAttempt?: boolean;
  targetEvidence?: PolicyRequestEvidence;
}): V2NativeParentOverrideDecision {
  const { config, headers, sourceRoute } = args;
  if (args.comboAttempt || config.v2NativeParentOverride?.enabled !== true) return { kind: "skip" };
  if (args.kind === "compact") {
    if (config.multiAgentMode !== "v2") return { kind: "skip" };
  } else if (
    !args.parsed
    || (collabSurface(args.parsed) !== "v2"
      && !(args.parsed._compactionRequest === true && config.multiAgentMode === "v2"))
  ) {
    return { kind: "skip" };
  }
  if (isThreadSpawnRequest(headers) || headers.has("x-openai-subagent")) return { kind: "skip" };
  if (!isCanonicalOpenAiForwardProvider(sourceRoute.provider)) return { kind: "skip" };

  const targetModel = config.v2NativeParentOverride.model?.trim();
  if (!targetModel) {
    return { kind: "reject", message: "v2NativeParentOverride requires a configured model" };
  }
  let route: RouteResult;
  try {
    route = routeModel(config, targetModel, args.targetEvidence);
  } catch (error) {
    return {
      kind: "reject",
      message: error instanceof Error ? error.message : String(error),
      trace: (error as { trace?: unknown }).trace,
    };
  }
  if (isCanonicalOpenAiForwardProvider(route.provider)) {
    return { kind: "reject", message: "v2NativeParentOverride target must resolve to a noncanonical provider" };
  }
  return { kind: "override", route };
}
