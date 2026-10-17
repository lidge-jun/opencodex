import { createHash } from "node:crypto";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { AdapterRequest } from "./base";
import type { OcxParsedRequest } from "../types";

type Block = Record<string, unknown>;
type Policy = { mode: "blanket" } | { mode: "selective"; fingerprints: ReadonlySet<string> };
const requests = new WeakMap<AdapterRequest, ReadonlySet<string>>();
const responses = new WeakMap<Response, ReadonlySet<string>>();
const policies = new WeakMap<object, Policy>();
const owner = (parsed: OcxParsedRequest) => parsed._reasoningReplayScope ?? parsed;
/** Domain-separated opaque bytes, deliberately independent of plaintext and untrusted hints. */
export function anthropicOpaqueFingerprint(block: Block): string | undefined {
  const value = block.type === "thinking" ? block.signature : block.type === "redacted_thinking" ? block.data : undefined;
  if (typeof value !== "string" || value.length === 0) return;
  return createHash("sha256").update(String(block.type)).update("\0").update(value).digest("hex");
}
export function captureAnthropicRejectionPayloads(request: AdapterRequest, body: Block, budget?: TranslatorBudget): void {
  requests.delete(request);
  if (!budget || !Array.isArray(body.messages)) return;
  let retained = 0;
  let complete = false;
  const fingerprints = new Set<string>();
  try {
  for (const message of body.messages) {
    if (!message || typeof message !== "object") return;
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!block || typeof block !== "object") return;
      if (block.type !== "thinking" && block.type !== "redacted_thinking") continue;
      const value = block.type === "thinking" ? block.signature : block.data;
      if (typeof value !== "string" || value.length === 0) return;
      const temporary = budget.reserveTransient(Buffer.byteLength(value) * 2, { kind: "reasoning" });
      let fingerprint: string | undefined;
      try { fingerprint = anthropicOpaqueFingerprint(block); } finally { temporary.release(); }
      if (!fingerprint) return;
      if (!fingerprints.has(fingerprint)) {
        if (fingerprints.size >= 256) return;
        // Includes Set/hex storage and later defensive copies; owned until turn disposal.
        budget.chargeRetained(256, { kind: "reasoning" }); retained += 256;
        fingerprints.add(fingerprint);
      }
    }
  }
  if (fingerprints.size) { requests.set(request, fingerprints); complete = true; }
  } catch { /* An uncollectable set keeps the legacy blanket policy. */ }
  finally { if (!complete) budget.releaseRetained(retained, { kind: "reasoning" }); }
}
export function bindAnthropicRejectionResponse(request: AdapterRequest | undefined, response: Response): void {
  const fingerprints = request && requests.get(request);
  if (fingerprints) responses.set(response, fingerprints); else responses.delete(response);
}
export function rejectedAnthropicPayloads(response: Response | undefined): ReadonlySet<string> | undefined {
  const value = response && responses.get(response);
  return value && new Set(value);
}
export function bindAnthropicRejectionPolicy(parsed: OcxParsedRequest, policy: Policy | undefined): void {
  if (policy) policies.set(owner(parsed), policy); else policies.delete(owner(parsed));
}
export function anthropicRejectionPolicy(parsed: OcxParsedRequest): Policy | undefined { return policies.get(owner(parsed)); }

/** Filter only refused opaque bytes; newly issued thinking in this request remains replayable. */
export function keepAnthropicReplayBlock(parsed: OcxParsedRequest, block: Block): boolean {
  const fingerprint = anthropicOpaqueFingerprint(block);
  if (!fingerprint) return true;
  if (parsed._stripReasoningEncryptedContent === true) return false;
  const policy = anthropicRejectionPolicy(parsed);
  return policy ? policy.mode === "selective" && !policy.fingerprints.has(fingerprint)
    : true;
}
