/**
 * Anthropic OAuth on the managed native Messages lane (PF-10, behind
 * `protocols.rollout.managedMessagesNativeOAuth`).
 *
 * Credential. The account is the one the existing OAuth selection chooses for this request, by
 * the same steps the Responses pipeline's transport takes for an unpooled Anthropic OAuth route
 * (`prepareResponsesTransport`): capture the committed selection, resolve an eligible account's
 * access snapshot (including pause/cooldown recovery), and commit that
 * proposal against the captured selection so a concurrent manual switch wins. Nothing here picks
 * an account of its own, and nothing runs at planning time: the planner and eligibility read
 * config only, and this module is reached from the lane's dispatch alone.
 *
 * Pools. A pooled account set (the opt-in Anthropic account pool, or two or more usable accounts,
 * which turns on reactive 429 rotation) is declined before this lane is chosen
 * (`oauth-account-pool`). Should one appear between that decision and dispatch, resolution fails
 * closed rather than serve a pooled account without the pool's rotation and affinity. This
 * lane-change 409 is distinct from the shared local authentication/pause/cooldown refusals.
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
  hasAnthropicFailoverQuorum,
  isAnthropicAccountPoolEnabled,
} from "../oauth/anthropic-routing";
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
}

/** The selection moved or became pooled while it was being resolved. Maps to a 409 retry. */
export class NativeOAuthSelectionChangedError extends Error {
  constructor() {
    super("OAuth account selection changed; retry the request");
    this.name = "NativeOAuthSelectionChangedError";
  }
}

function pooled(config: OcxConfig): boolean {
  return isAnthropicAccountPoolEnabled(config) || hasAnthropicFailoverQuorum();
}

/**
 * Resolve and commit the account for one native request. Throws the OAuth owner's own errors
 * (login required, refresh failure) unchanged, and `NativeOAuthSelectionChangedError` when the
 * selection could not be committed.
 */
export async function resolveNativeOAuthBinding(config: OcxConfig): Promise<NativeOAuthBinding> {
  for (let attempt = 0; attempt < MAX_SELECTION_ATTEMPTS; attempt++) {
    const selection = captureOAuthAccountSelection(PROVIDER);
    // Resolve eligibility before the lane guard: a local 401/403/429 must not turn
    // into a generic lane-change 409 merely because it appeared during pacing.
    const accountId = await resolveAnthropicDispatchAccountId(config);
    if (pooled(config)) throw new NativeOAuthSelectionChangedError();
    if (!selection) continue;
    const candidate = await getAnthropicPoolAccessSnapshot(accountId);
    const committed = await commitOAuthAccountSelection(PROVIDER, candidate.accountId, {
      expectedSelection: selection,
      expectedCredentialGeneration: candidate.generation,
      requireUsableAccount: true,
    });
    if (committed) {
      if (!commitAnthropicSelectionRouting(candidate.accountId, selection, committed, {
        config,
        sessionKey: null,
        expectedCredentialGeneration: candidate.generation,
      })) continue;
      if (pooled(config)) break;
      const row = getAccountCredentialWithStatus(PROVIDER, candidate.accountId);
      if (!row || credentialGeneration(row.credential) !== candidate.generation) continue;
      const binding = { selection: committed, snapshot: candidate, providerAccountUuid: row.credential.accountId };
      if (nativeOAuthBindingIsCurrent(binding)) return binding;
    }
    // Re-read after a lost commit or a health change during credential resolution.
  }
  throw new NativeOAuthSelectionChangedError();
}

/**
 * Whether a binding may still be sent: the same committed selection, and the same usable,
 * unexpired credential generation. Checked immediately before every physical send.
 */
export function nativeOAuthBindingIsCurrent(binding: NativeOAuthBinding): boolean {
  const selected = captureOAuthAccountSelection(PROVIDER);
  const row = getAccountCredentialWithStatus(PROVIDER, binding.snapshot.accountId);
  return selected?.accountId === binding.selection.accountId
    && selected?.revision === binding.selection.revision
    && !!row && !row.paused && !row.needsReauth && row.credential.expires > Date.now()
    && !getAnthropicAccountHealthSnapshot(binding.snapshot.accountId)
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
