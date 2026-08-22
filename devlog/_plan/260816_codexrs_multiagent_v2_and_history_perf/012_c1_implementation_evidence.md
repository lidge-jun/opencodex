# 012 — C1-D: 구현 완료와 검증 증거

브랜치 `codex/compat-multiagent-v2-catalog` @ `d7bac3476` (origin/dev `8a0de6c44` 위).
상류 codex-rs `49db349ff`. 계획: `011` 4판.

## 구현한 것

### 1. 로스터 자격 (G1a) — `src/codex/catalog/sync.ts:105-108`

```ts
// before
return pinned === "v2" || pinned === null || pinned === undefined;
// after
return entry.multi_agent_version !== "disabled";
```

상류 `6d4d9442c` 와 정합. `v1` 핀은 이제 **자격 있는 리프 워커**이며, 이것이 upstream이
`gpt-5.6-luna` 에 붙인 핀이다. 주석에 3분류(eligible-recursive / eligible-LEAF / excluded)와
`keepNativeChatGptOnV1`(#1728) 정책과의 관계를 명시했다.

### 2. `gpt-daybreak-blue-latest` 전역 편입 — `src/codex/catalog/native-models.ts`

소유자 결정. `NATIVE_OPENAI_MODELS` 에 추가. 선언부 주석에 **수용된 트레이드오프**를 기록:
권한 없는 계정도 행을 보게 되며, 선택 시 백엔드 400이 릴레이된다(bare 풀 라우트는 인식된
400 본문에 한해 다른 계정 1회 재시도; 셀렉터 한정 라우트는 고정 계정이라 즉시 릴레이).
`disabledModels` 는 가시성 hatch이지 런타임 거부가 아니다.

`NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS` 주석도 정정 — 두 목록 겸속이 이제 정상이며,
소비 맵이 `Map` 이라 중복이 접힌다는 점을 명시.

## 검증 (lidge, Ubuntu 16-core, `~/ocx-c1-test` @ `d7bac3476`)

| 게이트 | 결과 |
| --- | --- |
| `bun x tsc --noEmit` | **exit 0** |
| `OCX_TEST_NO_QUEUE=1 bun scripts/test.ts` | **12561 pass / 13 skip / 0 fail**, `TEST_EXIT=0` |
| 규모 | `Ran 12574 tests across 813 files. [453.83s]` |

SHA 일치 확인: 로컬 `d7bac347604bbd2cafcc7653a030f4aa506e577b` = 원격
`refs/heads/codex/compat-multiagent-v2-catalog` = lidge 체크아웃.

첫 실행에서 12 fail / 7 errors 였다. 7 errors는 `gui/` 의존성 미설치(환경)였고,
`cd gui && bun install` 후 사라졌다. 12 fail은 전부 **의미가 뒤집힌 픽스처**로, 감사가
사전에 지목한 목록과 일치했다.

## 뒤집힌 테스트와 처리

| 테스트 | 낡은 전제 | 새 단언 |
| --- | --- | --- |
| `multi-agent-compat` (3건) | `v1` 핀은 로스터에서 제외 | Luna가 `candidates`/`advertised` 에 등장; `disabled` 가 `surface_incompatible` 역할 |
| `native-model-toggle` (2건) | daybreak = 미지의 관측 id | `gpt-future-unlisted` 로 교체 + **관측 없이 전역 행 존재 + sol의 `v2` 상속** 신규 케이스 |
| `codex-catalog` | bare 행 없음 | bare 1개 + 셀렉터당 1개 (**중복 없음** 증명) |
| `codex-models-cache-invalidate` | daybreak = 미지 관측 | `gpt-future-unlisted` 로 교체 |
| `codex-convergence-account-selectors` | 셀렉터 1개만 투영 | **모든 가시 셀렉터** + bare, 각 정확히 1개 |
| `codex-catalog-sync-hardening` (2건) | bare 행 없음 | bare 정확히 1개; 명시적 Codex-forward 커스텀 행은 별개 정체성 유지; API-key alias는 여전히 Codex 표면에 없음 |
| `claude-models-discovery` | 계정한정 행으로 발견 | 관리 API는 **전역 bare 정체성**; Anthropic 표면에는 둘 다 없음(전역 행이 `hide` 로 합성됨) — **실측으로 확인 후** 단언 |

모든 변경 단언은 `some(...)` 가 아니라 **`toHaveLength(1)`** 로 바꿔, 중복 행 회귀가 여기서
잡히도록 했다.

## 예상 밖 발견

Anthropic 디스커버리에서 daybreak가 **양쪽 정체성 모두 사라졌다.** 전역 합성 행은
`visibility: "hide"` 이고, 계정한정 투영은 전역 편입으로 더는 생성되지 않기 때문이다.
추측으로 단언하지 않고 실제 응답을 출력해 확인했다(필터된 id 목록에 `gpt-5.5` 만 존재).
이는 **의도된 결과는 아니지만 무해**하다 — Claude 표면은 Codex 카탈로그에서 가시적인 행만
광고하며, daybreak는 네이티브 OpenAI 경로로 라우팅되기 때문이다. 별도 노출이 필요하면
후속 사이클에서 `visibility` 정책을 다뤄야 한다.

## 열린 채로 남은 것

| 갭 | 사이클 |
| --- | --- |
| G1b — `default` 모드 blanket `v2` 스탬프 (`parsing.ts:409+`, `8a0de6c44` 가 안 고침) | C2 |
| G2 — capability creation path / bridge | C3 |
| G12 — fallback capability class (암호화 NEW_TASK fallback과 얽힘) | C3 |
| G14 — `model_messages.multi_agent` (#38619) | 별도 |

## 프로세스 기록

A 게이트: 리뷰어1과 3라운드(블로커 4+4+5, 전부 소스로 검증 후 반영, 반박 0),
이후 신선한 리뷰어 2명(NEAR-PASS → **PASS**). 리뷰어1이 잡은 결정적 두 건:
(1) `origin/dev` 가 4커밋 앞서 있었고 `8a0de6c44` 가 이 범위와 겹친다는 것 — 리베이스로 해결,
(2) 2판의 "`8a0de6c44` 가 default 스탬프를 재정의했다"는 **내 사실 오류**.

`cxc review-round` 판정 훅은 이 환경에서 리뷰어 종료 시 기록되지 않았다(직전 사이클과 동일).
감사는 실제로 수행되었고 판정 원문은 `orchestrate` attest와 이 문서에 보존한다.

