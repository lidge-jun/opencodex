import type { OcxContext, OcxMessage, OcxParsedRequest, OcxProviderContinuationOwner } from "../../types";
import type { ProviderAdapter, IncomingMeta } from "../../adapters/base";
import { AnthropicImageOverflow } from "../../adapters/anthropic-image-guard";
import { sameProviderContinuationOwner } from "../../responses/provider-continuation";
import { previousResponseProviderState, rememberResponseState } from "../../responses/state";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../../responses/compaction";

export interface ImageSummaryContext {
  messages: OcxMessage[];
  tools: OcxContext["tools"];
  systemPrompt: OcxContext["systemPrompt"];
  owner: OcxProviderContinuationOwner;
}

export class ImageContextError extends Error {
  constructor(message: string, readonly status = 413) { super(message); }
}

const pending = new Map<string, Promise<void>>();
const summaryMessage = (summary: string): OcxMessage => ({ role: "user", timestamp: 0, content: `${SUMMARY_PREFIX}\n\n${summary}` });
const summaryInstruction = (): OcxMessage => ({ role: "user", timestamp: 0,
  content: `${COMPACT_PROMPT}\n\nReturn only the handoff summary. Do not call tools or continue the task.` });
const messageKey = ({ timestamp: _timestamp, ...message }: OcxMessage): string => JSON.stringify(message);

function prefixDigest(messages: OcxMessage[], end: number): string {
  const digest = new Bun.CryptoHasher("sha256");
  for (let i = 0; i < end; i++) digest.update(messageKey(messages[i])).update("\n");
  return digest.digest("hex");
}

function completeBoundaries(messages: OcxMessage[]): number[] {
  const cuts = [0];
  const calls = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!calls.size && i > 0 && message.role !== "toolResult") cuts.push(i);
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") calls.add(part.id);
    } else if (message.role === "toolResult") calls.delete(message.toolCallId);
  }
  return cuts;
}

/** 检查点复用已有有界续接存储；仅在触顶时压缩完整的旧历史单元。 */
export async function prepareAnthropicImageContext(input: {
  parsed: OcxParsedRequest;
  adapter: ProviderAdapter;
  incoming: IncomingMeta;
  upstreamRejected?: boolean;
  summarize(context: ImageSummaryContext): Promise<string>;
}): Promise<void> {
  const { parsed, adapter, incoming, summarize } = input;
  if (adapter.name !== "anthropic") return;
  if (!parsed.context.messages.some(message => Array.isArray(message.content)
    && message.content.some(part => part.type === "image"))) return;
  const signal = incoming.abortSignal;
  const checkAbort = () => { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); };
  const fits = async (messages: OcxMessage[], summary: boolean): Promise<boolean> => {
    checkAbort();
    const trial = { ...parsed, options: { ...parsed.options }, context: { ...parsed.context,
      messages: summary ? [...messages, summaryInstruction()] : messages } };
    if (summary) delete trial.options.textFormat;
    try {
      const built = await adapter.buildRequest(trial, incoming);
      built.releaseBodyObservation?.();
      return true;
    } catch (error) {
      if (error instanceof AnthropicImageOverflow) return false;
      throw error;
    }
  };
  const owner = parsed._providerContinuationOwner;
  const thread = parsed._codexOwnThreadId;
  const principal = parsed._reasoningReplayScope?.clientPrincipalId;
  const key = thread && owner ? `ocx-image:${principal ?? "local"}:${thread}` : undefined;
  const before = key ? pending.get(key) : undefined;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const queued = (before ?? Promise.resolve()).then(() => held);
  if (key) pending.set(key, queued);
  try {
    if (before) await before;
    checkAbort();
    const original = parsed.context.messages;
    const stored = key ? previousResponseProviderState(key) : undefined;
    const saved = stored?.anthropicImages;
    let covered = 0;
    let summary: string | undefined;
    if (owner && stored?.__ocxOwner && sameProviderContinuationOwner(owner, stored.__ocxOwner) && saved
      && Number.isSafeInteger(saved.covered) && Number(saved.covered) > 0 && Number(saved.covered) <= original.length
      && saved.prefixDigest === prefixDigest(original, Number(saved.covered))
      && typeof saved.summary === "string" && saved.summary.trim()) {
      covered = Number(saved.covered);
      summary = saved.summary;
    }
    const effective = (end = original.length) => [
      ...(summary ? [summaryMessage(summary)] : []), ...original.slice(covered, end),
    ];
    const cuts = completeBoundaries(original);
    const retainFrom = cuts.at(-1) ?? 0;
    let rejected = input.upstreamRejected === true && original.slice(covered, retainFrom).some(message =>
      Array.isArray(message.content) && message.content.some(part => part.type === "image"));
    while (rejected || !await fits(effective(), false)) {
      if (!owner || !key) throw new ImageContextError("Image context cannot be compacted without a verified conversation and serving identity.");
      const candidates = cuts.filter(end => end > covered && end <= retainFrom);
      let lo = 0, hi = candidates.length - 1, end = covered;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (await fits(effective(candidates[mid]), true)) { end = candidates[mid]; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (end === covered) throw new ImageContextError("The newest image or indivisible input exceeds the request limit; old-context compaction cannot make it fit.");
      const next = await summarize({ messages: effective(end), tools: parsed.context.tools,
        systemPrompt: parsed.context.systemPrompt, owner });
      checkAbort();
      if (!next.trim() || !parsed._providerContinuationOwner
        || !sameProviderContinuationOwner(owner, parsed._providerContinuationOwner)) {
        throw new ImageContextError("Image compaction did not produce a valid summary for the current serving account.", 502);
      }
      summary = next;
      covered = end;
      rejected = false;
      rememberResponseState({ input: [], store: false }, { id: key, output: [], status: "completed" }, {
        __ocxOwner: owner, anthropicImages: { covered, prefixDigest: prefixDigest(original, covered), summary },
      }, { force: true, clientThreadId: thread });
      const retained = previousResponseProviderState(key)?.anthropicImages;
      if (!retained || retained.summary !== summary || retained.covered !== covered) {
        throw new ImageContextError("Image compaction checkpoint could not be retained; refusing repeated summary charges.", 503);
      }
    }
    if (summary && owner) {
      parsed.context.messages = effective();
      parsed._anthropicImageOwner = { ...owner };
    }
  } finally {
    release();
    if (key && pending.get(key) === queued) pending.delete(key);
  }
}
