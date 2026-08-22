# 011 — C1-P: 위임 자격 조사와 범위 확정 (4판 — 소유자 결정 + A-라운드3 반영)

브랜치 `codex/compat-multiagent-v2-catalog`, `origin/dev`(`8a0de6c44`) 위로 리베이스 완료.
상류 codex-rs `49db349ff`.

> **개정 이력.** 1판: `origin/dev` 가 앞서 있는 것을 놓침 → A-라운드1 FAIL(블로커 4).
> 2판: `8a0de6c44` 반영했으나 **"default 스탬프가 재정의됐다"는 사실 오류**를 넣음
> → A-라운드2 FAIL(블로커 4). 3판: 그 오류 정정 + **소유자 결정으로 daybreak 전역
> 허용목록 추가를 범위에 편입**.

## 소유자 결정 (2026-08-16)

> "전역 허용목록 추가는 해야돼 내 권한이야"

`gpt-daybreak-blue-latest` 를 `NATIVE_OPENAI_MODELS` 에 추가한다. 이전 판들이 "엔타이틀먼트
안전" 을 이유로 거부했으나, 이는 **저장소 소유자의 제품 결정 권한**이다. 내 역할은 거부가
아니라 **안전하게 수행하는 것**으로 바뀐다. 아래 `4가 그 설계다.

## 정정: `8a0de6c44` 가 바꾼 것과 아닌 것

2판은 "`8a0de6c44` 가 default 스탬프를 재정의했다"고 썼다. **틀렸다.** 직접 확인:

```ts
// src/codex/catalog/parsing.ts:403-408  ← 8a0de6c44가 추가한 것 (explicit v2 전용)
if (mode === "v2" && options.keepNativeChatGptOnV1 === true) {
  for (const entry of entries) {
    entry.multi_agent_version = catalogEntryIsNativeChatGpt(entry) ? "v1" : "v2";
  }
  return entries;
}
if (mode === "default") {          // ← :409, 손대지 않음
  ...
  } else if (v2FeatureEnabled) {
    entry.multi_agent_version = "v2";   // ← G1의 blanket 스탬프, 여전히 살아있음
```

즉 `8a0de6c44` 는 **`mode === "v2"` 에만 새 분기를 추가**했고, `default` 모드의 blanket
스탬프(G1)는 **그대로 남아 있다.** 따라서 010의 Change 2는 "이미 해결됨"이 아니라
**여전히 유효한 미해결 갭**이다.

## 세 질문 확정 답

### Q1. 비-OpenAI 라우팅 모델도 v2 위임 대상? → **선택 YES, 전달은 조건부**

**선택 계층(상류):** 벤더 게이트 없음. `find_spawn_agent_model_name`
(`multi_agents_common.rs:431-442`) = slug 완전일치 + `!= Some(Disabled)`.
`ModelInfo`/`ModelPreset` 에 `provider`/`owned_by` 필드 부재. Bedrock 선례
(`amazon_bedrock/catalog.rs:103`).

**그러나 선택 ≠ 시작 ≠ 전달.** 세 단계를 구분한다:

| 단계 | 추가 관문 |
| --- | --- |
| 선택 | `filter_by_auth`(`openai_models.rs:845-854`): 비-ChatGPT 모드는 `supported_in_api` 필요 |
| 자식 시작 | reasoning effort 검증(`multi_agents_common.rs:303-310`), service tier 검증(`:330-381`), role 오버라이드(`role.rs:177-187`), 부모 프로바이더 상속(`:207` — opencodex는 전부 동일 루프백이라 무해, `inject.ts:109`) |
| **태스크 전달** | **암호화 NEW_TASK (opencodex 고유 제약)** |

**암호화 제약:** ChatGPT-네이티브 부모가 v2로 스폰하면 NEW_TASK가 백엔드 암호화되어 라우팅
자식이 못 읽는다(#92). opencodex fail-fast — `src/server/responses/core.ts:1901-1905`.
회귀는 4개 파일에 걸쳐 6개 케이스: `agent-task-recovery.test.ts:56,144,578`,
`agent-task-recovery-security.test.ts:122,171`, `v2-agent-message-failfast.test.ts:161`,
`subagent-fallback-handle-responses.test.ts:835`.

`8a0de6c44` 의 `keepNativeChatGptOnV1` 이 이 문제의 해법이다: Sol/Terra를 v1에 남겨
**Grok/Claude를 스폰할 수 있게** 한다.

### Q2. "서브에이전트 5개" → **모델 광고 창** (A-감사 2회 VERIFIED)

`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5` 소비처 둘: `multi_agents_spec.rs:789`(툴 설명문),
`multi_agents_common.rs:448`(**에러 메시지** 제안 — `.find()` 실패 후). 성공 경로에 cap 없음.

| 수량 | 값 |
| --- | --- |
| 광고 모델 수 | `min(5, picker-visible 자격행)` |
| 자격 모델 수 | 상한 없음 (`disabled` 제외) |
| 동시 서브에이전트 | V1 6(루트 제외) / V2 총 4(루트 포함→자식 3) |

### Q3. daybreak → **전역 허용목록 추가 (소유자 결정), 단 안전장치 포함**

상류 `49db349ff` 에 `daybreak` 0건 — 원격 `/models` 로만 도달. opencodex는 이미
`NATIVE_DAYBREAK_BLUE_MODEL`(`native-models.ts:2`)과 sol 능력 상속(`:11-13`)을 갖고 있고,
`applyMultiAgentMode` 가 sol의 `v2` 를 물려준다(`parsing.ts:381`).

**발견 갭 (인정, 미해결로 남김):** `inject.ts:744` 가 `model_catalog_json` 을 주입하면
codex-rs는 `StaticModelsManager` 를 쓰고 refresh는 no-op(`provider.rs:390`,
`manager.rs:584`). 기존 테스트는 캐시를 **미리 심는다**
(`codex-convergence-account-selectors.test.ts:358-366`) — 즉 캐시→카탈로그 전파만 증명.
**전역 허용목록 추가가 정확히 이 갭을 메운다**: 관측 없이도 행이 존재하게 된다.

## `4. 전역 허용목록 추가 — 안전 설계

`NATIVE_OPENAI_MODELS`(`native-models.ts:29-32`)에 slug를 넣으면 파급되는 곳 전량:

| 소비처 | 효과 | daybreak에 적절한가 |
| --- | --- | --- |
| `SUPPORTED_NATIVE_OPENAI_SLUGS`(`:34`) | bare→계정한정 매핑 허용(`sync.ts:132`) | **의도한 효과** — A-감사 블로커4 해소 |
| `metadata.ts:129` `PINNED_NATIVE_CAPABILITY_ENTRIES` | 능력 메타 fallback | **중복 위험**: 이미 `NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS` 로 들어옴 → union이라 Map 키 충돌은 없으나 검증 필요 |
| `metadata.ts:314` `UPSTREAM_NATIVE_ENTRIES` | sync 중 행 교체 authorize | 주석이 "GPT-5.6 family only" 라고 명시 — **재검토 필요** |
| `vision/reasoning.ts:16` `NATIVE_VISION_MODELS` | 비전 reasoning ladder | daybreak는 text+image 지원(005 증거) → **허용 가능하나 명시 확인** |
| `sync.ts:723,1481,1521` / `convergence.ts:272,317` | backfill/gptSlugs | 행이 무조건 생성됨 → **엔타이틀먼트 없는 계정에 죽은 행** |
| `metadata.ts:86` | disabled 슬러그 suppression | 사용자가 끌 수 있는 escape hatch **이미 존재** |
| `index.ts:975,1042` | 공개 목록/필터 | 정상 |

**안전장치 (필수):**
1. `native-models.ts:15` 의 "never enter the bare allowlist" 불변식 주석을 **정정**한다 —
   이제 daybreak는 양쪽에 있다. 중복이 `PINNED_NATIVE_CAPABILITY_ENTRIES`/
   `UPSTREAM_NATIVE_ENTRIES` 에서 동일 항목을 두 번 만들지 않음을 테스트로 고정.
2. 엔타이틀먼트 없는 계정의 실패 모드를 **테스트로 규명**하고 결과에 따라 결정:
   피커에 죽은 행이면 `visibility: "hide"` 기본값 또는 `disabledModels` 안내를 문서화.
3. `UPSTREAM_NATIVE_ENTRIES` 편입이 sync 중 사용자 행을 덮어쓰지 않는지 확인.

## C1 확정 범위 (4판)

**이 사이클은 "로스터 + daybreak 편입" 사이클이다.** G1(스탬프)·G2·G12는 **열린 채로 남으며**,
000/010이 "Phase 1이 이들을 닫는다"고 주장하는 부분을 **먼저 정정**한다(A-감사 블로커1).

1. `isEligibleV2SubagentEntry`(`sync.ts:105-108`) → `!== "disabled"`. `8a0de6c44` 가 손대지
   않은 **로스터 필터**이며, `keepNativeChatGptOnV1` 정책을 훼손하지 않는다(A-감사 확인).
2. `gpt-daybreak-blue-latest` 를 `NATIVE_OPENAI_MODELS` 에 추가 + `4의 안전장치 3개.
3. 회귀: Luna가 v2 로스터 `candidates` 에 등장.
4. 회귀: 라우팅 비-OpenAI 행이 로스터에 등장(스펠링·`candidates`/`advertised` 명시).
5. 회귀 (daybreak, A-감사 블로커3 반영): **캐시 프리시드 + explicit `v2` 모드 +
   `keepNativeChatGptOnV1: true` + 선택자 한정 slug 설정 → `advertised` 에 등장**을 단언.
   이 조합이라야 행이 `v1` 로 스탬프되어 **로스터 술어를 고치기 전에는 반드시 실패**한다.
6. 회귀: 능력 기반 배제는 `disabled` 뿐.
7. `000_plan.md`/`010` 정정 + `structure/03_catalog-and-subagents.md` 에 5-cap 의미,
   암호화 제약, daybreak 편입 근거 기록.

**별도 사이클로 연기 (열린 갭으로 명시):** 010 Change 2(default blanket 스탬프 — 여전히
미해결), Change 3(creation path), Change 4(fallback capability class — 암호화 fallback과 얽힘).


---

## `4-bis. 전역 허용목록 블래스트 레이디어스 (A-라운드3 반영, 확정)

라운드3 감사가 `4 표에서 누락된 소비처를 잡았다. 확정 전량:

### 새로 활성화되는 동작

| 소비처 | 효과 | 판정 |
| --- | --- | --- |
| `metadata.ts:443` | **모든 가시 계정 셀렉터에 정적 시드** — 관측 없는 셀렉터에도 생성 | **의도한 효과** (소유자 결정) |
| `metadata.ts:395, :479` | "미지의 관측 네이티브"로 더는 분류/보존되지 않음 | 예상됨 |
| `model-rows.ts:50`, `agent-settings-routes.ts:462`, `metadata.ts:233` | `/api/models`, injection-model, subagent, fallback, Claude Code/Desktop, Grok 목록에 등장 | **의도한 효과** |
| `sync.ts:680, :1557`, `parsing.ts:539` | 복구 가능 네이티브가 됨; bare `gpt-*` 로 폐기되지 않음; 계정-숨김 복원 참여 | 예상됨 |
| `combos/types.ts:51, :256` | `nativeAlias: true` 콤보가 daybreak 사용 가능 | 허용 |
| `parsing.ts:353` | `keepNativeChatGptOnV1` 이 명확히 ChatGPT-네이티브로 인식 | **바람직** (암호화 제약과 정합) |
| `vision/eligibility.ts:119` | 비전 **자격**까지 authoritative 네이티브 모달리티로 전환 | 허용 — daybreak는 text+image (005) |
| `vision/reasoning.ts:16` | 비전 reasoning ladder | 허용 |
| `sync.ts:132` | bare→계정한정 매핑 허용 | **의도한 효과** |
| `provider-fetch.ts:1704` | 콤보 멤버 합성에 편입 | 예상됨 |
| `model-rows.ts:59`, `metadata.ts:243` | 관리/Claude 표면에서 daybreak가 **계정한정 발견 → 전역 bare 정체성**으로 전환 | **의도한 효과** (소유자 결정의 핵심) |

### 중복 판정 (감사 결론: 런타임 무해, 단 정리할 것)

`NATIVE_OPENAI_MODELS` 와 `NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS` 양쪽에 들어가지만
`PINNED_NATIVE_CAPABILITY_ENTRIES`(`metadata.ts:129`)/`UPSTREAM_NATIVE_ENTRIES`(`:314`)는
둘 다 `Map` 이라 키 충돌이 하나로 접힌다. 카탈로그 행 생성은 `NATIVE_OPENAI_MODELS` 만
순회하므로 행도 하나다. **단** `tests/codex-catalog.test.ts:2836` 이 `NATIVE_OPENAI_MODELS` 에
daybreak를 **수동으로 덧붙이고** 있어 이제 두 번 들어간다 → 반드시 수정.

**조치:** union을 dedupe하거나 capability-only alias를 globally-supported alias와 분리한다.
테스트는 `Map.size` 가 아니라 **"bare 행 정확히 1개, 셀렉터당 행 정확히 1개"** 를 단언한다.

### 엔타이틀먼트 없는 계정의 실패 모드 (확정, safeguard 2 대체)

감사가 경로를 추적해 규명:

1. 카탈로그 생성은 엔타이틀먼트 검증 없이 성공 → 가시 행 생성.
2. 피커/모델 목록에 표시됨.
3. `routeModel` 이 bare `gpt-*` 를 엔타이틀먼트 확인 없이 수락, 캐노니컬 OpenAI로 포워드
   (`src/router.ts:640` `isBareOpenAiFamilyModel`).
4. ChatGPT 백엔드가 **400 "모델 미지원"** 을 반환. 재시도는 **경로에 따라 갈린다**:
   - **bare 풀 라우트**(고정 계정 아님): 인식된 정확한 400 본문에 한해 **다른 계정 1회** 재시도
     (`core.ts:378, :2471` — `:2471` 은 고정 계정을 명시적으로 제외한다).
   - **셀렉터 한정 행**(`main/gpt-daybreak-blue-latest`): `router.ts:566` 이 **고정 계정
     라우트**를 만들므로 재시도 없이 그 계정의 400을 그대로 릴레이한다.
5. 모두 실패하면 원본 에러 본문/상태를 그대로 릴레이 (`core.ts:2598`).
   **카탈로그 sync 자체는 실패하지 않는다.**

**확정 결론:** `disabledModels`(`metadata.ts:190, :263`, `model-routes.ts:248`)는
**가시성 escape hatch로 충분하지만 런타임 하드 거부는 아니다** — 수동 요청은 여전히 라우팅된다.
이 구분을 `structure/03` 에 명시하고, 미지원 계정의 관찰 가능한 결과는 "피커에 행이 보이고,
선택 시 400" 임을 문서화한다. 이는 소유자 결정의 수용된 트레이드오프다.

**정정:** 이전 판이 `metadata.ts:86` 을 escape hatch로 지목한 것은 틀렸다 — 그것은
네이티브-alias 콤보 활성 시에만 disabled 행을 억제한다. 일반 hatch는 `disabledModels` 다.

### 뒤집히는 기존 테스트 (반드시 재작성, 보강 아님)

| 테스트 | 현재 증명하는 것 | 조치 |
| --- | --- | --- |
| `tests/native-model-toggle.test.ts:145` | "관측된 계정 전용 id는 bare 집합을 확장하지 않는다" | **의미 반전** — daybreak를 다른 관측-전용 slug로 교체 |
| `tests/codex-convergence-account-selectors.test.ts:358` | "bare 행 생성 없이 관측 id 보존" | 재작성 |
| `tests/codex-catalog-sync-hardening.test.ts:390` | 관측 전용 전제 | 재검토 |
| `tests/codex-catalog.test.ts:2836` | `NATIVE_OPENAI_MODELS` 에 daybreak 수동 추가 | **중복 제거** — 나아가 `:2796` 의 "bare 허용목록을 확장하지 않는다" 전제와 bare 행 부재 단언이 **반전**되므로 함께 재작성 |
| `tests/native-model-toggle.test.ts:186` | 관측-전용 전제 | 재작성 |
| `tests/codex-catalog-sync-hardening.test.ts:433` | 관측-전용 전제 | 재작성 |
| `tests/claude-models-discovery.test.ts:380` | Claude 표면의 daybreak 부재 | 재작성 |
| `tests/codex-models-cache-invalidate.test.ts:57` | 캐시 무효화 전제 | 재작성 |

### 회귀 3분할 (감사 지시)

프리시드가 더는 행 생성 요인이 아니므로 항목 5를 셋으로 나눈다:

5a. **관측 없이** 전역 행이 카탈로그에 등장 (신규 동작의 핵심 증명).
5b. 기존 프리시드 경로가 여전히 동작하고 **중복 행을 만들지 않음**.
5c. explicit `v2` + `keepNativeChatGptOnV1: true` + 셀렉터 한정 slug → `advertised` 등장
    (로스터 술어 수정 전에는 반드시 실패).

### `UPSTREAM_NATIVE_ENTRIES` 편입 안전성 (safeguard 3 확정)

감사 확인: 임의의 사용자 행을 덮어쓰지 않는다. `shouldUpgradeToUpstreamEntry` 는
`display_name === slug` 인 **fallback 품질 행만** 업그레이드하고 진짜 이름을 가진 행은
보존한다 (`sync.ts:905-915`). **양쪽 다 테스트한다.**

## 로드맵 정합성 정정 (감사 블로커 4)

`000_plan.md:146` 의 "각 Phase는 하나의 PABCD 사이클" 문장이 010의 다중 사이클 수정과
충돌한다. Phase 1 아래 **C1/C2/C3** 를 명시한다:

- **C1 (이 사이클):** 로스터 술어(G1a) + daybreak 전역 편입.
- **C2:** default blanket 스탬프(G1b) — `8a0de6c44` 의 explicit-v2 정책 위에서 재설계.
- **C3:** creation path(G2) + fallback capability class(G12) — 암호화 fallback과 얽힘.

## 사소 정정

암호화 회귀는 **4개 파일에 7개 단언 앵커**이며, `agent-task-recovery-security.test.ts:153` 이
헤더 2종으로 파라미터화되어 **런타임 케이스는 8개**다.
