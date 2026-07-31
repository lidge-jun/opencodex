# 031 — wp3 receipt: Grok Build config 자동 등록·해제

Date: 2026-07-23 (KST), branch `codex/260723-grok-build-bridge`, commits `52dfb934` + `ead5e715`

## 설계 이탈 (중요)

030의 A안은 `[model_providers.opencodex]` 상속이었으나, **grok 0.2.101 라이브 검증에서 상속된 base_url이 실제 추론 라우팅에 적용되지 않음**을 확인:

- `model_provider = "opencodex"` 상속 모델 → 요청이 기본 `cli-chat-proxy.grok.com`으로 나가 401 (`/tmp/grok-wp3.err`, dummy 키)
- 동일 필드를 모델 블록에 직접 기재 → 정상 라우팅 (`MP_DIRECT_OK`, `/tmp/grok-mp-debug`)
- grok 소스상 `with_provider_defaults`(model_providers.rs:166-206)는 병합을 수행하지만, 추론 클라이언트의 base_url 결정에는 반영 안 되는 것으로 보임 (0.2.101 시점)

→ 구현은 **모델 블록마다 직접 base_url/api_backend/api_key 기재**로 전환. 코드 주석에 근거 명시.

## Live verification (수정 체크아웃, :10190, 격리 GROK_HOME=/tmp/grok-home-wp3)

1. 사용자 config(`[models] stream_tool_calls=false`) 존재 상태에서 `ocx start` → `+ Grok Build config updated (28 models)` 로그, 펜스 블록 추가, `config.toml.bak-opencodex` 1회 생성, 사용자 블록 보존
2. `grok models` → `ocx-gpt-5-6-sol` 외 27개 노출
3. 스모크: `ocx-cursor-grok-4-5` exit 0 `OCX_WP3_OK`, `ocx-gpt-5-4-mini` exit 0 `OCX_WP3_NATIVE_OK`
4. daemon SIGTERM(graceful shutdown) → syncCleanup의 stripGrokConfig 동작, 펜스 블록 0개, 사용자 config 원문 복원
5. 재시작 → 재주입 멱등 확인 (블록 1개 유지)

주의: `ocx stop` CLI는 이 테스트 환경에서 service-home mismatch로 stopServiceIfInstalled 단계에서 throw — 프로덕션 환경(동일 OPENCODEX_HOME)에서는 미해당이나, handleStop 내 strip 위치가 이 throw 뒤라 도달 못 하는 경로가 존재. 리뷰어 검토 항목.

## Verifier
- typecheck pass, `tests/grok-config-inject.test.ts` 8 pass, privacy scan pass
- full suite 3713 pass / 1 fail (기존 anthropic-thinking-signature full-run 플레이크, wp1과 동일)

## Round 2-4 — Sol 리뷰어(Socrates) FAIL 반복 수정

R1 FAIL (4 blockers): orphan 마커가 유저 콘텐츠 삭제 가능 / 비원자적 쓰기 / 유저 [model.*] alias 충돌 시 TOML 전체 무효화 / handleStop이 service-home mismatch throw로 strip 도달 불가. → `f75cc563`: orphan은 inject/strip 모두 거부(ok:false, 파일 불변), atomicWriteFile 전환, 유저 alias 예약+서픽스, handleStop try/catch로 teardown 연속성 확보, ok:false 경고 표면화, per-model direct-field 계약 테스트.
R2 FAIL (1 blocker): quoted/whitespace TOML 동등 표기([model."ocx-mine"], [ model . ocx-mine ]) 미인식. → `848cab37`: 3형태 canonicalize + Bun.TOML.parse 검증 테스트.
R3 FAIL (1 blocker): \UXXXXXXXX 이스케이프 미디코딩. → `7dfdc3f4`: TOML basic-string 디코더(\uXXXX/\UXXXXXXXX/기본 이스케이프) + 회귀.
R4 **PASS** (no remaining blockers).

## 최종 live round-trip (하드닝 반영 후)

start → 28모델 주입 → `ocx-cursor-grok-4-5` exit 0 `OCX_FINAL_OK` → stop (service-stop 경고에도 teardown 완주) → 펜스 제거·유저 config 원문 복원.

최종: `tests/grok-config-inject.test.ts` 11 pass, typecheck clean, privacy scan pass, full suite 3716 pass / 1 기존 플레이크. 커밋 체인: 52dfb934 → ead5e715 → f75cc563 → 848cab37 → 7dfdc3f4.

수용 잔여(리뷰어 동의): stale-read 락 없음(단일 라이터 가정), ensure live-proxy 분기의 grok 재주입 없음(기존 codex sync 동작과 일치), trailing-dash alias 미관.
