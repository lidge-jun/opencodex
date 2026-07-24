# 020 — wp2: Grok Build 연동 문서화 + 잔여 스모크

Precondition: wp1 (usage details 상시 방출) 완료, 3-way 매트릭스 exit 0.

## Deliverables

### 1. 사용자 문서 (docs-site)
- 위치 후보: `docs-site` 내 클라이언트 연동 섹션 (기존 Claude Code / Copilot 인바운드 문서 형식 답습 — P에서 실제 경로 확인).
- 내용:
  - 권장 config: `[model_providers.opencodex]` 블록 + 얇은 `[model.<alias>]` 목록 (Sol 분석의 신규 표면 활용, grok 0.2.101+).
  - 백엔드 선택: `responses` 권장 (wp1 이후 완전 동작; harness가 내부적으로 Responses vocab을 쓰는 경로 존재), `chat_completions`도 동작.
  - 인증: loopback은 아무 non-empty `XAI_API_KEY`/api_key로 충분(ocx가 무시), non-loopback은 ocx admission token.
  - 카탈로그: `GROK_MODELS_BASE_URL=http://127.0.0.1:10100/v1`.
  - 한계: grok 하니스 시스템 프롬프트는 xAI 톤 전제, 모델별 tool 동작 차이.
- 번역 로케일 모순 없는지 확인 (AGENTS.md Docs sync 규칙).

### 2. 잔여 스모크 (021_receipt)
- tool-call 왕복: grok headless로 `run_terminal_cmd` 허용 1턴 (`echo` 정도) — function_call/function_call_output 왕복이 routed 모델에서 도는지.
- 카탈로그 fetch: `GROK_MODELS_BASE_URL` 설정 후 `grok models`가 ocx 모델 목록을 표시하는지 + 각 항목 백엔드 폴백(chat_completions) 동작 기록.
- 스트리밍 长응답 1건 (사고 텍스트 포함 모델)로 reasoning 델타 처리 확인.

## Verifier
- docs 빌드 체크 (docs-site 빌드 or 기존 lint 스크립트 — P에서 확인)
- 스모크 로그 receipt 커밋 (devlog 유닛에 요약, 로그 자체는 /tmp 유지)

## Out of scope
- ocx `/v1/models` 응답 확장(zero-config), grok-build 소스 수정, push/release.
