import type { AdapterEvent, OcxParsedRequest } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { RequestExecutionBudget } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind, AttemptRecoveryWithheld } from "../usage/log";
import type { AdapterTierMetadata } from "../providers/fastwire";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  translatorBudget: TranslatorBudget;
  abortSignal?: AbortSignal;
  /** Combo children must surface a pre-output refusal so the selector can try the next target. */
  comboAttempt?: boolean;
  /**
   * Provider-scoped fetch prepared by the Responses router. Stateful transports that emit more
   * than one physical HTTP request per logical turn must reuse it so every request participates in
   * the same pacing queue and custom provider fetch seam.
   */
  providerFetch?: typeof globalThis.fetch;
  /**
   * Image-normalization ladder bias for upstream-413 tightened retries: every image
   * starts one tier lower (devlog/260714_image_normalization_pipeline/030). Consumed by
   * the anthropic and openai-chat adapters; others ignore it.
   */
  imageTierBias?: number;
  /**
   * The enclosing request's send budget, for adapters that own their upstream transport.
   *
   * A `runTurn` adapter never receives an `AdapterFetchContext`, so the budget that bounds every
   * other leg could not reach it: Cursor re-sends a whole turn up to three times inside one
   * adapter call, and the request cap counted that as one send. Optional, and absent means
   * unlimited, because adapter unit tests build a meta with neither a budget nor a request
   * behind it (#4546).
   */
  sendBudget?: RequestExecutionBudget;
  /**
   * Physical-send observations for runTurn adapters. Without the same callback carried by
   * AdapterFetchContext, an adapter-owned replay spends the shared budget but remains absent
   * from the request's sendCount.
   */
  onPhysicalSend?: (send: { ordinal: number; recovery?: AttemptRecoveryKind }) => void;
  /**
   * Recovery refusals for runTurn adapters. A refused replay is not a send, so this separate
   * channel explains why recovery stopped without inflating physical-send telemetry.
   */
  onRecoveryWithheld?: (withheld: { reason: AttemptRecoveryWithheld }) => void;
}

export interface ProviderAdapter {
  name: string;

  /**
   * This adapter reports every physical inference send through `IncomingMeta.onPhysicalSend`,
   * including its first.
   *
   * The caller normally logs the first send before handing control over, which is correct for a
   * transport whose sends it can see. An adapter that admits its own sends through the shared
   * budget can have that first send refused, and a send logged before admission is a send the
   * log claims and the wire never made. Setting this moves the first send's accounting to the
   * boundary where it is actually dispatched.
   */
  reportsPhysicalSends?: boolean;

  /**
   * Convert an already-read provider HTTP error into client-safe text. This hook must be pure and
   * return fully redacted output: callers may pass untrusted provider headers and payload text.
   */
  formatErrorBody?(status: number, headers: Headers, payloadText: string): string;

  /**
   * Build the upstream request. May be async: adapters that resolve a short-lived credential
   * (e.g. Vertex AI ADC token) return a Promise. Sync adapters return the object directly; callers
   * must `await` the result (awaiting a non-Promise is a no-op).
   */
  buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;

  /**
   * Decide, BEFORE any request is built or sent, that this turn has nothing to ask upstream.
   *
   * Returning a reason short-circuits the turn to a locally constructed completed response: no
   * `buildRequest`, no send, no token estimate, and no empty-completion retry. That last part is
   * why this cannot be expressed as an outputless `done` from `parseStream`: the empty-completion
   * guard treats a terminal with no content as a failed turn and re-invokes the identical request,
   * so an adapter that "successfully returned nothing" would be retried into the very loop it was
   * trying to end.
   *
   * Only for turns whose input already contains the answer — see the Kiro adapter, where replayed
   * history ending in a delivered final answer has nothing left to complete.
   */
  localTerminal?(parsed: OcxParsedRequest): AdapterLocalTerminal | undefined;

  fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;

