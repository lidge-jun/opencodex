# 000 — Devin 이미지 패스스루

- 단위: `260913_devin_image_passthrough`
- 세션: `01a0985e-ce1a-7d12-81b9-c2e93a2bce67` (HOTL, cxc-loop)
- 기준: `origin/dev`

## 증상

사용자가 Codex composer에 이미지를 붙여넣고 devin/swe-2에 보냈더니 턴이 0초에 죽었다.
이미지가 전달되지 않아 tesseract OCR로 우회하려던 상황이었다.

## 원인 — 세 층이 겹쳐서

와이어 계층(`src/adapters/devin/cloud-direct/chat.ts`)은 이미 멀티모달이다.
`ContentPart`에 `{type:"image", mimeType, base64Data, caption}`이 있고
`encodeImageData`(:189-196)가 이를 `ChatMessagePrompt` 필드 #10 `ImageData`
`{#1 base64_data, #2 mime_type, #3 caption}`로 인코딩한다. extension.js 대조 검증 완료.

그런데 매핑 계층(`src/adapters/devin.ts`)이 이미지를 버린다.

| 함수 | 줄 | 하는 일 |
|---|---|---|
| `textFromParts` | :205-209 | `type:"text"`만 뽑아 문자열로 반환 — 이미지는 빈 문자열 기여 |
| `mapOneMessage` (user) | :293-294 | 텍스트만 남기고 `if (!text) return undefined` — **이미지만 있는 메시지가 통째로 사라짐** |
| `toolResultText` | :211-214 | 같은 방식으로 툴 결과의 이미지도 버림 |

사용자의 스크린샷에서 data: URI가 텍스트 첨부로 보인 것은 UI 표시이고, 실제로는
`OcxImageContent`(`types/request.ts:189-195`)의 `imageUrl`이 data: URL로 들어온다.
매핑이 그것을 인식하지 못하고 텍스트 추출에서 빈 문자열을 얻어 메시지를 드롭한다.

## 수정 — `src/adapters/devin.ts`

### 1) NEW: `mapOcxContentToWire` 헬퍼

```ts
import type { ContentPart } from "./devin/cloud-direct/chat";

/**
 * Convert inbound content parts to the wire shape the encoder accepts.
 *
 * The wire layer is already multimodal (ChatMessagePrompt field #10 ImageData),
 * but every image was discarded here: textFromParts returned text-only strings,
 * and a message whose only content was an image was dropped entirely. A data:
 * URL carries everything field #10 needs; a remote https URL cannot be inlined
 * without a fetch, so it stays as an explicit text reference rather than
 * pretending the model can see a picture it cannot. Video has no Devin field.
 */
function mapOcxContentToWire(content: string | OcxContentPart[] | undefined): string | ContentPart[] {
  if (typeof content === "string" || !Array.isArray(content)) return content ?? "";
  const out: ContentPart[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) out.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      const m = part.imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) out.push({ type: "image", mimeType: m[1]!, base64Data: m[2]! });
      else out.push({ type: "text", text: "[image url: " + part.imageUrl + "]" });
    }
  }
  return out;
}
```

### 2) MODIFY: `mapOneMessage` user/developer 분기

```ts
// before
    const text = textFromParts(message.content).trim();
    if (!text) return undefined;
    return { role: ..., content: text };

// after
    const content = mapOcxContentToWire(message.content);
    // 텍스트 없이 이미지만 있는 메시지도 유효하다 — 드롭하면 안 된다.
    if (typeof content === "string" ? !content.trim() : content.length === 0) return undefined;
    return { role: ..., content };
```

### 3) MODIFY: 툴 결과

```ts
// before
    content: toolResultText(message),

// after — 오류 접두사는 유지하되, 이미지가 있으면 ContentPart[]로 넘긴다
    const wireContent = mapOcxContentToWire(message.content);
    content: message.isError
      ? (typeof wireContent === "string" ? "ERROR: " + wireContent
         : [{ type: "text", text: "ERROR:" }, ...wireContent])
      : wireContent,
```

## NEW: tests/providers/devin-image-passthrough.test.ts

| 케이스 | 기대 |
|---|---|
| data: URL 이미지 파트가 ContentPart image로 변환 | `{type:"image", mimeType:"image/png", base64Data:"iVBOR..."}` |
| 이미지만 있는 user 메시지가 드롭되지 않음 | items에 존재 |
| 텍스트 + 이미지 혼합 | 순서 보존 |
| https URL 이미지 | 텍스트 참조로 남음 |
| 툴 결과의 이미지 | ContentPart[]로 전달 |
| 툴 결과 오류 + 이미지 | ERROR 접두사 유지 |
| 와이어 인코딩 | buildGetChatMessageRequestForTests가 field #10을 냄 |

## 레이아웃 등록

- `scripts/test-layout/layout.json` explicit → providers
- `tests/fixtures/test-layout-expected.json`


## 결과 (2026-09-13)

- PR [#4513](https://github.com/lidge-jun/opencodex/pull/4513) squash merge: `c5d7f6a6efc22ab2fc17b377e0d6aae79c77b6a8`
- exact-head CI (`6106478389`): test 1-4/4, macos 1-2/2, keyring/docker/npm-global/hygiene/gates 전부 green (windows shard는 runner 선택으로 skip)
- 로컬 포커스 테스트: devin 도메인 9개 파일 154 pass / 0 fail (디버깅용; 제품 스위트·typecheck·build는 NOT RUN, 호스티드 CI가 머지 증거)
