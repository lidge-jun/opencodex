# ADR-0004 — Lifecycle

- Contract owner: [runtime.md](../runtime.md#lifecycle)

## Decision record

- 목적과 의도: Prevent repository dotenv data from becoming a durable executable or an OAuth-bearing Claude destination.
- 기존 구현 및 제약 조건: Bun auto-loads project dotenv before OpenCodex TypeScript evaluates, while provider interpolation still depends on that behavior and cannot be disabled globally.
- 검토한 주요 대안: Reject only relative Bun paths; disable Bun dotenv; trust a plain environment marker; capture provenance in the Node launcher and bind it to an argv proof.
- 선택한 방식: The Node launcher selects Bun and snapshots Anthropic credential/destination slots before Bun starts. Durable runtime selection uses only the stamped current executable, while Claude accepts the snapshot only when its random argv proof matches.
- 다른 대안 대신 이 방식을 선택한 이유: Absolute dotenv expansion bypasses a relative-path check, global dotenv removal breaks supported configuration, and an environment-only marker can itself come from dotenv.
- 장점, 단점 및 영향: Normal npm launches preserve genuine shell overrides. Direct Bun or legacy launches have no provenance signal and fail closed for all three ambient Anthropic slots — credentials included, because subscription mode leaves `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` unset by design (#253) and a `settings.env` merge can still replace the destination after launch, so a preserved key would travel with it. The cost is that `bun src/cli/index.ts` loses ambient Anthropic values; the escape hatch is running through the published `ocx` bin, where genuine shell exports are preserved by proof. Durable artifacts use the running or bundled Bun.
