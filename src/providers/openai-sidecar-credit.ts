import {
  CodexPoolAccountCreditsOffError,
  releaseCodexAuthContextProbeLease,
  unwrapUpstreamRetryEvidenceError,
  type CodexAuthContext,
  type CodexAuthPolicyConfig,
} from "../codex/auth-context";
import { poolContextCreditHoldResetAt } from "../codex/pool-credit-policy";

export function createOpenAiSidecarCreditGuard(
  context: CodexAuthContext,
  policy: CodexAuthPolicyConfig,
): (() => void) | undefined {
  if (context.kind !== "pool") return undefined;
  return () => {
    const resetAt = poolContextCreditHoldResetAt(context, policy);
    if (resetAt === undefined) return;
    releaseCodexAuthContextProbeLease(context);
    throw new CodexPoolAccountCreditsOffError(context.accountId, resetAt);
  };
}

export function openAiSidecarCreditRefusal(error: unknown): CodexPoolAccountCreditsOffError | undefined {
  const cause = unwrapUpstreamRetryEvidenceError(error);
  return cause instanceof CodexPoolAccountCreditsOffError ? cause : undefined;
}
