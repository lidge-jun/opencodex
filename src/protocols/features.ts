/**
 * Request features whose survival depends on the protocol path, and the declared
 * disposition of each feature across every cross-wire hop.
 *
 * LEAF MODULE (see `contract.ts`). Dispositions reuse the compatibility-manifest vocabulary
 * (`passthrough | translated | degraded | unsupported`). A hop into `other` has no entry on
 * purpose: nothing is claimed about adapters outside the three public protocols, and an absent
 * entry is how "unknown" is spelled here — never as a fifth disposition.
 *
 * These are declared claims about the current code, pinned by fixtures; they are not Lab
 * evidence and they never imply VERIFIED.
 */
import type { CompatibilityDisposition } from "../compatibility/manifest";
import { protocolNodes, type Fidelity, type Protocol, type ProtocolHop, type UpstreamWire } from "./contract";

export type FeatureDisposition = CompatibilityDisposition;

export const PROTOCOL_FEATURES = [
  "request.tools",
  "request.hosted_tools",
  "request.images",
  "request.documents",
  "request.multiple_choices",
  "request.logprobs",
  "request.logit_bias",
  "request.seed",
  "request.audio",
  "request.prediction",
  "request.response_format",
  "request.reasoning",
  "request.thinking_budget",
  "request.top_k",
  "request.cache_control",
  "request.previous_response_id",
  "request.store",
  "request.background",
  "request.compaction",
] as const;
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];

const FEATURE_SET = new Set<string>(PROTOCOL_FEATURES);
export function isProtocolFeature(value: unknown): value is ProtocolFeature {
  return typeof value === "string" && FEATURE_SET.has(value);
}

/** Which public protocols can express each feature at all. */
export const FEATURE_SOURCES: Readonly<Record<ProtocolFeature, readonly Protocol[]>> = {
  "request.tools": ["responses", "chat", "messages"],
  "request.hosted_tools": ["responses"],
  "request.images": ["responses", "chat", "messages"],
  "request.documents": ["responses", "chat", "messages"],
  "request.multiple_choices": ["chat"],
  "request.logprobs": ["responses", "chat"],
  "request.logit_bias": ["chat"],
  "request.seed": ["chat"],
  "request.audio": ["chat"],
  "request.prediction": ["chat"],
  "request.response_format": ["responses", "chat"],
  "request.reasoning": ["responses", "chat", "messages"],
  "request.thinking_budget": ["messages"],
  "request.top_k": ["messages"],
  "request.cache_control": ["messages"],
  "request.previous_response_id": ["responses"],
  "request.store": ["responses"],
  "request.background": ["responses"],
  "request.compaction": ["responses"],
};

type WireHop = `${Protocol}>${Protocol}`;
const T: FeatureDisposition = "translated";
const D: FeatureDisposition = "degraded";
const U: FeatureDisposition = "unsupported";

/**
 * Cross-wire hop dispositions. Same-wire hops are `passthrough` by definition and never listed.
 * Evidence for each current-code claim lives in `devlog/_plan/260924_protocol_first_class/010_contract_and_baseline.md`.
 */
export const FEATURE_HOP_DISPOSITIONS: Readonly<Record<ProtocolFeature, Readonly<Partial<Record<WireHop, FeatureDisposition>>>>> = {
  "request.tools": {
    "chat>responses": T, "responses>chat": T, "messages>responses": T,
    "responses>messages": T, "chat>messages": T, "messages>chat": T,
  },
  "request.hosted_tools": { "responses>chat": D, "responses>messages": D },
  "request.images": {
    "chat>responses": T, "responses>chat": T, "messages>responses": T,
    "responses>messages": T, "chat>messages": T, "messages>chat": T,
  },
  "request.documents": {
    "chat>responses": D, "responses>chat": D, "messages>responses": T,
    "responses>messages": T, "chat>messages": D, "messages>chat": D,
  },
  "request.multiple_choices": { "chat>responses": U, "chat>messages": U },
  "request.logprobs": { "chat>responses": U, "chat>messages": U, "responses>chat": U, "responses>messages": U },
  "request.logit_bias": { "chat>responses": U, "chat>messages": U },
  "request.seed": { "chat>responses": U, "chat>messages": U },
  "request.audio": { "chat>responses": U, "chat>messages": U },
  "request.prediction": { "chat>responses": U, "chat>messages": U },
  "request.response_format": { "chat>responses": T, "responses>chat": T, "chat>messages": T, "responses>messages": T },
  "request.reasoning": {
    "chat>responses": T, "responses>chat": T, "messages>responses": D,
    "responses>messages": T, "chat>messages": T, "messages>chat": D,
  },
  "request.thinking_budget": { "messages>responses": D, "messages>chat": D },
  "request.top_k": { "messages>responses": U, "messages>chat": U },
  "request.cache_control": { "messages>responses": D, "messages>chat": D },
  "request.previous_response_id": { "responses>chat": T, "responses>messages": T },
  "request.store": { "responses>chat": D, "responses>messages": D },
  "request.background": { "responses>chat": U, "responses>messages": U },
  "request.compaction": { "responses>chat": T, "responses>messages": T },
};

