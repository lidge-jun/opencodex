# 013 — "다섯 개가 v2에서도 동일하게 노출되는가" 확정 답변

사용자 질문에 대한 P-단계 조사. 상류 `49db349ff`, opencodex `bf97f4bd0` 기준.
원자료: `.tmp/research3/J_five_cap_v2.md` (gitignored). 서브에이전트 조사 + 메인 직접 검증.

## 한 줄 답

**상한 숫자 5는 V1/V2 동일하지만, 그 5개를 고르는 창(window)의 내용은 다르다.**

## 왜 다른가 — 필터가 cap보다 먼저 적용된다

`spawn_agent_models_description` (`multi_agents_spec.rs:785-790`) 순서:
`show_in_picker` 필터 → `model_supports_multi_agent_backend` 필터 → `.take(5)`.

두 번째 필터가 표면에 따라 다르게 동작한다 (`multi_agents_common.rs:36-42`):

```rust
multi_agent_version != MultiAgentVersion::V2
    || model.multi_agent_version != Some(MultiAgentVersion::Disabled)
```

- **V1 호출**: 좌변이 참이라 **모든 행이 통과**한다 — `Disabled` 조차 포함된다.
- **V2 호출**: `Some(Disabled)` 만 제외된다.

제외된 행이 있으면 **뒤 행이 5칸 안으로 밀려 들어온다.** 그래서 같은 카탈로그가 두 표면에서
다른 목록을 만든다.

### 구체 예 (모두 picker-visible, 이 순서)

| # | 모델 | `multi_agent_version` |
| ---: | --- | --- |
| 1 | `v2-a` | `V2` |
| 2 | `disabled-a` | `Disabled` |
| 3 | `v1-a` | `V1` |
| 4 | `null-a` | `None` |
| 5 | `v2-b` | `V2` |
| 6 | `disabled-b` | `Disabled` |
| 7 | `null-b` | `None` |

- **V1 광고**: `v2-a, disabled-a, v1-a, null-a, v2-b`
- **V2 광고**: `v2-a, v1-a, null-a, v2-b, null-b`

## 그 외 V1/V2 차이

| 항목 | V1 | V2 | 근거 |
| --- | --- | --- | --- |
| 목록 게이트 | `hide_agent_type_model_reasoning` — 실제 등록이 `false` 로 고정하므로 **항상 광고** | `expose_spawn_agent_model_overrides` — 이것이 진짜 게이트 | `multi_agents_spec.rs:67-70` / `:102-105`; `spec_plan.rs:1200-1207` / `:1150-1160` |
| 그 플래그 기본값 | (V1에선 불활성) | **`true`** (`MultiAgentV2Config` 기본) | `config/mod.rs:1229-1255`, `:2650-2655` |
| 게이트 off일 때 | 해당 없음 | 목록 생략 + `model`/`reasoning_effort` 스키마에서 제거 | `multi_agents_spec.rs:103-119` |
| `service_tier` | 노출 | `hide_spawn_agent_metadata` 기본 true → 제거 | `config/mod.rs:1242-1243` |
| 성공 경로 검증 | 전체 카탈로그, cap/visibility 없음 | 동일 + `Disabled` 만 거부 | `multi_agents_common.rs:431-442` |

**5는 여전히 "광고 + 실패 에러 메시지"에만 쓰인다** (`multi_agents_spec.rs:789`,
`multi_agents_common.rs:448`). 5위 밖 모델도 이름만 맞으면 수락된다. 동시 실행 수(V1 6,
V2 총 4 → 자식 3)와는 **무관**하다.

## opencodex 패리티: 이미 맞다

`effectiveSubagentRoster` (`src/codex/catalog/sync.ts:157-188`)의 필터가
`surface !== "v2" || isEligibleV2SubagentEntry(entry)` 이므로 **V1은 자격 필터를 건너뛴다** —
상류 V1이 모든 행을 통과시키는 것과 정확히 같다. C1에서 `isEligibleV2SubagentEntry` 를
`!== "disabled"` 로 고친 결과, V2 쪽도 상류와 일치한다.

또한 opencodex는 **V1 표면에 로스터를 주입하지 않는다** (`collaboration.ts:368-372` — 최상위
effort에서 proactive 텍스트만). 즉 V1 목록의 권위는 상류 툴 설명문이고, 우리가 개입하지 않는다.

## 기각한 주장: `modelPickerOrder` "실버그"

서브에이전트가 `effectiveSubagentRoster` 가 `SPAWN_PRIORITY_FIELD`(자연 우선순위)로 정렬해
상류의 재작성된 `priority` 창과 달라진다며 **실버그**라고 보고했다. **기각한다.**

이는 **이슈 #1649의 의도된 설계**다:

- `sync.ts:70`: "modelPickerOrder is a **DISPLAY-ONLY**" 
- `sync.ts:622-624`: "modelPickerOrder is a DISPLAY-ONLY override. Record the natural priority
  spawn_agent must keep using"
- `sync.ts:174-176`: "so a modelPickerOrder display reorder (#1649) **can never change candidate
  membership**"
- `sync.ts:477`: "Independent of the 5-slot spawn_agent cap"

그리고 **기존 테스트가 이 동작을 계약으로 고정**하고 있다
(`tests/codex-catalog-model-picker-order.test.ts`):
`"picker-order-only rows do not displace default-tier spawn_agent candidates"` (`:113`),
`"candidate set is unchanged when all routed rows are listed in reverse order"` (`:176`).

서브에이전트가 관찰한 "발산"은 실재하지만 **그것이 이 기능의 목적**이다: 사용자가 피커 표시
순서를 바꿔도 스폰 후보 집합은 흔들리지 않게 하는 것. 상류 창과 다른 것은 알려진 트레이드오프이지
회귀가 아니다. 커밋 `088997364` 참조.

**교훈:** 상류 대조만으로 "버그"를 판정하면 안 된다. 로컬 설계 의도(주석·이슈·테스트)를 먼저
확인해야 한다.

## 결론: 코드 변경 없음 (문서화 레이어)

이 질문에 대해 opencodex가 고칠 것은 **없다.** V1/V2 창 차이는 상류 의미이며 opencodex는 이미
표면별로 올바르게 동작한다. 산출물은 `structure/03_catalog-and-subagents.md` 문서화다.

