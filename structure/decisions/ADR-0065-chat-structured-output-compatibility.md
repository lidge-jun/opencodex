# ADR-0065 — Chat structured-output compatibility

- Contract owner: [providers/chat-compat.md](../providers/chat-compat.md#chat-structured-output-compatibility)

## Decision record

- 목적과 의도: Recover chat models that reject `response_format` without removing structured output from models that support it.
- 기존 구현 및 제약 조건: The adapter forwarded the field to every routed chat model after #1137, while the same model id may sit behind gateways with different capabilities.
- 검토한 주요 대안: Revert translation globally; blacklist a model id globally; detect a proxy by name or URL; add an explicit provider/model opt-out.
- 선택한 방식: Preserve default translation and omit it only for exact ids in `noStructuredOutputModels`.
- 다른 대안 대신 이 방식을 선택한 이유: Global or heuristic rules regress supported providers and make custom gateway names part of the wire contract.
- 장점, 단점 및 영향: Compatible siblings retain schema enforcement and explicitly incompatible models avoid the upstream 400; operators must classify each unsupported model they route.
