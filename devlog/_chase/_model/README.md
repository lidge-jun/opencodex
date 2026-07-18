# chase/_model — OpenCodex 모델·provider 기준점

이 폴더는 OpenCodex가 실제로 소유하는 모델/provider 구조와 변경 절차를 모아 둔 chase 기준점이다. jawcode의 `struct_har/chase/model/`에서 문서 분리 방식을 가져왔지만, 내용은 OpenCodex의 프록시·라우팅·Codex catalog 소유권에 맞춰 다시 작성했다.

현재 OpenAI/xAI 외 provider 구현 로드맵은 [`devlog/_plan/260717_non_openai_provider_chase/000_plan.md`](../../_plan/260717_non_openai_provider_chase/000_plan.md)다. 이 로드맵은 direct Sakana를 첫 work-phase로 두고, 기존 hardening 뒤에 OpenAI-compatible preset, workspace auth, native AWS 순서로 진행한다.

## 읽는 순서

1. [001_provider_inventory.md](./001_provider_inventory.md) — 현재 provider 수, adapter/auth 분포, 정본 경로.
2. [002_catalog_contract.md](./002_catalog_contract.md) — registry, live `/models`, jawcode metadata, Codex catalog가 합쳐지는 순서.
3. [003_auth_routing_flow.md](./003_auth_routing_flow.md) — 인증 종류, 모델 라우팅 우선순위, wire adapter 선택.
4. [004_patch_index.md](./004_patch_index.md) — 새 provider/모델/인증/wire 변경 시 실제 수정 지점.
5. [005_upstream_delta_backlog.md](./005_upstream_delta_backlog.md) — 실행 순서만 남긴 요약 backlog.
6. [006_jawcode_import_matrix.md](./006_jawcode_import_matrix.md) — jawcode 후보별 가져오기·조정·제외 판정과 구현 gate.
7. [007_model_id_delta.md](./007_model_id_delta.md) — provider namespace, 정확한 모델 ID, context/output metadata 차이.
8. [008_logic_delta.md](./008_logic_delta.md) — Cursor, retry, reasoning, auth, metadata bridge의 실제 로직 대조.

## OpenCodex의 주요 소유자

| 표면 | 정본 |
|---|---|
| built-in provider와 모델 capability seed | `src/providers/registry.ts:9`, `src/providers/registry.ts:221` |
| registry → init/GUI/key-login/OAuth 파생 | `src/providers/derive.ts:59`, `src/providers/derive.ts:101`, `src/providers/derive.ts:151` |
| 저장 config 계약 | `src/types.ts:348`, `src/types.ts:559` |
| `provider/model` 및 bare model 라우팅 | `src/router.ts:162` |
| wire adapter 선택과 모델별 override | `src/server/adapter-resolve.ts:13`, `src/server/adapter-resolve.ts:27` |
| live discovery와 Codex-visible catalog | `src/codex/catalog.ts:1126`, `src/codex/catalog.ts:1270`, `src/codex/catalog.ts:1478` |
| jawcode metadata snapshot 생성 | `scripts/generate-jawcode-metadata.ts:16`, `package.json:42` |
| provider 관리와 model picker API | `src/server/management-api.ts:400`, `src/server/management-api.ts:480` |

## 운영 규칙

- built-in provider의 정본은 `PROVIDER_REGISTRY`다. GUI preset, key-login 목록, OAuth 기본 config에 같은 값을 따로 복사하지 않는다.
- `src/generated/jawcode-model-metadata.ts`는 직접 수정하지 않는다. jawcode `packages/ai/src/models.json`을 입력으로 `bun run generate:jawcode-metadata`를 실행한다.
- live `/models`가 있는 provider는 live 결과를 모델 ID의 권위 있는 목록으로 취급하고, registry는 fallback과 capability hint를 맡는다.
- provider 추가와 모델 추가를 구분한다. 기존 adapter로 호출 가능한 새 모델 때문에 새 adapter나 새 auth flow를 만들지 않는다.
- jawcode native provider와 OpenCodex proxy provider는 별도 결정이다. 이름이 같아도 transport, auth, retry, catalog 소유권은 자동으로 공유되지 않는다.

## 출처와 신선도

초기 구조는 2026-07-17에 로컬 jawcode의 미커밋 `struct_har/chase/model/` 7개 문서를 읽고 만들었다. jawcode 문서는 참고 근거일 뿐 OpenCodex 정본이 아니다. provider 수, 모델 ID, upstream commit은 바뀔 수 있으므로 변경 작업을 시작할 때 이 폴더의 검증 명령을 다시 실행한다.

상태 표기는 다음 네 가지로 통일한다.

| 상태 | 뜻 |
|---|---|
| `VERIFIED` | 현재 소스와 focused test로 확인됨 |
| `PARTIAL` | 일부 경로는 있으나 upstream 계약 전체는 확인되지 않음 |
| `OPEN` | 현재 OCX 소유 경로에 구현이 없음 |
| `REJECT` | OCX 경계 밖이거나 의도적으로 가져오지 않음 |

구현 후보를 대조할 때는 위의 현재 상태와 별도로 다음 **결정**을 사용한다.

| 결정 | 뜻 |
|---|---|
| `IMPORT` | 같은 계약을 OCX owner에 구현할 가치가 확인됨. 표에 적힌 gate를 통과한 뒤 작업한다. |
| `ADAPT` | 목적은 유효하지만 jawcode 코드를 그대로 복사하지 않고 OCX 구조에 맞춘다. |
| `NOOP` | OCX가 이미 같은 결과를 내거나 구조상 해당 문제가 발생하지 않는다. |
| `REJECT` | 현재 OCX 제품/transport 경계에는 넣지 않는다. |
| `RESEARCH` | chase-only 또는 live-unverified라 구현 결정을 내릴 증거가 부족하다. |

근거 종류는 `local-source`, `chase-only`, `live-unverified`로 표시한다. `chase-only`와 `live-unverified`는 이 문서만으로 `IMPORT`나 `ADAPT` 승인을 만들 수 없다.
