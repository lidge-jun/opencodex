# ADR-0064 — Chat structured-output compatibility

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#chat-structured-output-compatibility)

## Decision record

- 목적과 의도: Make Moonshot's compatibility rewrite remove rejected sibling `$ref` shapes without silently weakening a tool schema.
- 기존 구현 및 제약 조건: The target and sibling both apply under JSON Schema 2020-12, but a shallow shared-property merge let sibling bounds replace stricter target bounds; Moonshot still requires the local bounded rewrite.
- 검토한 주요 대안: Keep shallow sibling precedence; emit `allOf`; intersect only top-level bounds; recursively compose the supported set-valued and ordered assertions.
- 선택한 방식: Reuse the existing bound and required intersection rules recursively for overlapping object properties inside the first-party destination gate.
- 다른 대안 대신 이 방식을 선택한 이유: Shallow precedence weakens constraints, while a new `allOf` wire shape needs separate provider evidence; recursive composition fixes the demonstrated loss without broadening normalization to custom providers.
- 장점, 단점 및 영향: Looser siblings cannot relax nested constraints and tighter siblings still narrow them; non-ordered conflicting keywords retain the existing sibling precedence and are not treated as a complete JSON Schema algebra.
