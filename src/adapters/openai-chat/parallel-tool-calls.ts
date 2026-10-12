import type { OcxProviderConfig } from "../../types";

/**
 * The `parallel_tool_calls` value for a translated Chat request, or `undefined` to omit the key.
 *
 * A provider has three states here, not two, and the third is the default for every provider that
 * never configured the knob. While the call site only branched on the two configured states, a
 * caller's own explicit `parallel_tool_calls: false` reached the parser, was carried on
 * `options.parallelToolCalls`, and was then dropped on the way to the wire — the upstream stayed
 * free to emit concurrent calls and the response looked entirely normal (#5211).
 *
 * Only an explicit request-side `false` is forwarded in the unset state. `true` is already the
 * upstream default, so emitting it would introduce the knob to strict OpenAI-compatible hosts
 * that have never had to accept it, which is the reason the configured opt-out below omits the
 * key rather than sending `false`.
 */
export function chatParallelToolCallsWireValue(
  provider: OcxProviderConfig,
  requested: boolean | undefined,
): boolean | undefined {
  if (provider.parallelToolCalls === false) {
    // NIM documents the Boolean defaulting to false and kimi rejects true; pin the wire bit so
    // Codex cannot opt in via request.options. Other opted-out providers omit the field, but a
    // self-hosted gateway that DOES honor it and keeps emitting parallel calls without it can opt
    // in via pinParallelToolCallsFalse.
    const pinned = provider.baseUrl === "https://integrate.api.nvidia.com/v1"
      || provider.pinParallelToolCallsFalse === true;
    return pinned ? false : undefined;
  }
  if (provider.parallelToolCalls === true) return requested !== false;
  return requested === false ? false : undefined;
}
