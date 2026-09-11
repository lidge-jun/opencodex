# ADR-0017 — Config injection

- Contract owner: [config.md](../config.md#config-injection)

## Decision record

- 목적과 의도: Keep strict-config diagnostics useful without interpreting instruction prose as TOML or exposing OS account names in shareable output.
- 기존 구현 및 제약 조건: The diagnostic reader intentionally covers only Codex root keys and tables; a full TOML dependency is not otherwise required.
- 검토한 주요 대안: Add a full TOML parser, scan raw lines for one legacy key, or preserve the lightweight parser with multiline lexical state.
- 선택한 방식: Preserve the bounded reader, skip multiline string bodies before key/table matching, and redact paths only at the formatting boundary.
- 다른 대안 대신 이 방식을 선택한 이유: All consumers keep one root/table interpretation while internal diagnostics retain actionable local paths.
- 장점, 단점 및 영향: False positives and username disclosure are removed; unsupported exotic TOML syntax remains outside this diagnostic reader's contract.
