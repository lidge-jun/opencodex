# ADR-0089 — decision recorded under "Process-local affinity diagnostics"

- Contract owner: [providers/openai-tiers.md](../providers/openai-tiers.md#process-local-affinity-diagnostics)

## Decision record

- 목적과 의도: Identify which combined Codex affinity values survive a Plus-to-K12 credential substitution without collecting private thread or account data.
- 기존 구현 및 제약 조건: Pool auth intentionally copies the curated caller metadata and replaces only authorization plus chatgpt-account-id. Individual header probes did not reproduce the workspace denial, while raw captures would expose account-bound identifiers.
- 검토한 주요 대안: Delete all affinity metadata; log raw values; persist ordinary hashes; perform automatic header-ablation retries; or emit process-local keyed equality evidence only when provider debug is enabled.
- 선택한 방식: Emit bounded pre-stream diagnostics with a random per-process HMAC key, a fixed non-credential header allowlist, known turn-field summaries, and no request mutation.
- 다른 대안 대신 이 방식을 선택한 이유: Equality across two requests in one run is enough to narrow the incompatible combination; process-local HMACs prevent durable correlation and make offline guessing useless, while observation-only capture cannot change production semantics.
- 장점, 단점 및 영향: Maintainers can compare a Plus success and exact-K12 denial safely. Tags cannot be compared across restarts, and the diagnostic does not itself identify an upstream policy rule or fix the rejection.
