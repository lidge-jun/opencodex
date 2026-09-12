# ADR-0043 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Give OpenCode Go the stable per-conversation header it requires for prompt-cache routing without exposing raw Codex identifiers.
- 기존 구현 및 제약 조건: Codex already supplies task and subagent identity, but Go requests reached every adapter without `x-opencode-session`; one static provider header would collapse unrelated conversations.
- 검토한 주요 대안: Forward a raw thread header; reuse `prompt_cache_key`; configure one global value; inject separately in Chat and Responses adapters; enrich the canonical provider before wire selection.
- 선택한 방식: Hash the existing parent-qualified session lane with a provider-specific domain, attach it as runtime-only provider metadata before wire selection, and preserve an explicit operator override.
- 다른 대안 대신 이 방식을 선택한 이유: The lane already separates sibling subagents, while cache keys may represent shared cohorts and adapter-local changes would drift across Go's mixed wire matrix.
- 장점, 단점 및 영향: Go requests gain stable opaque affinity across normal retries and key rotation without persisted config changes; requests with no stable lane remain headerless rather than receiving a per-request value that defeats affinity.
