# 030 — wp4: `deepseek-v4-pro` 퇴역 제거

## 커밋 분리

제거 근거의 강도가 프로바이더마다 다르므로 두 커밋으로 나눈다. 리뷰어가 뒤쪽만 떼어낼 수 있어야 한다.

**커밋 A — DeepSeek 1st-party와 그것을 되파는 경로 (근거 강함)**

| 대상 | 앵커 |
| --- | --- |
| `deepseek` 프리셋 | `registry.ts:2038-2078` — `modelContextWindows`, `modelWireDefaults`, `modelResponsesTerminalRepair`에서 제거 |
| `DEEPSEEK_THINKING_MODELS` | `registry.ts:619` — v4-pro 제거. Zen 3종과 volcengine 플랜이 이 상수를 공유하므로 파급을 각 사용처에서 확인 |
| `opencode-go` `noVisionModels` | `registry.ts:1793` |
| `command-code` 계열 | `registry.ts:631, 1180-1190, 2305`, `command-code-efforts.ts`, `adapters/command-code.ts:498` |
| `cline-pass` | `registry.ts:1144, 1199`, `adapters/cline-pass-deepseek-v4-tool-replay.ts:5` |
| `orcarouter` | `registry.ts:1180-1190` |
| `codebuddy` / `qoder` | `codebuddy-models.ts:38,124,145`, `qoder-models.ts:13` |
| `router.ts:686` | 잔여 참조 |
| 주석 (감사 추가) | `registry.ts:631, 719, 2038, 2305` — 코드에서 사라진 뒤에도 주석이 남으면 수용기준 1이 성립하지 않는다 |

## wp4 감사 반영 (2026-09-11): 삭제만으로는 사라지지 않는다

감사가 결정적인 사실을 잡았다. `liveModels: true`인 프로바이더(cline-pass, orcarouter, baseten, commandcode, command-code, digitalocean, qoder)는 **정적 행을 지워도 모델이 라이브 디스커버리로 다시 올라온다.** 지워지는 건 모델이 아니라 컨텍스트 창·사다리·text-only 힌트뿐이다. 그 결과는 제거가 아니라 순수 퇴행이다 — 비전 사이드카가 이미지를 떨구고 replay 완화가 사라진 채로 모델이 계속 보인다.

그래서 제거는 두 메커니즘으로 갈린다.

| 프로바이더 성격 | 대상 | 방법 |
| --- | --- | --- |
| 정적 `models:` 로스터 | alibaba-token-plan, alibaba-token-plan-intl, volcengine ark/coding/agent, ollama, nvidia-nim | 행 삭제 — 실제로 사라진다 |
| 라이브 디스커버리 | cline-pass, orcarouter, baseten, commandcode, command-code, digitalocean, qoder | `ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS`(`src/codex/catalog/parsing.ts:180`)에 슬러그 등록 — 이게 실제로 카탈로그에서 빼는 유일한 수단이다. 그 위에서 정적 메타데이터 행도 함께 정리한다 |

### 제외 슬러그 형식 (확인됨)

`catalogModelSlug`(`parsing.ts:842`)는 `model.alias ?? routedSlug(provider, id)`이고, 모델 id 안의 슬래시는 하이픈이 된다. 실제 예시가 테스트에 박혀 있다: `commandcode/deepseek-deepseek-v4-pro`(`tests/codex-integration/codex-catalog.test.ts:2230`).

따라서 등록할 슬러그는 다음 형태다. **각각 실제 카탈로그 출력으로 확인한 뒤 넣는다 — 형식이 틀리면 제외가 조용히 아무 일도 하지 않는다.**

| 프로바이더 | 모델 id | 슬러그 |
| --- | --- | --- |
| `commandcode` | `deepseek/deepseek-v4-pro` | `commandcode/deepseek-deepseek-v4-pro` |
| `command-code` | `deepseek/deepseek-v4-pro` | `command-code/deepseek-deepseek-v4-pro` |
| `orcarouter` | `deepseek/deepseek-v4-pro` | `orcarouter/deepseek-deepseek-v4-pro` |
| `cline-pass` | `cline-pass/deepseek-v4-pro` | `cline-pass/cline-pass-deepseek-v4-pro` |
| `baseten` | `deepseek-ai/DeepSeek-V4-Pro` | `baseten/deepseek-ai-DeepSeek-V4-Pro` |
| `digitalocean` | (확인 필요) | (확인 필요) |
| `qoder` | (확인 필요) | (확인 필요) |

