# 014 — WP1 CI 최종 집계 (정확한 판독법 적용)

`012` 에서 확립한 규칙(`gh pr checks` 대신 Actions API, `status`/`conclusion`
구분)으로 다시 집계했다. **초안 집계와 결과가 다르다.**

## 집계 방법

```bash
sha=$(gh pr view <n> --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)
gh api "repos/lidge-jun/opencodex/actions/runs?head_sha=$sha" \
  --jq '[.workflow_runs[] | select(.name=="Cross-platform CI")]
        | if length==0 then "no-run" else .[0] | "\(.status)/\(.conclusion)" end'
```

`Cross-platform CI` 만 본다. 이것이 실제 테스트를 도는 워크플로다.

## 결과

| PR | Cross-platform CI | 판정 |
|---|---|---|
| #1189 | completed/success | **통과** |
| #1187 | completed/success | **통과** |
| #1184 | completed/success | **통과** |
| #1195 | completed/success | **통과** |
| #1202 | completed/success | **통과** |
| #1169 | completed/success | **통과** |
| #1240 | completed/success | **통과** |
| #1226 | completed/success | **통과** |
| #1224 | completed/success | **통과** |
| #1244 | completed/success | **통과** |
| #1266 | completed/success | **통과** |
| #1249 | completed/**failure** | 아래 참조 |
| #1192 | completed/cancelled | 재실행 필요 |
| #1228 | completed/cancelled | 재실행 필요 |
| #1256 | queued/null | 실행 중 |
| #1264 | queued/null | 실행 중 |
| #1263 | queued/null | 실행 중 |
| #1258 | **no-run** | 새 head의 런 없음 — 승인 필요 |

통과 11건. 초안 집계에서 PASS로 셌던 #1249는 실제로 failure였고, #1258은 런이
아예 없었다. `gh pr checks` 만 봤다면 둘 다 놓쳤다.

## #1249 실패는 코드 결함이 아니다

`test 3/4` 잡의 로그 말미:

```
panic: Segmentation fault at address 0xFFFFFFFFFFFFFFF8
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
...
Illegal instruction (core dumped) bun test --isolate tests ... --shard=3/4
Process completed with exit code 132
```

exit 132는 SIGILL이다. Bun 1.3.14 런타임 크래시이며 테스트 어서션 실패가 아니다.
63초를 정상 실행한 뒤 세그폴트했고, Bun 자체가 "이것은 당신 코드의 버그가
아니다" 라고 출력한다.

**처분: 재실행.** 재현되면 shard 3/4의 특정 테스트와 Bun 버전 조합 문제로
별도 추적한다. #1249의 빈 `data:` 프레임 수정과는 무관하다.

## 다음 행동

1. `#1258` 의 새 head 런 승인 (`010` 파트 1 절차)
2. `#1192`, `#1228` 재실행
3. `#1249` 재실행 후 세그폴트 재현 여부 확인
4. 통과 11건은 머지 승인 대상 — **사용자 승인 필요**

## 이 집계가 확인해 준 것

판독 규칙을 고치지 않았다면 #1249를 통과로 보고하고 머지 후보에 올렸을 것이다.
`gh pr checks` 는 그 PR에 대해 실패를 보여주지 않았다.

동시에 반대 방향 오류도 막았다. #1258은 "체크 없음" 이었는데, 규칙 없이는
"실패 없으니 통과" 로 셌을 것이다. 실제로는 승인이 필요한 상태다.
