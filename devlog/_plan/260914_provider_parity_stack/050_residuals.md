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

## R2 — real audio/file transport, and any adapter-level refusal (from F5)

**F5 is PRESENCE-ONLY and is not fixed.** Phase 4 records that an audio attachment
existed and explicitly does not add audio support. `OcxContentPart` has no audio
member, no adapter consumes one, and per-provider audio capability is not recorded
anywhere in the catalog — `src/providers/registry.ts:1062` notes exactly this when it
omits audio from the Baseten hints.

Two things are residual, not delivered:

- **Transport.** A carrier type, capability data across the provider set, and a wire
  mapping per vendor. Guessing any one of those produces a request that fails at call
  time instead of a modality that works.
- **Refusal.** There is no adapter-level rejection of audio. By final dispatch the part
  is already a text marker, so every adapter continues. Doing this properly needs a
  typed unsupported-modality signal that survives to final adapter dispatch — including
  `runTurn`, compaction and sidecar paths — while raw Responses passthrough stays
  untouched. An early throw in the shared parser is not acceptable: raw passthrough
  runs through `parseRequest` before the adapter forwards `_rawBody`.

`input_file` keeps its existing filename-only marker, and Chat inbound has no file or
audio translation at all, so a Chat request can lose media before the Responses parser
sees it. Neither is addressed here.

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
