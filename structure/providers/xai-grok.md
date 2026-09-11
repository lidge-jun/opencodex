# xAI Grok Provider

## xAI Grok hardening (official Grok Build contract parity)

Grounded in the open-sourced official client (xai-org/grok-build); unit + evidence:
`devlog/_fin/260716_grok_build_hardening/`.

- **Reasoning folding:** the Responses parser folds `reasoning` items into the FOLLOWING
  assistant turn (`pendingReasoning` in `src/responses/parser.ts`) so the Grok chat wire carries
  ONE assistant message with `reasoning_content` — exact-prefix cache stability. Unsigned
  siblings newline-join; `ocxr1`-signed siblings stay separate parts (Anthropic replay keeps
  each signature on its own text); boundaries (user/tool-result/agent) clear pending state;
  call items fold pending reasoning into the same turn.
- **Grok CLI credential ownership:** `source:"local-cli"` xAI credentials re-read
  `~/.grok/auth.json` (read-only) before any refresh and adopt a newer usable generation with
  zero IdP calls (`shouldAdoptGrokGeneration`, later-expiresAt authority); an IdP refresh
  detaches the credential to `source:"oauth"`.
- **Two-lock refresh transaction:** per-provider+account intent lock held across the IdP
  exchange plus a short global store-write lock + async mutation funnel around every
  `auth.json` load-merge-persist (`src/oauth/store.ts`); generation-guarded persist
  (`expectedGeneration` → superseded adoption), conditional `needsReauth`, bounded jittered
  retry for transient token-endpoint failures.
- **Reactive 401 replay:** both the adapter recovery loop and native Responses passthrough branch
  force-refresh once (singleflight, generation-checked) and replay OAuth-backed xAI requests
  exactly once with a re-resolved transport; API-key/BYOK paths are excluded
  (`src/server/responses/core.ts`).
- **Header parity:** per-attempt `x-grok-req-id` (fresh UUID inside the transport fetch
  wrapper), stable session/conv affinity headers, always-set User-Agent, and a single
  compatibility profile const for the Grok client version (`src/providers/xai-transport.ts`);
  `fetchWithHeaderTimeout` takes an executor so provider fetch wrappers stay inside the
  timeout race.

The generated Grok client marker also enables a client-facing sparse-terminal repair for native
Responses streams. Grok Build renders text deltas immediately but derives its durable assistant
turn from `response.completed.response.output`; an OpenAI-compatible stream may instead place the
complete items in `response.output_item.done` and finish with an explicit empty output array. For
that marked client only, OpenCodex uses a terminal-only tracker: it retains bounded, contiguous,
unique and semantically valid raw completed items, then backfills a missing or empty terminal
snapshot. It never promotes locally synthesized or merely repaired items. Unmarked callers continue
to treat an explicit empty array as authoritative. Within this marked client-facing repair,
malformed, gapped, oversized, contradictory, failed, or incomplete streams stay fail-closed.

> Decision record: [ADR-0059](../decisions/ADR-0059-xai-grok-hardening-official-grok-build-contract.md)
