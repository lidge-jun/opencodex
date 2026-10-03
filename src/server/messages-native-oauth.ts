/**
 * Anthropic OAuth on the managed native Messages lane (PF-10, behind
 * `protocols.rollout.managedMessagesNativeOAuth`).
 *
 * Credential. Shared Anthropic routing chooses the account for the session and model;
 * the same generation-fenced selection commit as the Responses transport admits it. A lost
 * commit re-evaluates routing so a concurrent manual switch or policy edit wins. Selection,
 * token resolution and affinity binding run at dispatch only, never during planning.
 *
 * Pools. Native Messages uses the OAuth owner's strategy, model allowlist, session affinity,
 * pause and cooldown admission. Pre-output refusal recovery proposes a replacement account;
 * this module admits and binds its exact generation before a rebuilt request may send.
 * A lane-change 409 remains distinct from typed local authentication/pause/cooldown refusals.
 *
 * Tool names. An OAuth request carries client tool names under the Claude OAuth prefix, as the
 * adapter sends them; the answer's `tool_use` names are mapped back here, for exactly the names
 * the builder renamed.
 *
 * No token, account id or body content is logged or returned in an error message.
 */
import type { OAuthAccessSnapshot } from "../oauth";
import {
  commitAnthropicSelectionRouting,
  getAnthropicPoolAccessSnapshot,
  getAnthropicAccountHealthSnapshot,
  resolveAnthropicDispatchAccountId,
  resolveAnthropicAccountForSession,
  getEligibleAnthropicAccounts,
  isAnthropicAccountPoolEnabled,
} from "../oauth/anthropic-routing";
import { resolveAnthropicModelRoute, routeCandidates, type AnthropicRouteDecision } from "../oauth/anthropic-model-routes";
import {
  captureOAuthAccountSelection,
  commitOAuthAccountSelection,
  credentialGeneration,
  getAccountCredentialWithStatus,
} from "../oauth/store";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { OcxConfig } from "../types";
import { relaySseWithPayloadRewrite } from "./sse-payload-rewrite";

const PROVIDER = "anthropic";
const MAX_SELECTION_ATTEMPTS = 3;

type Selection = NonNullable<ReturnType<typeof captureOAuthAccountSelection>>;
type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The committed selection and the credential snapshot one native request is served with. */
export interface NativeOAuthBinding {
  readonly selection: Selection;
  readonly snapshot: OAuthAccessSnapshot;
  /** Anthropic account UUID from the same stored generation, distinct from snapshot.accountId. */
  readonly providerAccountUuid?: string;
  readonly routeDecision: AnthropicRouteDecision | null;
  readonly sessionKey: string | null;
  readonly model?: string;
  readonly config: OcxConfig;
}

/** The selection moved or became ineligible while resolving. Maps to a 409 retry. */
export class NativeOAuthSelectionChangedError extends Error {
  constructor() {
    super("OAuth account selection changed; retry the request");
    this.name = "NativeOAuthSelectionChangedError";
  }
}

export interface NativeOAuthBindingOptions {
  sessionKey?: string | null;
  model?: string;
  /** An account proposed by the shared pre-output refusal recovery policy. */
  candidateAccountId?: string;
  /** Selection captured before asynchronous refusal classification or throttle wait. */
  expectedRecoverySelection?: Selection | null;
}

