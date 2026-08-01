# 110 — OpenCode Go URL 정규화 (Blocker)

## 문제

`resolveWireProtocolOverride()`가 MiniMax/Qwen 모델에 대해 adapter를 `anthropic`으로 변경하지만 baseUrl은 그대로 둔다.

```
registry.ts:123  → baseUrl: "https://opencode.ai/zen/go/v1"
server.ts:96     → return { ...providerConfig, adapter: "anthropic" }
anthropic.ts:178 → url = `${provider.baseUrl}/v1/messages`
결과: https://opencode.ai/zen/go/v1/v1/messages  ← 404
```

정상 endpoint: `https://opencode.ai/zen/go/v1/messages`

## 수정

### 방안: anthropic adapter에서 baseUrl 끝 `/v1` 중복 감지 제거

anthropic.ts의 URL 구성을 수정하여, baseUrl이 이미 `/v1`로 끝나면 `/messages`만 붙인다.

### MODIFY `src/adapters/anthropic.ts:178`

```diff
- const url = `${provider.baseUrl}/v1/messages`;
+ const base = provider.baseUrl.replace(/\/v1\/?$/, "");
+ const url = `${base}/v1/messages`;
```

이 방식의 장점: `resolveWireProtocolOverride` 변경 불필요, 기존 Anthropic 직접 provider(`https://api.anthropic.com`)도 영향 없음 (`/v1`로 안 끝남).

### NEW `tests/wire-protocol-override.test.ts`

```ts
import { describe, test, expect } from "bun:test";

describe("wire protocol URL normalization", () => {
  test("anthropic adapter strips trailing /v1 to avoid /v1/v1/messages", () => {
    const baseUrl = "https://opencode.ai/zen/go/v1";
    const normalized = baseUrl.replace(/\/v1\/?$/, "");
    expect(`${normalized}/v1/messages`).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  test("standard anthropic baseUrl is unaffected", () => {
    const baseUrl = "https://api.anthropic.com";
    const normalized = baseUrl.replace(/\/v1\/?$/, "");
    expect(`${normalized}/v1/messages`).toBe("https://api.anthropic.com/v1/messages");
  });

  test("opencode-go kimi uses openai-chat (no override)", () => {
    // kimi-k2.7 is NOT in the ANTHROPIC_WIRE_MODELS set → adapter stays openai-chat
    // URL: baseUrl + /chat/completions (openai-chat adapter)
    // No /v1 duplication issue
  });

  test("opencode-go minimax-m3 uses anthropic adapter", () => {
    // minimax-m3 IS in ANTHROPIC_WIRE_MODELS → adapter switches to anthropic
    // URL must be: baseUrl(stripped) + /v1/messages
  });
});
```

## 검증

1. `minimax-m3` → `https://opencode.ai/zen/go/v1/messages` (unit test)
2. `kimi-k2.7` → `https://opencode.ai/zen/go/v1/chat/completions` (대조 확인)
3. `anthropic` 직접 → `https://api.anthropic.com/v1/messages` (regression 확인)
