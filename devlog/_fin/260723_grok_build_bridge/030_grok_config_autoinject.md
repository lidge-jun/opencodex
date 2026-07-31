# 030 — wp3: Grok Build config 자동 등록·해제 (A안: 마커 블록 주입)

Date: 2026-07-23. User-selected plan A: `ocx start`가 `~/.grok/config.toml`에 관리 블록을 주입, `ocx stop`/`eject`/`uninstall`이 제거.

## Design

### 주입 형태 (additive, 펜스 마커)

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "opencodex-loopback"

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 1050000
# <<< opencodex managed block <<<
```

- 근거: grok 0.2.101 신규 표면 `[model_providers.<id>]` 상속 + `[model.<id>] model_provider` (Sol 분석 001, config.rs:3921-3934, model_providers.rs:165-206).
- 백엔드는 `chat_completions` (히트비트 잔여 이슈 회피, 011 참조).
- `api_key`: grok 크레덴셜 체인이 non-empty를 요구 (loopback ocx는 admission 무시).
- alias 규칙: `ocx-` + model id에서 `[^A-Za-z0-9_-]`→`-` (TOML bare-key 안전: 점이 서브테이블을 만들므로 반드시 치환). 충돌 시 `-2` 서픽스.
- `context_window`: 카탈로그 값 있으면 기재, 없으면 생략(grok 기본 200k).

### 라이프사이클

| 시점 | 동작 |
|---|---|
| `ocx start` (handleStart, syncModelsToCodex 이후) | `~/.grok` 존재 시에만 주입. 기존 펜스 블록은 통째로 교체(멱등). 첫 주입 전 1회 `config.toml.bak-opencodex` 백업 |
| `ocx stop` / daemon graceful shutdown (`!OCX_SERVICE`) | 펜스 블록만 제거, 사용자 블록 보존 |
| `ocx eject` / `ocx uninstall` | 동일 strip + runStep 로깅 |
| grok 미설치 (`~/.grok` 없음) | no-op, 로그 한 줄 |

- `GROK_HOME` env 존중 (기본 `~/.grok`) — 테스트 격리에도 사용.
- 사용자가 펜스 밖에 자체 `[model_providers.opencodex]`를 정의한 경우: 주입 스킵 + 경고 (충돌 방지).
- 모델 소스: handleStart가 이미 쓰는 `fetchAllModels` + `filterCatalogVisibleModels` 집계 재사용 (Desktop3p 레지스트리와 동일 목록).

## Work split (Sol 병렬)

- **Sol 워커 (disjoint write set):** `src/grok/inject.ts` 순수 모듈 + `tests/grok-config-inject.test.ts`. 파일시스템은 `grokHome` 파라미터로 주입받아 tmpdir 테스트.
- **메인:** CLI 배선 (`src/cli/index.ts` start/stop/eject/uninstall + shutdown 훅), 통합 커밋, 전체 검증.

## Verifier
1. `bun run typecheck`, 대상 테스트 + full `bun run test`
2. live: 격리 `GROK_HOME` + 수정 체크아웃 서버(:10190)로 start→config 주입 확인→`grok models`에 ocx-* 노출→1턴 스모크 exit 0→stop→블록 제거·사용자 블록 보존 확인
3. `bun run privacy:scan`

## Out of scope
- B안(models_base_url 카탈로그) — 네이티브 카탈로그 대체 부작용으로 보류
- grok config 핫리로드 대응 (시작 순서만 문서화)
- docs-site 문서화 (wp2 잔여로 유지)
