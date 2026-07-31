---
created: 2026-07-26
status: plan
phase: wp5
blockers: [B7, B8]
tags: [grok-build, docs, devlog]
---

# 050 — 문서/devlog 진실 정렬 (B7, B8)

대상 파일: `docs-site/src/content/docs/guides/grok-build.md`,
`devlog/_plan/260723_grok_build_bridge/020_docs_and_residual_smoke.md`.
근거: `001_grok_source_evidence.md` E3/E4/E5/E6.

## B7 — grok-build 가이드

### 1. 비루프백 절 재작성 (수용 + 확장)

CodeRabbit 지적("api_key만 바꾸라고 하면 안 된다, base_url도 도달 가능해야 한다")은 옳다.
다만 020에서 비루프백 블록이 `env_key`를 방출하도록 바뀌므로 안내 내용 자체가 달라진다:

- 자동 등록된 블록은 비루프백 바인드에서 `env_key = "OPENCODEX_API_AUTH_TOKEN"`을 쓴다.
  사용자는 **grok을 실행하는 환경에 그 변수를 export**하면 된다. 설정 파일을 손댈 필요가 없다.
- `base_url`은 우리가 실제 바인드 호스트로 생성하므로 `127.0.0.1` 고정 문제가 사라진다.
  수동 예시도 도달 가능한 호스트(`http://192.168.1.10:10100/v1`)로 바꾼다.
- 변수를 export하지 않으면 grok은 키 없이 호출해 401을 받는다는 사실을 명시한다 —
  조용한 실패가 아니라 진단 가능한 실패임을 알린다.

### 2. 리로드 절 정정 (부분 반박)

CodeRabbit은 "핫리로드를 약속하지 말라"고 했지만 원본에는 감시자가 실재한다(E4).
따라서 문장을 삭제하지 않고 **정확하게** 다시 쓴다:

- grok은 `~/.grok/config.toml`을 감시하며 `[model]` 테이블이 실제로 달라졌을 때만 리로드한다
  (약 1초 디바운스, 내용 기반 비교).
- 확인 명령은 `grok inspect`이며, 이것이 보여주는 것은 **설정 소스 목록과 거부된 필드 경고**다.
  모델 카탈로그를 나열하지 않는다(E6).
- 잘못된 TOML은 사용자 레이어 전체를 무효화하므로 우리는 원자적 쓰기를 쓴다는 점을 적는다.

버전 번호로 보증하지 않고 관측된 동작과 확인 방법을 제시하는 형태이므로, 지적의 의도
(검증 불가한 약속 금지)는 충족된다.

### 3. 백엔드 절

`api_backend`의 실제 수용값은 `chat_completions`(기본), `responses`, `messages` 세 가지임을 적고,
우리가 `chat_completions`를 방출하는 이유를 한 줄로 설명한다(다음 절).

## B8 — devlog 020 정정

`260723_grok_build_bridge/020_docs_and_residual_smoke.md` 11행의 `responses` 권장을
`chat_completions`로 바꾸고, 같은 유닛 `011_receipt.md:53-55`의 관측을 인용해 이유를 남긴다.
이번에는 추측이 아니라 원본 근거를 붙인다:

> `responses` 백엔드에서 grok의 이벤트 열거형에는 catch-all 변형이 없고
> (async-openai 포크 `95b52ebd`), 알 수 없는 최상위 `type` 태그는
> `SamplingError::Serialization`으로 **재시도 없이** 턴을 종료시킨다.
> 삼켜지는 비표준 이벤트는 doom-loop 체크 하나뿐이다.
> 따라서 `response.heartbeat`를 내보내는 경로에서는 `chat_completions`를 쓴다.

`020` 문서를 고치면서 원 문서의 다른 주장은 건드리지 않는다 — 이 유닛은 이미 마감된 기록이며
정정 사유를 표시해 이력을 남긴다.

## 게이트

`bun run docs:check`(존재 시) → `bun run typecheck` → 링크/빌드 확인.