  /**
   * Parse one upstream response. `tierMetadata` is the same live observer returned on the
   * corresponding AdapterRequest; adapters that receive a documented tier echo may update it.
   */
  parseStream(
    response: Response,
    budget: TranslatorBudget,
    tierMetadata?: AdapterTierMetadata,
  ): AsyncGenerator<AdapterEvent>;
  parseResponse?(
    response: Response,
    budget: TranslatorBudget,
    tierMetadata?: AdapterTierMetadata,
  ): Promise<AdapterEvent[]>;
  runTurn?(
    parsed: OcxParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;

  /** Exact no-field observation for runTurn adapters, which expose no AdapterRequest object. */
  tierLogForRunTurn?(parsed: OcxParsedRequest): AdapterTierMetadata | undefined;
}

export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    /** Final upstream wire names of custom tools lowered to functions while building this request. */
    convertedRoutedCustomToolNames?: ReadonlySet<string>;
    /** Native custom-tool wire names authorized for representation-only response repair. */
    routedCustomToolRepairNames?: ReadonlySet<string>;
    /** Client tool-search names actually lowered to upstream function calls for this request. */
    convertedRoutedToolSearchNames?: ReadonlySet<string>;
    /** Upstream-only aliases for namespace tools flattened in this request. */
    convertedRoutedNamespaceToolAliases?: ReadonlyMap<string, { namespace: string; name: string; kind: "function" | "custom" }>;
    /** Request-declared collaboration child names eligible for plaintext-v2 alias restoration. */
    plaintextV2AgentMessageToolNames?: ReadonlySet<string>;
    /** Collaboration message-tool names actually rewritten to fixed aliases in this request. */
    plaintextV2AgentMessageAliasedToolNames?: ReadonlySet<string>;
    /** Upstream-only <=64-char aliases for Meta Muse tool names rewritten in this request. */
    convertedMuseToolNameAliases?: ReadonlyMap<string, string>;
    /** Releases observation of a serialized request body after its final fetch attempt settles. */
    releaseBodyObservation?: () => void;
    /** Exact reasoning parameter emitted by the adapter, for request-log diagnostics only. */
    reasoningLog?:
      | {
          effectiveEffort: string;
          wireField: "reasoning.enabled";
          wireValue: boolean;
        }
      | {
          effectiveEffort: string;
          wireField: "thinking_budget";
          wireValue: number;
        }
      | {
          effectiveEffort: string;
          wireField: "reasoning_effort" | "reasoning.effort" | "thinking.type";
          wireValue: string;
        };
    /**
     * Exact tier outcome seeded after this adapter serialized the outbound request.
     * This is a live shared observer: response-phase methods mutate `outcome`, so retain
     * the reference rather than cloning or snapshotting it.
     */
    tierLog?: AdapterTierMetadata;
    usageLog?: {
      inputTokens?: number;
      estimated?: boolean;
    };
}

export interface AdapterFetchContext {
  /** Remains attached to the returned response body after the response headers arrive. */
  abortSignal?: AbortSignal;
  /** Deadline for receiving response headers on each attempt, not for consuming the response body. */
  timeoutMs?: number;
  /** Return final non-2xx responses untouched so the caller can own the error-body read. */
  returnRawErrors?: boolean;
  /** Whether the upstream response will be consumed as a stream; adapters may select low-latency transport settings. */
  stream?: boolean;
  /** Custom fetch executor to use for physical upstream network requests (defaults to globalThis.fetch). */
  executor?: typeof globalThis.fetch;
  /**
   * The logical request's send budget (#4546). Optional and unlimited when absent, so an
   * adapter unit test that calls a transport context-free keeps its own retry shape. An
   * adapter that retries internally must admit EVERY physical send against it: counting one
   * adapter entry as one send is how a nested 3x3 ladder stayed invisible to a request cap.
   */
  sendBudget?: RequestExecutionBudget;
  /**
   * Observes every physical upstream send this adapter makes, including its own inner retries.
   *
   * `ordinal` counts from 1 within this fetch call, so a caller that already recorded the entry
   * send records only ordinals above 1 and an adapter that never retries internally logs exactly
   * what it logs today. Kiro and Cursor were unpinnable without this: they report one send per
   * adapter call however many requests they actually made, so their inner ladders were invisible
   * to `sendCount` and no regression could assert a count for them (#4546).
   */
  onPhysicalSend?: (send: { ordinal: number; recovery?: AttemptRecoveryKind }) => void;
  /**
   * Observes a recovery this adapter was ready to make and did not, because the send budget
   * refused the dispatch.
   *
   * Separate from `onPhysicalSend` because nothing was sent: folding it in would inflate
   * `sendCount`, the one number that means "requests this proxy actually made". Without it a
   * log with one send cannot distinguish "no recovery was eligible" from "one was and the
   * budget withheld it", and those need opposite follow-ups (#5044).
   */
  onRecoveryWithheld?: (withheld: { reason: AttemptRecoveryWithheld }) => void;
}

/**
 * An adapter's decision that a turn needs no upstream inference at all.
 *
 * `reason` is diagnostic only. It is never sent to the client and never logged as request
 * content: it names the code path for a maintainer reading a request log, so it must stay a
 * fixed identifier rather than anything derived from the conversation.
 */
export interface AdapterLocalTerminal {
  reason: string;
}
