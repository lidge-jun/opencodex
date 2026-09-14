# Residuals

Work this unit deliberately does not do, with the reason and what would be needed.
Recorded so the PRs can point at it instead of implying coverage they do not have.

## R1 — opaque reasoning replay across a Chat boundary (from F6)

Phase 2 carries assistant reasoning **plaintext** into the Responses projection. It
does not carry a thinking signature, an `encrypted_content` blob, or any
provider-issued item id.

A signature is an attestation the issuing provider computed over content this proxy
never received. Synthesizing one is either rejected upstream or, worse, accepted as
a false provenance claim. Cross-provider opaque metadata has the same problem in
the other direction: the blob is only meaningful to its issuer.

Doing this properly needs a per-provider decision about which opaque fields are
round-trippable, a scope key so a blob from provider A is never replayed to
provider B, and a cache lifetime. `src/responses/reasoning-replay-cache.ts`
already solves a narrower version of this inside one provider's session and is the
natural starting point. It is a design unit, not a line change.

## R2 — native audio/file transport (from F5)

Layer 4 added presence markers but could still report successful translation after losing
an attachment. Layer 5 closes that silent-success gap: registered translated adapters inspect
the original content before dispatch, and Chat projection rejects recognized audio/file parts
before losing them. Build, stateful runTurn and local-completion hooks share that contract;
native Responses/Azure and native Chat retain their existing wire behavior. See the
[current registry contract](../../../structure/adapters/registry.md#untranslated-input-media).

**Native audio/file transport through the normalized IR remains unimplemented.** This stack
does not add a carrier type, per-model capability data, file-ID resolution, URL fetching or
new upstream mappings. Unsupported translation now fails explicitly rather than pretending
to consume an attachment. A filename/audio marker alone is still not the attachment.

## R3 — Kiro remote images stay uninlined

Phase 4 makes the loss visible. It does not make the image arrive. Kiro's wire takes
base64 bytes only, and fetching a remote reference server-side is explicitly out of
scope for this unit: it would add an outbound request on a request path, with the
SSRF surface and the credential-bearing-URL handling that implies.

## R4 — Vertex `responseJsonSchema` support is not locally gated

Phase 3 sends the field on AI Studio and Vertex and refuses on Cloud Code Assist.
There is no local capability table asserting which Vertex model versions accept it,
so a model that rejects it produces an upstream error rather than a local refusal.
Inventing that table without evidence would be a guess with a worse failure mode
than the upstream's own message.

## R5 — findings owned elsewhere

- **F10** (native describer ignores operator `modelCapabilities` text-only) is
  `#4501` / PR `#4511`. Not duplicated here.
- **`#4505`** gateway modality metadata: the audit found a display/policy
  inconsistency, which is not evidence about that gateway's native vision behavior.
  Changing it needs real evidence first.
- **Cursor** native/external image path differences were not confirmed as a real
  loss, so there is nothing to fix yet.
