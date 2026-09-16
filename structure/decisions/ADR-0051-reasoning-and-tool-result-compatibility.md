# ADR-0051 — decision recorded under "Reasoning and tool-result compatibility"

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#reasoning-and-tool-result-compatibility)

## Decision record

- 목적과 의도: Keep same-backend opaque reasoning replay while preventing backend-private blobs and output-only fields from breaking the first turn after a route change.
- 기존 구현 및 제약 조건: Reasoning-input sanitation already handled raw content and `ocxr1:` envelopes; the replay cache already supplied a bounded, thread-scoped physical-route identity, but no record connected that identity to native `encrypted_content` provenance.
- 검토한 주요 대안: Strip every opaque blob, persist provenance across restarts, trust generic 4xx prose, rely only on a retry, or combine deterministic route comparison with a narrowly identified recovery.
- 선택한 방식: Remove output-only `status` from every reasoning input item without changing the pre-existing raw-`content` blanking rule; compare a 64-entry/256 KiB/one-hour in-process serving-identity record using durable destination and credential dimensions before sending, commit it only after the selected destination succeeds, pass a proven change into the Responses adapter before the first send, and use one self-identified opaque-blob recovery only when provenance was unknown.
- 다른 대안 대신 이 방식을 선택한 이유: The former blob/status coupling was defensive rather than observed, and live backends showed that removing `status` preserves same-backend Grok replay while allowing cold cross-backend requests to reach blob validation. Unknown provenance can still be valid after restart, durable storage is unnecessary for this bounded compatibility hint, and deterministic pre-flight avoids the extra paid or stateful upstream attempt whenever the process has evidence. The upstream's narrow error identity supplies authoritative evidence only for histories the process could not observe.
- 장점, 단점 및 영향: Same-route and unknown replay retain cached reasoning on the first send without replaying an output-only field, known cross-route replay keeps the reasoning item without its undecodable blob, and a cold cross-route replay can reach opaque-blob recovery instead of failing early on `status`. A repeated blob rejection is surfaced unchanged after exactly one recovery attempt.
