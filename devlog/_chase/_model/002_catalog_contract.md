# 002 — Catalog contract

OpenCodex catalog는 한 파일의 정적 목록이 아니다. 네 입력을 합쳐 Codex가 읽는 catalog와 `/v1/models`를 만든다.

## 입력과 우선순위

```text
PROVIDER_REGISTRY seed
  + persisted provider config
  + live provider /models (가능한 경우)
  + generated jawcode metadata hints
  -> visibility/capability normalization
  -> Codex catalog sync + models cache invalidation
```

| 단계 | 소유자 | 계약 |
|---:|---|---|
| 1 | `src/providers/registry.ts:221` | built-in fallback 모델과 model-scoped capability를 제공한다. |
| 2 | `src/router.ts:79-159` | 오래된 저장 config에 registry metadata를 backfill하고 사용자 override를 보존한다. |
| 3 | `src/codex/catalog.ts:1126` | live `/models`를 TTL cache로 읽는다. 정상 live 응답은 ID 목록의 권위 있는 결과다. |
| 4 | `src/codex/catalog.ts:1094` | `context_length`, `max_model_len`, `metadata.capabilities/limits`를 OCX catalog hint로 바꾼다. |
| 5 | `src/codex/catalog.ts:1297` | registry의 `jawcodeBundle` alias가 있는 provider에 생성된 jawcode metadata를 보강한다. |
| 6 | `src/codex/catalog.ts:1247` | `disabledModels`, provider별 `selectedModels`, provider 특수 필터를 적용한다. |
| 7 | `src/codex/catalog.ts:1478` | routed `provider/model` entry를 Codex catalog에 병합한다. |
| 8 | `src/codex/catalog.ts:1557` | `$CODEX_HOME/models_cache.json`을 무효화한다. |

## 정적 seed와 live discovery

- `liveModels: true`인 provider는 registry의 `models`를 fallback으로 쓴다.
- live fetch가 성공하고 schema가 정상이면 live ID가 권위 있는 목록이다. 설정에만 남은 ID는 무조건 유지하지 않는다.
- fetch 실패나 malformed 응답이면 last-known-good cache, 그다음 static config로 내려간다.
- context와 modality는 사용자/registry hint로 보강할 수 있지만, provider context cap은 live 값보다 크게 올리지 않는다.
- media generation 모델은 coding model picker에서 분리한다.

## jawcode metadata 생성 계약

입력 기본값은 `../jawcode/packages/ai/src/models.json`이고, `JAWCODE_MODELS_JSON`으로 다른 snapshot을 지정할 수 있다 (`scripts/generate-jawcode-metadata.ts:16-18`). 출력은 `src/generated/jawcode-model-metadata.ts`다 (`scripts/generate-jawcode-metadata.ts:19`).

```bash
bun run generate:jawcode-metadata
# 또는
JAWCODE_MODELS_JSON=/abs/path/models.json bun run generate:jawcode-metadata
```

생성 파일을 직접 고치지 않는다. source model metadata가 틀렸다면 jawcode generator/descriptor를 먼저 고치고 다시 생성한다. OpenCodex만의 routing/capability 예외라면 registry나 catalog normalization이 소유한다.

## 모델 변경 분류

| 변경 | 첫 수정 지점 |
|---|---|
| 기존 provider에 fallback model 추가 | 해당 `PROVIDER_REGISTRY` entry |
| live model metadata shape 추가 | `ProviderModelsApiItem` + `catalogHintsFromModelsApiItem()` |
| context/reasoning/modality 보정 | registry의 model-scoped metadata 또는 jawcode generator source |
| 모델별 wire protocol 변경 | `src/server/adapter-resolve.ts` |
| picker 노출/숨김 | `disabledModels`, `selectedModels`, catalog filter |
| native OpenAI snapshot | `src/codex/data/upstream-models.json`의 owning generation/update 절차 |

## 완료 기준

- catalog focused test가 통과한다.
- `/api/models`와 `/v1/models`가 같은 routed model source를 사용한다.
- `provider/model` slug, context window, input modalities, reasoning ladder가 기대값과 맞는다.
- 생성 파일을 바꿨다면 generator 명령과 diff 요약을 남긴다.
- `bun run typecheck`가 통과한다.

## 검증

```bash
bun test --isolate tests/codex-catalog.test.ts tests/provider-live-models.test.ts
bun run typecheck
git diff --check
```