/** Resolve the shared pool selector and commit its exact credential generation for dispatch. */
export async function resolveNativeOAuthBinding(
  config: OcxConfig,
  options: NativeOAuthBindingOptions = {},
): Promise<NativeOAuthBinding> {
  const sessionKey = options.sessionKey ?? null;
  const model = options.model;
  const resolvedRoute = model ? resolveAnthropicModelRoute(config, model) : { decision: null };
  if (resolvedRoute.error) throw new Error(`Invalid Anthropic model routes: ${resolvedRoute.error}`);
  const routeDecision = resolvedRoute.decision;
  for (let attempt = 0; attempt < MAX_SELECTION_ATTEMPTS; attempt++) {
    const selection = captureOAuthAccountSelection(PROVIDER);
    // Always ask admission first so pause/login/cooldown retains its typed local refusal.
    const admittedId = await resolveAnthropicDispatchAccountId(config, sessionKey, routeDecision, model);
    const proposed = resolveAnthropicAccountForSession(sessionKey, config, Date.now(), routeDecision, model);
    // A lost selection commit discards a recovery proposal: a newer manual/policy choice wins.
    const recoverySelectionMatches = !!options.expectedRecoverySelection
      && selection?.accountId === options.expectedRecoverySelection.accountId
      && selection?.revision === options.expectedRecoverySelection.revision;
    const accountId = attempt === 0 && options.candidateAccountId && recoverySelectionMatches
      ? options.candidateAccountId : admittedId;
    if (!selection) continue;
    if (!routeCandidates(getEligibleAnthropicAccounts(Date.now(), model), routeDecision).includes(accountId)) {
      throw new NativeOAuthSelectionChangedError();
    }
    const candidate = await getAnthropicPoolAccessSnapshot(accountId);
    const committed = await commitOAuthAccountSelection(PROVIDER, candidate.accountId, {
      expectedSelection: selection,
      expectedCredentialGeneration: candidate.generation,
      requireUsableAccount: true,
    });
    if (committed) {
      if (!commitAnthropicSelectionRouting(candidate.accountId, selection, committed, {
        config, sessionKey, model, routeDecision,
        reason: accountId === proposed.accountId ? proposed.reason : undefined,
        expectedCredentialGeneration: candidate.generation,
      })) continue;
      const row = getAccountCredentialWithStatus(PROVIDER, candidate.accountId);
      if (!row || credentialGeneration(row.credential) !== candidate.generation) continue;
      const binding = { selection: committed, snapshot: candidate, providerAccountUuid: row.credential.accountId, routeDecision, sessionKey, model, config };
      if (nativeOAuthBindingIsCurrent(binding)) return binding;
    }
  }
  throw new NativeOAuthSelectionChangedError();
}

/**
 * Whether a binding may still be sent: a live pooled session affinity or the same committed
 * selection, plus the same usable credential generation. Checked before every physical send.
 */
export function nativeOAuthBindingIsCurrent(binding: NativeOAuthBinding): boolean {
  const selected = captureOAuthAccountSelection(PROVIDER);
  const row = getAccountCredentialWithStatus(PROVIDER, binding.snapshot.accountId);
  const sessionRoute = isAnthropicAccountPoolEnabled(binding.config) && binding.sessionKey
    ? resolveAnthropicAccountForSession(binding.sessionKey, binding.config, Date.now(), binding.routeDecision, binding.model) : null;
  // Another conversation may move the automatic active pointer without revoking this
  // session's affinity. Manual selection clears affinity and precedes it in the selector.
  const selectionCurrent = sessionRoute?.reason === "affinity"
    && sessionRoute.accountId === binding.snapshot.accountId
    || (selected?.accountId === binding.selection.accountId && selected?.revision === binding.selection.revision);
  return selectionCurrent
    && !!row && !row.paused && !row.needsReauth && row.credential.expires > Date.now()
    && !getAnthropicAccountHealthSnapshot(binding.snapshot.accountId)
    && routeCandidates(getEligibleAnthropicAccounts(Date.now(), binding.model), binding.routeDecision).includes(binding.snapshot.accountId)
    && credentialGeneration(row.credential) === binding.snapshot.generation
    && row.credential.accountId === binding.providerAccountUuid;
}

/** Map a `tool_use` block's wire name back to the caller's name; other blocks are untouched. */
function restoredBlock(block: unknown, names: ReadonlyMap<string, string>): unknown {
  if (!isRec(block) || block.type !== "tool_use" || typeof block.name !== "string") return block;
  const original = names.get(block.name);
  return original === undefined ? block : { ...block, name: original };
}

/** A Messages result with renamed `tool_use` names mapped back. Returns the input when unchanged. */
export function restoreOAuthToolNamesInMessage(message: Rec, names: ReadonlyMap<string, string>): Rec {
  if (names.size === 0 || !Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(block => restoredBlock(block, names)) };
}

/** The upstream Messages stream with renamed `tool_use` names mapped back in `content_block_start`. */
export function restoreOAuthToolNamesInSse(
  body: ReadableStream<Uint8Array>,
  names: ReadonlyMap<string, string>,
  translatorBudget: TranslatorBudget,
): ReadableStream<Uint8Array> {
  if (names.size === 0) return body;
  return relaySseWithPayloadRewrite(body, (payload) => {
    if (!payload.includes("content_block_start")) return payload;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return payload; }
    if (!isRec(parsed) || parsed.type !== "content_block_start") return payload;
    const restored = restoredBlock(parsed.content_block, names);
    return restored === parsed.content_block ? payload : JSON.stringify({ ...parsed, content_block: restored });
  }, translatorBudget);
}
