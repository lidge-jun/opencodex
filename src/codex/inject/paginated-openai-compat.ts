/**
 * The way forward for a provider-table transition that finds an `openai`-tagged row
 * Codex has already migrated to paginated history.
 *
 * The refusal this resolves is correct about the danger and wrong about the remedy.
 * A provider-table transition takes the root `openai_base_url` out, and a paginated row
 * cannot be relabeled, so the transition as planned would send that conversation to
 * Codex's built-in OpenAI endpoint. Refusing to relabel is right. Refusing the whole
 * transition left #5321's reporter with 173 conversations and two unsupported exits:
 * delete them, or downgrade.
 *
 * There is a third state, and the injector already builds it for the client-compaction
 * form: keep the marker-owned root override beside the provider table. Codex merges the
 * override onto its built-in `openai` entry when it builds the provider map, so the
 * paginated row keeps reaching this proxy while never being rewritten. The transition
 * completes, the relabel stands down, and no rollout byte or thread row is touched.
 *
 * Two cases cannot reach that state. An admission-token form cannot use the root key at
 * all, because Codex's built-in `openai` entry carries no `x-opencodex-api-key` header;
 * that one keeps the refusal and names what the operator can actually do. A root line the
 * user owns is left alone, and the conversation follows their configuration rather than
 * this proxy — the same guarantee the injector already makes everywhere else about a line
 * it does not own.
 */
import { HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE, HISTORY_RELABEL_STANDS_DOWN } from "../history-provider";
import { applyEol, setRootOpenaiBaseUrlForTarget, stripInjectedOpenaiBaseUrl } from "./config-toml";
import type { CodexRoutingTarget } from "./routing-target";

export interface PaginatedOpenaiCompatDecision {
  /** The refusal that survives. `null` only when the preflight raised none. */
  readonly refusal: string | null;
  /** Candidate config bytes, carrying the retained root override when one was written. */
  readonly content: string;
  /** True only when OpenCodex wrote the retained line and must journal it as its own. */
  readonly retainedRootOverride: boolean;
  /** What the caller reports when `refusal` is not the stand-down reason. */
  readonly message: string;
}

function genericRefusal(refusal: string): string {
  return `Codex config injection refused: ${refusal}. `
    + "Existing provider definitions and conversation files were preserved. "
    + "Paginated history requires native-writer coordination; do not run legacy recovery or retry this transition blindly.";
}

/**
 * Named next actions, because "do not retry" is what trapped the reporter. Both are
 * configuration the operator already owns: the loopback listener is what makes the root
 * override usable, and `syncResumeHistory` is the existing opt-out from history remapping.
 */
function admissionTokenRefusal(): string {
  return `Codex config injection refused: ${HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE}. `
    + "Existing provider definitions and conversation files were preserved. "
    + "This home has conversations tagged openai whose history Codex has already migrated to its paginated "
    + "format, and they cannot be relabeled. Keeping them on this proxy needs a root openai_base_url override, "
    + "which this routing form cannot use: Codex's built-in openai provider carries no x-opencodex-api-key header. "
    + "To complete the transition, either route Codex through the loopback listener "
    + "(unauthenticatedLoopbackListener.enabled, or a loopback hostname) so the override can be retained, "
    + "or set syncResumeHistory to false to accept that those conversations resume against Codex's own OpenAI endpoint.";
}

/**
 * Resolve the transition, retaining the root override when this routing form can own one.
 *
 * `content` is the fully assembled provider-table candidate: OpenCodex's own root override
 * has already been stripped and not re-added, so a root `openai_base_url` still present in it
 * belongs to the user.
 */
export function applyPaginatedOpenaiCompat(
  refusal: string | null,
  target: CodexRoutingTarget,
  content: string,
  eol: "\r\n" | "\n",
): PaginatedOpenaiCompatDecision {
  if (refusal !== HISTORY_PAGINATED_OPENAI_NEEDS_ROOT_OVERRIDE) {
    return { refusal, content, retainedRootOverride: false, message: refusal ? genericRefusal(refusal) : "" };
  }
  if (target.requiresAdmissionToken === true) {
    return { refusal, content, retainedRootOverride: false, message: admissionTokenRefusal() };
  }
  const written = setRootOpenaiBaseUrlForTarget(stripInjectedOpenaiBaseUrl(applyEol(content, "\n")), target);
  // The relabel still stands down either way: the row stays tagged openai and paginated, and
  // the caller uses this reason to skip the history unit rather than let it start and refuse.
  return {
    refusal: HISTORY_RELABEL_STANDS_DOWN,
    content: written.keptUserBaseUrl ? content : applyEol(written.content, eol),
    retainedRootOverride: !written.keptUserBaseUrl,
    message: "",
  };
}
