# chase — 개요

## 한 줄

**chase** = opencodex가 세 upstream 대비 **아직 안 따라온** 영역 + **무엇을 어떻게 따라갈지**의 참조 방안.
jawcode `struct_har/chase`와 동형 — 단, opencodex는 이미 jawcode 포팅을 끝냈고 별도
`structure/`(patched SoT)가 있으므로 무거운 form-snapshot 트리는 두지 않고 **행동 레이어만** 둔다.

## form vs action 역할 분담 (jawcode struct_har ↔ chase 대응)

| form (스냅샷) | action (행동) |
|---|---|
| `10_jawcode.md` · `20_cli-proxy-api.md` · `30_litellm.md` | `01_overview` · `02_gap_inventory` · `03_follow_index` |
| upstream 규모·HEAD·wire 대조 정본 | 갭·다음에 볼 경로·완료 기준·우선순위 |
| 분석 시 수동 갱신 (HEAD 박기) | fetch·diff·상태 재평가 |

opencodex에는 jawcode의 `gjc_origin/`·`jwc_patched/` 밴드 트리에 해당하는 게 `src/`(코드 정본)와
`structure/`(아키텍처 SoT)다. 그래서 chase는 그 위에 **갭 추적**만 얹는다.

## 갭 4종 (opencodex 맞춤)

| 종류 | 설명 | 주 upstream |
|---|---|---|
| **G1 jawcode drift** | jawcode가 새 provider/모델을 추가해 opencodex가 뒤처짐 | jawcode |
| **G2 cca hardening** | CLIProxyAPI가 wire/auth/replay를 더 깊게 처리 | cli-proxy-api |
| **G3 catalog/longtail** | litellm 모델 맵·openai-호환 롱테일 provider 커버리지 | litellm |
| **G4 opencodex-only** | opencodex가 앞서거나 유일한 영역 (kiro·codex WS·구독 IDE 백엔드) | — |

## 상태 어휘

`⬜` 미착수 · `🟡` 부분/설계 · `✅` opencodex 선행 또는 포팅 완료 · `—` 범위 밖

## 우선순위 (착수)

1. **G1 선별** — jawcode HEAD 신규(`deepinfra`)·`models.json` delta 동기화 (저비용)
2. **G2 깊이** — antigravity replay 깊이(136→667 대조), vertex OAuth, xai WS
3. **G3 카탈로그** — litellm 컨텍스트 윈도우/가격 교차검증, openai-호환 롱테일
4. **G1 고비용** — `cursor` agent 어댑터 (별도 work-phase)

세부는 `02_gap_inventory.md`, 실행 순은 `03_follow_index.md`.

## worktree에서 갭 검증 (스니펫)

카드가 "⬜ gap"이라 쓸 때, 먼저 opencodex에 이미 있는지 grep으로 확인한다.

```bash
# cursor 어댑터 (G1)
ls src/adapters/ | grep -i cursor
# deepinfra (G1) — jawcode HEAD 신규
rg -i 'deepinfra' src/providers/registry.ts
# vertex OAuth (G2) — opencodex는 key/ADC만
rg -il 'vertex.*oauth' src/oauth/
# antigravity replay 깊이 (G2)
wc -l src/adapters/google-antigravity-replay.ts
```

## 읽기 순서

1. `00_parity-index.md` — 세 HEAD 기준선
2. 이 문서 — 갭 분류·우선순위
3. `02_gap_inventory.md` — 축별 요약
4. `03_follow_index.md` — 실행 순서
5. `10_/20_/30_` — upstream별 상세