## 감사가 잡은 나머지

- `registry.ts:2864` volcengine-agent-plan `defaultModel`이 `deepseek-v4-pro`다. 같은 커밋에서 로스터 내 다른 id로 교체한다.
- `ORCAROUTER_TEXT_ONLY_MODELS`(`1204`)와 `ORCAROUTER_MODEL_REASONING_EFFORT_MAP`(`1210`)은 v4-pro만 담고 있어 빈 컬렉션이 된다. `types/provider.ts:735`가 빈 배열을 "명시적 opt-out"으로 정의하므로 **빈 채로 두지 말고 상수와 소비 필드를 함께 삭제**한다.
- 대문자 id는 소문자 `rg`에 안 잡힌다: `registry.ts:1031,1042,1052`(baseten `deepseek-ai/DeepSeek-V4-Pro`), `qoder-models.ts:13`. 완료 기준의 `rg`는 `-i`를 쓴다.
- 내가 baseten이라고 적었던 `registry.ts:1080`은 실제로 DigitalOcean 목록이다.
- `command-code-efforts.ts:4` 행을 지우면 `router.ts:107`의 `knownModelIdsForProvider`가 그 키맵을 known-id 소스로 쓰므로 슬러그 디코드가 사라진다. 방금 머지된 v4.1-flash 행은 다른 키라 대체가 아니다. `146`행 주석도 사라진 행을 가리키게 되므로 같이 고친다.
- 후속 대상: 9개 로케일 문서, `frontier-benchmarks.json`, `src/generated/model-metadata.ts`, `model-rename-migration.ts:111`(사용자 config 마이그레이션), `structure:check`.

**커밋 B — 벤더 호스팅 (근거 약함, 분리)**

`alibaba-token-plan`/`-intl`, `volcengine` ark/coding/agent (`deepseek-v4-pro-260425` 포함), `ollama`, `nvidia-nim`, `baseten`.

**`volcengine-agent-plan`의 `defaultModel`이 `deepseek-v4-pro`다(`registry.ts:2832`).** 제거하면 기본 모델이 비므로 같은 커밋에서 대체 기본값을 정해야 한다. 이 프리셋의 나머지 로스터에서 고른다.

이 벤더들은 자체 스냅샷과 일정으로 배포한다. DeepSeek 1st-party 퇴역 공지가 그들의 로스터를 끝내지 않는다. 지시는 전부 제거였으므로 실행하되, PR 본문에 이 구분과 되돌리는 방법을 명시한다.

## 손대지 않는 것

`scripts/model-metadata.source.json`과 `src/generated/model-metadata.ts`. 생성 파일이고, `src/usage/cost.ts`가 과거 사용량 원가를 이 표로 계산한다. 행을 지우면 이미 기록된 요청의 비용이 깨진다. 002 참조.

## 수용 기준

1. `rg "deepseek-v4-pro" src`가 생성 파일을 제외하고 0건이다.
2. 레지스트리 멤버십을 고정하던 테스트가 갱신되고 통과한다.
3. 반대 증거: `deepseek-v4-flash` 별칭은 남는다 — DeepSeek이 이름을 유지한다고 명시했고, 그걸 지우면 기존 사용자 config가 깨진다.
4. **어느 프리셋의 `defaultModel`도** 퇴역 id를 가리키지 않는다. `deepseek`뿐 아니라 `volcengine-agent-plan`(2832)을 포함한다.
5. 주석에도 `deepseek-v4-pro`가 남지 않는다.

## 검증

```
bun test tests/providers tests/codex-integration/codex-catalog.test.ts
bun test tests/gui/volcengine-providers.test.ts tests/providers/baseten-provider.test.ts
bun run typecheck
rg "deepseek-v4-pro" src --glob "!src/generated/**"
```

## 리스크

영향 파일이 62개이고, 레지스트리 멤버십을 고정하는 테스트만 24개다(002 정정). 전체 스위트를 로컬에서 돌리지 않으므로(사용자 지시) 놓친 참조는 CI가 잡는다. CI 실패 시 해당 파일만 좁혀 고친다.

사다리 자체는 바뀌지 않는다는 점도 기록해 둔다: `DEEPSEEK_PRO_THINKING_EFFORTS`와 `DEEPSEEK_FLASH_THINKING_EFFORTS`는 값이 같다(`registry.ts:701-715`). 퇴역으로 실제로 어긋나는 건 컨텍스트 창과 가격이다.
