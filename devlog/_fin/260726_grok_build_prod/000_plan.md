# 000 — Grok Build 브리지 프로덕션화 로드맵

목표: PR #403(`codex/260726-grok-build-prod`, dev 리베이스 완료)에 남은 리뷰 블로커를 소스 근거로 해소하고, 공유 설정 파일(`~/.grok/config.toml`)과 서비스 라이프사이클을 안전하게 만든다.

베이스: `dev` @ `faaaf98f` 위 리베이스. 이전 유닛은 `devlog/_plan/260723_grok_build_bridge/`.

## 근거 조사 (2026-07-26)

Grok Build 소스 `~/Developer/codex/180_grok-build` (SOURCE_REV `30192d2e`, `xai-grok-version` 0.2.110) 확인 결과:

- `[model.<alias>]`는 `ConfigModelOverride`로 파싱된다 (`crates/codegen/xai-grok-shell/src/agent/config.rs:3914`). 지원 필드에 **`env_key`**(`:3928`)와 `auth_provider`(`:3930`), `extra_headers`가 있다.
- 자격 증명 우선순위는 `resolve_credentials`(`:4687`) 기준 `api_key` > `env_key` > auth_provider 캐시 토큰 > 세션 토큰 > `XAI_API_KEY`.
- `env_key`가 가리키는 환경변수가 비어 있으면 **세션 토큰으로 폴백하지 않는다** (`model_providers.rs:741` `model_own_unresolved_key_ignores_provider_inline_auth`). 즉 fail-closed다.
- 설치된 로컬 `~/.grok/bin/grok` 0.2.101 바이너리에도 `env_key` 문자열과 도움말(`Credential resolution: api_key > env_key > signed-in session token > XAI_API_KEY`)이 포함되어 있어 현재 사용자 환경에서도 쓸 수 있다.
- `api_backend`는 `chat_completions` / `responses` / `messages`이고 경로는 `base_url`에 상대 결합된다(`xai-grok-sampler/src/client.rs:703`). `/v1` 주입은 없다.
- config.toml 변경은 `ConfigFileWatcher` + `ConfigUpdate::ModelsChanged`로 실행 중 세션에 반영되지만(`config/reloader.rs:385`), docs.x.ai는 이를 보장하지 않고 `grok inspect` 후 재선택을 안내한다. 문서에서 hot-reload를 약속하면 안 된다.

opencodex 쪽 경계:

- `isApiAuthRequired(config) = !isLoopbackHostname(config.hostname)` (`src/server/auth-cors.ts:121`). 비루프백 바인드에서는 모든 데이터플레인 요청이 admission 토큰을 요구하므로, 현재 주입되는 `api_key = "opencodex-loopback"`은 **반드시 401**이 된다. 리뷰 지적이 실재한다.
- `~/.grok/config.toml`은 공유 파일이므로 실제 토큰을 직렬화하면 안 된다. `env_key = "OPENCODEX_API_AUTH_TOKEN"`이 두 요구를 동시에 만족한다.

## 작업 순서 (의존성 순)

| 단계 | 문서 | 내용 |
|---|---|---|
| wp1 | `010_config_safety.md` | 설정 파일 안전성: 비루프백 자격 증명, 인용 TOML 키 정규화, 개행 바이트 복원 |
| wp2 | `020_lifecycle_teardown.md` | 라이프사이클: 소유권 가드 실패 처리, 의도적 서비스/API 종료 시 fence 제거 |
| wp3 | `030_docs_truth.md` | 문서/데브로그 진실성 + 게이트 + PR #403 갱신 |

wp1이 먼저인 이유: fence가 무엇을 쓰는지가 확정되어야 teardown 계약과 문서가 그 위에 얹힌다. wp2는 wp1이 만든 블록을 제거하는 경로를 다루고, wp3은 둘의 최종 동작을 문서화한다.

## 스코프 경계

IN: `src/grok/*`, `src/cli/index.ts`, `src/service.ts`, `src/server/management-api.ts`, `docs-site/.../grok-build.md`, `devlog/_plan/*`, `tests/grok-*.test.ts`, `tests/service.test.ts` 계열 회귀.

OUT: #403 머지, main 승격, 릴리스/dist-tag, 라우팅·어댑터 리팩터, 다른 워크트리 수정.

## 게이트

`bun run typecheck`, `bun run test`, `bun run privacy:scan` 전부 green. 새로 추가되는 모든 조건 분기는 그 분기를 실제로 발동시키는 테스트를 동반한다 (C-ACTIVATION-GROUNDING-01).
