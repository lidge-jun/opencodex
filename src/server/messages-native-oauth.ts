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
import { anthropicRoutingFor } from "../oauth/anthropic-routing";
import { resolveAnthropicModelRouteForInstance, routeCandidates, type AnthropicRouteDecision } from "../oauth/anthropic-model-routes";
import { configuredAnthropicInstance, type AnthropicInstanceId } from "../providers/anthropic-instance";
import { resolveAnthropicMessagesUrl } from "../adapters/anthropic";
import { routedProviderConfig } from "../router";
import {
  captureOAuthAccountSelection,
  commitOAuthAccountSelection,
  credentialGeneration,
  getAccountCredentialWithStatus,
} from "../oauth/store";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { OcxConfig } from "../types";
import { relaySseWithPayloadRewrite } from "./sse-payload-rewrite";

const MAX_SELECTION_ATTEMPTS = 3;

type Selection = NonNullable<ReturnType<typeof captureOAuthAccountSelection>>;
type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The committed selection and the credential snapshot one native request is served with. */
export interface NativeOAuthBinding {
  readonly instance: AnthropicInstanceId;
  /** Config-authorized physical destination, captured before any credential await. */
  readonly routeTarget: string;
  readonly selection: Selection;
  readonly snapshot: OAuthAccessSnapshot;
  /** Anthropic account UUID from the same stored generation, distinct from snapshot.accountId. */
  readonly providerAccountUuid?: string;
  readonly routeDecision: AnthropicRouteDecision | null;
  readonly sessionKey: string | null;
  readonly model?: string;
  readonly config: OcxConfig;
  readonly manualSelectionGeneration: number;
}

/** The selection moved or became ineligible while resolving. Maps to a 409 retry. */
export class NativeOAuthSelectionChangedError extends Error {
  constructor() {
    super("OAuth account selection changed; retry the request");
    this.name = "NativeOAuthSelectionChangedError";
  }
}

/** Invalid operator route configuration remains a request refusal, not an auth failure. */
export class NativeOAuthModelRouteError extends Error {}

/**
 * Current configured ownership and target; a revoked B never resolves orphan credentials.
 *
 * Adapter, auth mode and destination are read from the routed provider, the same normalization the
 * settled route used to compute its target. Routing canonicalizes the primary row's adapter and auth
 * mode from the registry, so a raw-field comparison would refuse an existing Pool 1 row the route
 * already accepted. B's own raw-row shape is still enforced through `configuredAnthropicInstance`.
 */
function nativeOAuthRouteTarget(instance: AnthropicInstanceId, config: OcxConfig): string {
  const provider = config.providers[instance];
  if (configuredAnthropicInstance(config, instance) !== instance || !provider || provider.disabled === true) {
    throw new NativeOAuthSelectionChangedError();
  }
  let routed: ReturnType<typeof routedProviderConfig>;
  try {
    routed = routedProviderConfig(instance, provider);
  } catch {
    // A destination the router now refuses is a moved route, not a different failure class.
    throw new NativeOAuthSelectionChangedError();
  }
  if (routed.authMode !== "oauth" || routed.adapter !== "anthropic") throw new NativeOAuthSelectionChangedError();
  return resolveAnthropicMessagesUrl(routed);
}

function currentRoute(instance: AnthropicInstanceId, config: OcxConfig, model?: string): AnthropicRouteDecision | null {
  const resolved = model ? resolveAnthropicModelRouteForInstance(instance, config, model) : { decision: null };
  if (resolved.error) throw new NativeOAuthModelRouteError(`Invalid Anthropic model routes: ${resolved.error}`);
  return resolved.decision ? { ...resolved.decision, accounts: [...resolved.decision.accounts] } : null;
}

function routeIsCurrent(instance: AnthropicInstanceId, config: OcxConfig, model: string | undefined, decision: AnthropicRouteDecision | null): boolean {
  return JSON.stringify(currentRoute(instance, config, model)) === JSON.stringify(decision);
}

export interface NativeOAuthBindingOptions {
  /** Settled route destination; retries may never authorize a replacement destination. */
  routeTarget?: string;
  sessionKey?: string | null;
  model?: string;
  /** An account proposed by the shared pre-output refusal recovery policy. */
  candidateAccountId?: string;
  /** Selection captured before asynchronous refusal classification or throttle wait. */
  expectedRecoverySelection?: Selection | null;
  expectedRecoveryRouteDecision?: AnthropicRouteDecision | null;
}

/** Compatibility entrypoint: the original instance only. */
export function resolveNativeOAuthBinding(config: OcxConfig, options: NativeOAuthBindingOptions = {}): Promise<NativeOAuthBinding> {
  return resolveNativeOAuthBindingForInstance("anthropic", config, options);
}

