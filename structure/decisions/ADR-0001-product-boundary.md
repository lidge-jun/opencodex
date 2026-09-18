# ADR-0001 — decision recorded under "Product boundary"

- Contract owner: [overview.md](../overview.md#product-boundary)

## Decision record

- 목적과 의도: Add two widely used API-key providers through the canonical registry so CLI, GUI, login, routing, and documentation remain in parity.
- 기존 구현 및 제약 조건: Tencent Coding Plan is OpenAI-compatible but contractually restricted to interactive coding tools and has a dynamic, text-only model set. SiliconFlow exposes a dynamic OpenAI-compatible catalog whose reasoning controls vary by model.
- 검토한 주요 대안: Treat both as custom providers only; freeze a large SiliconFlow model list and reasoning map; expose Tencent without a usage warning.
- 선택한 방식: Add registry-derived key presets, keep live discovery enabled, seed only Tencent's currently documented coding-plan models, and surface Tencent's usage restriction in both the preset note and public docs.
- 다른 대안 대신 이 방식을 선택한 이유: Registry presets remove setup friction while live discovery avoids claiming that mutable catalogs are permanent. Avoiding speculative SiliconFlow reasoning metadata prevents invalid vendor-specific parameters.
- 장점, 단점 및 영향: Both providers appear consistently across supported setup surfaces. Tencent users receive an explicit policy warning; SiliconFlow reasoning controls remain conservative until model-specific limits can be represented safely.
