import type { OcxProviderConfig } from "../../types";

/**
 * Full provider forms omit these fields. Read them from the live row at publication time, after any
 * concurrent operator edit, so a form save neither erases nor resurrects them. A cleared policy or
 * inference opt-in stays cleared; a stored credit price, including 0, survives.
 */
export function preserveOmittedLiveProviderFields(
  candidate: OcxProviderConfig,
  submitted: object,
  live: OcxProviderConfig | undefined,
): void {
  if (!Object.hasOwn(submitted, "accountAutoPause")) {
    const livePolicy = live?.accountAutoPause;
    if (livePolicy === undefined) delete candidate.accountAutoPause;
    else candidate.accountAutoPause = structuredClone(livePolicy);
  }
  if (!Object.hasOwn(submitted, "inferContextWindow")) {
    const liveInference = live?.inferContextWindow;
    if (liveInference === undefined) delete candidate.inferContextWindow;
    else candidate.inferContextWindow = liveInference;
  }
  const livePrice = live?.creditPriceUsd;
  if (!Object.hasOwn(submitted, "creditPriceUsd") && livePrice !== undefined) candidate.creditPriceUsd = livePrice;
}