/** Resolve the shared pool selector and commit its exact credential generation for dispatch. */
export async function resolveNativeOAuthBindingForInstance(
  instance: AnthropicInstanceId,
  config: OcxConfig,
  options: NativeOAuthBindingOptions = {},
): Promise<NativeOAuthBinding> {
  const routeTarget = options.routeTarget ?? nativeOAuthRouteTarget(instance, config);
  const routing = anthropicRoutingFor(instance);
  const assertOwner = () => {
    if (nativeOAuthRouteTarget(instance, config) !== routeTarget) throw new NativeOAuthSelectionChangedError();
  };
  const sessionKey = options.sessionKey ?? null;
  const model = options.model;
  for (let attempt = 0; attempt < MAX_SELECTION_ATTEMPTS; attempt++) {
    assertOwner();
    const routeDecision = currentRoute(instance, config, model);
    const manualSelectionGeneration = routing.captureAnthropicManualSelectionGeneration();
    const selection = captureOAuthAccountSelection(instance);
    // Always ask admission first so pause/login/cooldown retains its typed local refusal.
    const admittedId = await routing.resolveAnthropicDispatchAccountId(config, sessionKey, routeDecision, model);
    assertOwner();
    if (!routeIsCurrent(instance, config, model, routeDecision)) continue;
    const proposed = routing.resolveAnthropicAccountForSession(sessionKey, config, Date.now(), routeDecision, model);
    // A lost selection commit discards a recovery proposal: a newer manual/policy choice wins.
    const recoverySelectionMatches = !!options.expectedRecoverySelection
      && selection?.accountId === options.expectedRecoverySelection.accountId
      && selection?.revision === options.expectedRecoverySelection.revision;
    const recoveryRouteMatches = options.expectedRecoveryRouteDecision === undefined
      || JSON.stringify(options.expectedRecoveryRouteDecision) === JSON.stringify(routeDecision);
    const accountId = attempt === 0 && options.candidateAccountId && recoverySelectionMatches && recoveryRouteMatches
      ? options.candidateAccountId : admittedId;
    if (!selection) continue;
    if (!routeCandidates(routing.getEligibleAnthropicAccounts(Date.now(), model), routeDecision).includes(accountId)) {
      throw new NativeOAuthSelectionChangedError();
    }
    const candidate = await routing.getAnthropicPoolAccessSnapshot(accountId);
    assertOwner();
    if (candidate.provider !== instance) throw new NativeOAuthSelectionChangedError();
    if (!routeIsCurrent(instance, config, model, routeDecision)) continue;
    const committed = await commitOAuthAccountSelection(instance, candidate.accountId, {
      expectedSelection: selection,
      expectedCredentialGeneration: candidate.generation,
      requireUsableAccount: true,
    });
    assertOwner();
    if (committed) {
      if (!routeIsCurrent(instance, config, model, routeDecision)
        || manualSelectionGeneration !== routing.captureAnthropicManualSelectionGeneration()) continue;
      if (!routing.commitAnthropicSelectionRouting(candidate.accountId, selection, committed, {
        config, sessionKey, model, routeDecision,
        reason: accountId === proposed.accountId ? proposed.reason : undefined,
        expectedCredentialGeneration: candidate.generation,
      })) continue;
      const row = getAccountCredentialWithStatus(instance, candidate.accountId);
      if (!row || row.credential.access !== candidate.accessToken || credentialGeneration(row.credential) !== candidate.generation) continue;
      const binding: NativeOAuthBinding = { instance, routeTarget, selection: committed, snapshot: candidate, providerAccountUuid: row.credential.accountId, routeDecision, sessionKey, model, config, manualSelectionGeneration };
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
  const { instance } = binding;
  const routing = anthropicRoutingFor(instance);
  try {
    if (nativeOAuthRouteTarget(instance, binding.config) !== binding.routeTarget) return false;
  } catch { return false; }
  if (binding.snapshot.provider !== instance) return false;
  if (binding.manualSelectionGeneration !== routing.captureAnthropicManualSelectionGeneration()
    || !routeIsCurrent(instance, binding.config, binding.model, binding.routeDecision)) return false;
  const selected = captureOAuthAccountSelection(instance);
  const row = getAccountCredentialWithStatus(instance, binding.snapshot.accountId);
  const sessionRoute = routing.isAnthropicAccountPoolEnabled(binding.config) && binding.sessionKey
    ? routing.resolveAnthropicAccountForSession(binding.sessionKey, binding.config, Date.now(), binding.routeDecision, binding.model) : null;
  // Another conversation may move the automatic active pointer without revoking this
  // session's affinity. Manual selection clears affinity and precedes it in the selector.
  const selectionCurrent = sessionRoute?.reason === "affinity"
    && sessionRoute.accountId === binding.snapshot.accountId
    || (selected?.accountId === binding.selection.accountId && selected?.revision === binding.selection.revision);
  return selectionCurrent
    && !!row && !row.paused && !row.needsReauth && row.credential.expires > Date.now()
    && !routing.getAnthropicAccountHealthSnapshot(binding.snapshot.accountId)
    && routeCandidates(routing.getEligibleAnthropicAccounts(Date.now(), binding.model), binding.routeDecision).includes(binding.snapshot.accountId)
    && row.credential.access === binding.snapshot.accessToken
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
