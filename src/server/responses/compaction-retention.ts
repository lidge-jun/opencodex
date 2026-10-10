import { rmSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../config";
import type { OcxConfig, OcxParsedRequest } from "../../types";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { parseRequest } from "../../responses/parser";
import { applyReasoningRetention, appendRetentionNotice } from "../../responses/reasoning-retention";
import { encodeRetainedCompaction } from "../../responses/retained-compaction";
import { finalizeAccountLease } from "./core-lifetime";

export class InvalidRetainedCompactionSummary extends Error {}

/** One routed v2 attempt owns its local retention until its response ends or is cancelled. */
export function prepareCompactionRetention(
  parsed: OcxParsedRequest,
  config: OcxConfig,
  contextWindow: number | undefined,
  budget: TranslatorBudget,
  signal: AbortSignal,
) {
  const raw = parsed._rawBody as Record<string, unknown>;
  const retention = applyReasoningRetention(raw.input, {
    archiveDir: join(getConfigDir(), "reasoning-archive"), contextWindow,
    ...config.reasoningRetention,
  });
  if (!retention.retainedReasoning && !retention.archived) return undefined;
  let committed = false;
  let disposed = false;
  let bytes = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    delete parsed._compactionRetention;
    budget.releaseRetained(bytes, { kind: "retained_collectors" });
    if (!committed && retention.archived) rmSync(retention.archived.path, { force: true });
  };
  try {
    const reasoning = retention.retainedReasoning?.map(item => item.content[0]!.text) ?? [];
    const retainedBytes = Buffer.byteLength(JSON.stringify(reasoning));
    budget.chargeRetained(retainedBytes, { kind: "retained_collectors" });
    bytes = retainedBytes;
    const body = { ...raw, model: parsed.modelId, input: retention.input };
    const messages = parseRequest(body, { replayCacheScope: parsed._reasoningReplayScope }).context.messages;
    parsed._rawBody = body;
    parsed.context.messages = messages;
    const callbacks: NonNullable<OcxParsedRequest["_compactionRetention"]> = {
      encode(summary) {
        if (disposed || signal.aborted) throw new Error("Compaction was cancelled");
        if (!summary.trim()) throw new InvalidRetainedCompactionSummary("Compaction returned an empty summary");
        return encodeRetainedCompaction(appendRetentionNotice(summary, retention.archived), reasoning);
      },
      commit() { if (!disposed && !signal.aborted) committed = true; },
    };
    Object.defineProperty(parsed, "_compactionRetention", { value: callbacks, configurable: true });
    if (signal.aborted) { dispose(); throw signal.reason; }
    signal.addEventListener("abort", dispose, { once: true });
    return { dispose, deliver: (response: Response) => finalizeAccountLease(response, dispose, dispose) };
  } catch (error) { dispose(); throw error; }
}
