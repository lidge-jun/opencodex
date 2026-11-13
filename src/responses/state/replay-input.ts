import type { ResidentResponseState } from "../state";
import { clientCarriedPrefixLength, providerIssuedIdentity } from "./replay-fingerprint";
import { allowsUnforcedStoreFalseReplay } from "./unforced-store-false";

export function expandStoredResponseInput(request: Record<string, unknown>, input: unknown[], state: ResidentResponseState): {
  body: Record<string, unknown>; prefixLength: number; overlap: boolean;
} {
  const clientInput = input;
  const stored = state.items;
  const carried = clientCarriedPrefixLength(stored, clientInput);
  if (
    state.unforcedStoreFalse
    && !allowsUnforcedStoreFalseReplay(stored, state.providerOutputStart, clientInput, carried)
  ) {
    return { body: request, prefixLength: 0, overlap: false };
  }
  // The client already replayed this history verbatim. Prepending the stored copy would
  // double it, and the doubled turn is stored again, so the next turn triples (#1412 saw
  // 127k of real context reach 1.3M tokens this way).
  //
  // Three conditions, all required. The run must cover the whole stored entry; it must reach
  // the provider-output region; and some matched item in that region must carry a
  // provider-issued id. The last one is the load-bearing part: content equality alone proves
  // two items look alike, not that they are the same occurrence, so a client that merely
  // repeats its own message would otherwise authorize a skip that deletes real history.
  // There is no invariant that provider output always carries ids, so an entry whose output
  // has none simply never skips.
  {
    const anchor = state.providerOutputStart;
    if (
      carried === stored.length
      && anchor !== undefined
      && carried > anchor
      && stored.slice(anchor, carried).some(item => providerIssuedIdentity(item) !== null)
    ) {
      // Keep previous_response_id: Kiro and Cursor recover their conversation ids from it
      // (kiro-wire.ts, cursor/request-builder.ts). Only the concatenation is skipped.
      const unchanged = { ...request };
      // Same provenance boundary a real expansion would record, so the replayed prefix does
      // not re-acknowledge historical compaction markers (parser.ts) and stays visible to
      // guidance de-duplication (collaboration.ts).
      return { body: unchanged, prefixLength: carried, overlap: true };
    }
  }
  const expanded = {
    ...request,
    input: [...stored, ...clientInput],
  };
  return { body: expanded, prefixLength: stored.length, overlap: false };
}
