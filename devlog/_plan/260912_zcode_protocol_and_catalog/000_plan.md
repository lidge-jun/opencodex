# 000 — ZCode 프로토콜 정렬 + GLM-5.3 모달리티 정정

## 목표

ZCode 연동에서 확인된 세 가지 결함을 1차 근거와 함께 고친다.

1. ocx가 ZCode에 내보내는 프로바이더 블록이 `kind: "openai-compatible"`(Chat Completions)로 붙는다.
   ocx는 Responses-우선 프록시라 Chat 인바운드는 Responses로 번역된 뒤 다시 Chat으로 역번역된다.
   ZCode는 `kind: "openai"`로 `{baseURL}/responses`를 직접 호출할 수 있으므로 번역을 0회로 줄인다.
2. `zai`와 `zhipu-bigmodel-coding` 행이 `glm-5.3-flash`의 입력 모달리티를 음수 선언
   (`noVisionModels` 제외)으로만 다뤄서, 클라이언트 export 피커에 네이티브 VLM이 text-only로 나간다.
3. `zai` 행이 Chat Completions 한 갈래에 고정되어 있다. Z.AI 는 같은 키로 Responses 도 서빙하고
   (`https://api.z.ai/api/v1`) 실사용에서 Chat 경로가 불안정하다. Responses 를 기본으로 돌리고
   Chat 은 opt-in 으로 남긴다.

## 제약

- 로컬 상태(`~/.opencodex`, `~/.zcode`, `zcode-ocx-sidecar`)는 건드리지 않는다. 사용자 지시.
- `zai` 행은 제자리에서 Responses 로 전환한다. 별도 행을 추가하지 않는다 — 사용자 결정
  ("다 통합하고 chat optin 으로, 기존 사용자도 response 전환"). 초안에 있던 로스터 손실 우려는
  실측으로 반증됐다: glm-5.2 / glm-5.1 / glm-5 / glm-4.6 / glm-5-turbo 전부 Responses 에서 200 이다
  (030 라이브 표). 030 이 wp4 의 SSOT 다.
- 프로토콜 전환은 조용히 일어나므로 릴리스 노트에 적는다. Chat 전용 키를 가진 사용자는
  `modelAdapters` 로 모델마다 `openai-chat` 을 지정해야 한다. 마이그레이션 코드는 넣지 않는다.
- wp2 와 wp3 는 서로 독립이다. wp4 는 wp3 가 넣는 `ZAI_GLM_5X_INPUT_MODALITIES` 상수에 의존하므로
  wp3 가 `dev` 에 들어간 뒤에 올린다. 각 수정은 자기 이슈를 닫는 PR 로 가고 베이스는 `dev` 다.

## 작업 단계

| work-phase | 내용 | 이슈 | 문서 |
|---|---|---|---|
| wp1 | 조사 + 로드맵 + 이슈 3건 등록 (docs-only) | — | 000-003 |
| wp2 | ZCode export를 `kind: "openai"`(Responses)로 | [#4295](https://github.com/lidge-jun/opencodex/issues/4295) | 010 |
| wp3 | `glm-5.3-flash` 양수 모달리티 선언 | [#4296](https://github.com/lidge-jun/opencodex/issues/4296) | 020 |
| wp4 | `zai` 를 Responses 기본으로 전환 + `chatCompletionsPath` 로 Chat opt-in | [#4297](https://github.com/lidge-jun/opencodex/issues/4297) | 030 |

wp2 는 독립이다. wp4 는 wp3 뒤에 온다(위 제약).

## 검증

- `bun run typecheck`
- `bun test tests/providers/zcode-client.test.ts tests/config/client-config-export.test.ts`
- `bun test tests/providers/provider-registry-parity.test.ts`
- `bun run structure:check` (structure/clients/integrations.md 소유 영역 변경 시)
- PR-ready 게이트로 `bun run test`