const RANK: Readonly<Record<FeatureDisposition, number>> = {
  passthrough: 0,
  translated: 1,
  degraded: 2,
  unsupported: 3,
};

/**
 * Disposition of one feature over one hop between wire nodes. `undefined` means unknown:
 * either end is `other`, or the pair is not declared.
 */
export function featureHopDisposition(
  feature: ProtocolFeature,
  from: UpstreamWire,
  to: UpstreamWire,
): FeatureDisposition | undefined {
  if (from === "other" || to === "other") return undefined;
  if (from === to) return "passthrough";
  return FEATURE_HOP_DISPOSITIONS[feature][`${from}>${to}`];
}

export interface FeatureEffect {
  feature: ProtocolFeature;
  disposition: FeatureDisposition;
}

export interface PathFeatureEffects {
  effects: FeatureEffect[];
  /** Present features with no declared disposition on some hop. */
  unknown: ProtocolFeature[];
  fidelity: Fidelity;
}

/**
 * The worst disposition each present feature meets along a request path. A feature the
 * inbound protocol cannot express is ignored rather than reported.
 */
export function featureEffectsForPath(
  inbound: Protocol,
  path: readonly ProtocolHop[],
  present: Iterable<ProtocolFeature>,
): PathFeatureEffects {
  const nodes = protocolNodes(path);
  const effects: FeatureEffect[] = [];
  const unknown: ProtocolFeature[] = [];
  const seen = new Set<ProtocolFeature>();
  for (const feature of present) {
    if (seen.has(feature) || !FEATURE_SOURCES[feature].includes(inbound)) continue;
    seen.add(feature);
    let worst: FeatureDisposition = "passthrough";
    let unknownHop = false;
    for (let i = 1; i < nodes.length; i++) {
      const hop = featureHopDisposition(feature, nodes[i - 1]!, nodes[i]!);
      if (hop === undefined) unknownHop = true;
      else if (RANK[hop] > RANK[worst]) worst = hop;
    }
    // A loss already declared on a known hop is reported even when a later hop is unknown:
    // an unknown adapter cannot restore what an earlier hop dropped.
    if (unknownHop && RANK[worst] < RANK.degraded) unknown.push(feature);
    else effects.push({ feature, disposition: worst });
  }
  effects.sort((a, b) => PROTOCOL_FEATURES.indexOf(a.feature) - PROTOCOL_FEATURES.indexOf(b.feature));
  unknown.sort((a, b) => PROTOCOL_FEATURES.indexOf(a) - PROTOCOL_FEATURES.indexOf(b));
  const degraded = effects.some(effect => RANK[effect.disposition] >= RANK.degraded);
  return {
    effects,
    unknown,
    fidelity: degraded ? "degraded" : unknown.length > 0 ? "unknown" : "preserved",
  };
}

/** Features that would be refused under `reject-unrepresentable`. */
export function unrepresentableFeatures(effects: readonly FeatureEffect[]): ProtocolFeature[] {
  return effects.filter(effect => effect.disposition === "unsupported").map(effect => effect.feature);
}

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

const HOSTED_TOOL_TYPES = new Set([
  "web_search", "web_search_preview", "image_generation", "file_search",
  "code_interpreter", "computer_use_preview", "mcp", "local_shell",
]);

function hasPartType(messages: unknown, types: ReadonlySet<string>): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isRec(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isRec(part) && typeof part.type === "string" && types.has(part.type)) return true;
      if (isRec(part) && Array.isArray(part.content) && hasPartType([part], types)) return true;
    }
  }
  return false;
}

