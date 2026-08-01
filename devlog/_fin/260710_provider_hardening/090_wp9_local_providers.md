# 090 - WP9: local/self-hosted providers

Providers: ollama, ollama-cloud, vllm, lm-studio, litellm.

## P - Plan

### Verified current behavior

- `routedProviderConfig()` replaces every non-template registry provider's saved
  `baseUrl` with the registry URL. For local/self-hosted entries this silently
  discards a user-selected host, port, container hostname, or remote LAN URL.
- Template providers already preserve a resolved user URL. Remote fixed-endpoint
  providers intentionally remain registry-authoritative.
- LiteLLM optional-key handling already landed in WP6 (`keyOptional: true`) and
  is verification-only here.
- All five providers use the already-hardened `openai-chat` adapter surface.

### Build scope

1. Add registry-only `allowBaseUrlOverride?: boolean` metadata. Set it only for
   `ollama`, `vllm`, `lm-studio`, and `litellm`.
2. In `routedProviderConfig()`, honor a nonblank, resolved saved `baseUrl` when
   either the registry URL is a template or the entry explicitly opts in.
   Trim accepted overrides. For an opted-in local/self-hosted entry, reject a
   blank or unresolved placeholder URL loudly instead of substituting localhost.
   Every fixed remote provider, including `ollama-cloud`, remains
   registry-authoritative.
3. Add activation tests proving the exact four-entry opt-in set; per-provider
   custom host/port, trimming, registry-default, blank/whitespace-only rejection,
   and invalid placeholder rejection; remote fixed-endpoint authority; and
   unchanged Azure/Cloudflare template behavior. Use table-driven assertions so
   every invalid-input branch is exercised for all four opted-in providers.
4. Replace only the three Ollama Cloud bare IDs proven absent from the complete
   live catalog: `qwen3-coder` -> `qwen3-coder:480b`, `qwen3.5` ->
   `qwen3.5:397b`, and `gemma4` -> `gemma4:31b`. The tagged IDs are present in
   the official `https://ollama.com/api/tags` response; the official Cloud docs
   also record `qwen3-coder:480b` retirement on 2026-07-15. Evidence:
   `.codexclaw/evidence/260710_wp9_ollama_cloud_model_ids.md`. No inferred
   aliases or unrelated model changes.
5. Verify LiteLLM's optional-key contract and all five provider outcomes. Do not
   add retries, endpoint substitution, silent degradation, or other fallbacks.

### Intended files

- `src/providers/registry.ts`
- `src/router.ts`
- `tests/router-template-baseurl.test.ts`
- `tests/provider-registry-parity.test.ts` only if a registry/model assertion is
  needed

### Acceptance evidence

- Focused activation tests pass.
- `bun x tsc --noEmit` exits 0.
- `bun test ./tests/` exits 0.
- Final diff audit confirms no new fallback branch and model-data changes, if
  any, map directly to opened Tier-2 evidence.

## LOOP-PESSIMIST

- Primary hypothesis: treating all registry URLs as immutable breaks normal
  local deployment topologies while appearing configured correctly.
- Collapse condition: if another routing/config layer already canonicalizes
  local URLs safely, this phase becomes NOOP rather than adding a second path.
- Watch item: the opt-in must never spread to remote providers; especially,
  `ollama-cloud` must keep `https://ollama.com/v1` authoritative.
- Audit amendment: no opt-in entry may turn a malformed saved address into a
  localhost request. Invalid values are configuration errors, not fallback
  opportunities.
