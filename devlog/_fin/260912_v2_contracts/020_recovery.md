# Encrypted envelope recovery

Class C4 authenticated plaintext boundary; consumes roadmap and independent envelope design. #3794 diagnostics and MESSAGE support are already present. This phase preserves them and never adds automatic outage retries.

| Action | Path | Before → after |
|---|---|---|
| MODIFY | `src/server/responses/agent-task-recovery.ts` | single encryptedIndex/ciphertext → ordered bounded part descriptors and exact envelope snapshot; single backend recovery request; atomic input revalidation before replacement |
| MODIFY | `tests/server/agent-task-recovery.test.ts` | single-part coverage → ordered multipart, invalid/ambiguous fragments, size/count cap, input mutation and cache isolation cases |
| MODIFY | `docs-site/src/content/docs/reference/configuration/agents.md` | narrow recovery description → exact supported multipart shape, no blind retries and residual fragment limitations |
| MODIFY | relevant `structure/` owners | current single-part invariant → canonical bounded envelope contract |

D5 proposal for design audit: accept a contiguous run of complete structurally valid Fernet strings, at most 32 parts and 2 MiB combined. Keep routing header singular and author/recipient equal to sender/task. Forward original complete token parts in their order to the same fixed backend endpoint once. Partial token strings remain unsupported unless source evidence establishes an unambiguous join contract; do not infer authentication from a plausible Fernet shape.

`AgentEnvelope` replaces encryptedIndex with an ordered part list. The cache key hashes a length-delimited serialized token array (not ambiguous string concatenation). `recoveryPayload` maps these parts into its one input message. `injectAssignment` reruns envelope parsing and compares the full admitted snapshot (header, identities, positions, all ciphertext parts) before one content splice, then removes agent routing identity fields exactly as today. Existing admission is still before every cache read. Input mutation causes input_changed and cache discard.

Creation → serialization → consumption: parser builds ordered part descriptors; recoveryPayload emits each validated whole part; cache key binds their order and boundaries; injection validates the original current input and writes one assignment. No new stored config or failure enum is needed; unsupported_envelope remains not attempted and existing typed request failures remain attempted/capacity outcomes.

Activation matrix: one complete part unchanged; two complete ordered parts reach exactly one mocked backend call and one plaintext replacement; swapped tokens have distinct cache identity; wrong sender/recipient/header rejected without fetch; interleaved plaintext/noncontiguous encrypted parts rejected; empty, malformed, excessive count or total bytes rejected; delayed input mutation refuses assignment; HTTP 5xx yields the existing typed reason after one call; no retry budget increase. Reuse existing helper fixtures; no test execution locally.

Fragment disposition: this unit does not concatenate split tokens. #3661 contains no fragment association or representation evidence. The runtime's existing plaintext-in-encrypted-slot compatibility must remain. Add end-to-end regression coverage for a consecutive encrypted run whose exact concatenation is structurally one Fernet token: classify that narrowly as unreadable and refuse without recovery, while ordinary plaintext slots still normalize. If no sound discriminator is found, retain the issue residual explicitly; never claim full #3661 closure from whole-token support.


Concrete replacement contract:

```ts
// AgentEnvelope
// - encryptedIndex: number; ciphertext: string;
// + encryptedStartIndex: number; ciphertexts: readonly string[];
// + inputSnapshot: string;
// Parser: collect {index, token} only when token list has exactly one member
// and that member === raw encrypted_content. Reject missing header,
// >32 entries, >2 MiB aggregate, and nonconsecutive indexes. Capture
// JSON.stringify(item) at admission after all identity checks.
// Cache replaces .update(envelope.ciphertext) with
.update(JSON.stringify(envelope.ciphertexts))
// Fixed recovery endpoint content replaces its single encrypted part with
...envelope.ciphertexts.map(encrypted_content => ({
  type: "encrypted_content", encrypted_content,
}))
// Injection verifies original item bytes before touching content:
if (JSON.stringify(item) !== envelope.inputSnapshot) return false;
content.splice(envelope.encryptedStartIndex, envelope.ciphertexts.length,
  { type: "input_text", text: assignment });
```

The snapshot is request-local and not logged/persisted. JSON request parsing is the input boundary, so getters/cycles are not supported client states. Tests use the existing Request/recovery public entrypoints, not exported parser internals.

Reflection amendment: also MODIFY `src/server/responses/encrypted-payload.ts` only for the narrow multi-slot discriminator and MODIFY `tests/server/agent-task-recovery.test.ts` with `post()` integration assertions that recovery is not attempted and routed fetch is absent. Whole-token recovery tests remain at the recovery API. The discriminator runs before sanitization; for otherwise unreadable envelopes, matched fragments do not reach the routed provider. General malformed payload detection remains outside this claim.

wp2 reflection synthesis: preserve only identified fragment objects during sanitization, not an entire content array. Independent plaintext slots still normalize. Fragment refusal applies only when no independent readable task text remains, retaining current mixed-content policy; mixed input is explicitly outside the refusal claim. All encrypted slots in a recovery envelope must be valid consecutive whole tokens, including malformed non-string slots (which refuse). MODIFY `tests/server/agent-task-recovery-security.test.ts`: replace formerly unsupported duplicate-whole-token fixture with a genuinely noncontiguous encrypted run; keep fragment and admission-negative coverage, add positive multipart regression separately.