const CHAT_IMAGE_PARTS = new Set(["image_url", "input_image", "image"]);
const CHAT_FILE_PARTS = new Set(["file", "input_file"]);
const MESSAGES_IMAGE_PARTS = new Set(["image"]);
const MESSAGES_DOCUMENT_PARTS = new Set(["document"]);
const RESPONSES_IMAGE_PARTS = new Set(["input_image"]);
const RESPONSES_FILE_PARTS = new Set(["input_file"]);

function hasCacheControl(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) return value.some(item => hasCacheControl(item, depth + 1));
  if (!isRec(value)) return false;
  if (value.cache_control !== undefined) return true;
  return hasCacheControl(value.content, depth + 1);
}

/**
 * Features present in a Chat Completions body. Reads only structure; never retains content.
 * Bounded: nested content is inspected two levels deep at most.
 */
export function featuresFromChatBody(body: unknown): Set<ProtocolFeature> {
  const out = new Set<ProtocolFeature>();
  if (!isRec(body)) return out;
  if (nonEmptyArray(body.tools) || nonEmptyArray(body.functions)) out.add("request.tools");
  if (hasPartType(body.messages, CHAT_IMAGE_PARTS)) out.add("request.images");
  if (hasPartType(body.messages, CHAT_FILE_PARTS)) out.add("request.documents");
  if (typeof body.n === "number" && body.n > 1) out.add("request.multiple_choices");
  if (body.logprobs === true || typeof body.top_logprobs === "number") out.add("request.logprobs");
  if (isRec(body.logit_bias) && Object.keys(body.logit_bias).length > 0) out.add("request.logit_bias");
  if (typeof body.seed === "number") out.add("request.seed");
  if (body.audio !== undefined || (Array.isArray(body.modalities) && body.modalities.includes("audio"))) out.add("request.audio");
  if (body.prediction !== undefined) out.add("request.prediction");
  if (isRec(body.response_format) && body.response_format.type !== "text") out.add("request.response_format");
  if (typeof body.reasoning_effort === "string" || isRec(body.reasoning)) out.add("request.reasoning");
  return out;
}

/** Features present in an Anthropic Messages body. */
export function featuresFromMessagesBody(body: unknown): Set<ProtocolFeature> {
  const out = new Set<ProtocolFeature>();
  if (!isRec(body)) return out;
  if (nonEmptyArray(body.tools)) out.add("request.tools");
  if (hasPartType(body.messages, MESSAGES_IMAGE_PARTS)) out.add("request.images");
  if (hasPartType(body.messages, MESSAGES_DOCUMENT_PARTS)) out.add("request.documents");
  if (isRec(body.thinking) || isRec(body.output_config)) out.add("request.reasoning");
  if (isRec(body.thinking) && typeof body.thinking.budget_tokens === "number") out.add("request.thinking_budget");
  if (typeof body.top_k === "number") out.add("request.top_k");
  if (hasCacheControl(body.system) || hasCacheControl(body.messages) || hasCacheControl(body.tools)) {
    out.add("request.cache_control");
  }
  return out;
}

/** Features present in a Responses body. */
export function featuresFromResponsesBody(body: unknown): Set<ProtocolFeature> {
  const out = new Set<ProtocolFeature>();
  if (!isRec(body)) return out;
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRec(tool) || typeof tool.type !== "string") continue;
      if (HOSTED_TOOL_TYPES.has(tool.type)) out.add("request.hosted_tools");
      else out.add("request.tools");
    }
  }
  if (hasPartType(body.input, RESPONSES_IMAGE_PARTS)) out.add("request.images");
  if (hasPartType(body.input, RESPONSES_FILE_PARTS)) out.add("request.documents");
  if (typeof body.top_logprobs === "number"
    || (Array.isArray(body.include) && body.include.includes("message.output_text.logprobs"))) {
    out.add("request.logprobs");
  }
  if (isRec(body.text) && isRec(body.text.format) && body.text.format.type !== "text") out.add("request.response_format");
  if (isRec(body.reasoning)) out.add("request.reasoning");
  if (typeof body.previous_response_id === "string" && body.previous_response_id.length > 0) out.add("request.previous_response_id");
  if (body.store === true) out.add("request.store");
  if (body.background === true) out.add("request.background");
  if (body.compaction_trigger !== undefined) out.add("request.compaction");
  return out;
}

export function featuresFromBody(protocol: Protocol, body: unknown): Set<ProtocolFeature> {
  if (protocol === "chat") return featuresFromChatBody(body);
  if (protocol === "messages") return featuresFromMessagesBody(body);
  return featuresFromResponsesBody(body);
}
