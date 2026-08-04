# 091 — wp 결과: 원격 PR 랜딩 라운드 2 (DONE)

계획: `090_wp_pr_landing_round2.md`. PABCD 1사이클, 터미널 결과 **DONE**.

## 랜딩 결과

| PR | 스쿼시 커밋 | 성격 |
|----|-------------|------|
| #575 | `fff8c369f` | TLS 호스트명 불일치 구분 + 자격증명 리다ekt |
| #652 | `48f2e8362` | bounded model discovery contract |
| #711 | `d24c5233f` | data-only Responses SSE 수용 |

`origin/dev`: `c4b05fa89` → `48f2e8362` → (#711) 전진.

## 성공 기준 판정

| # | 기준 | 결과 | 증거 |
|---|------|------|------|
| 1 | 사용자 #710 작업분 무손상 | PASS | 머지 3회 전후 `git status` 파일목록 비교. 감소분은 사용자 본인 커밋 `14d58ec1d`이며 우리 머지와 무관 |
| 2 | #575 머지 | PASS | `state=MERGED`, `fff8c369f` |
| 3 | #652 머지 | PASS | `state=MERGED`, `48f2e8362` |
| 4 | 머지 후 dev 건전성 | PASS | 별도 워크트리(`origin/dev` detached): `tsc --noEmit` rc=0, `bun test` 151 pass / 0 fail, `privacy:scan` green |
| 5 | #553 미클로즈 | PASS | `state=OPEN` 확인 |
| 6 | #711 처리 | PASS | windows 재실행 `pass` 전환 → 10/10 green → 머지 |

## #711 windows 판정의 교훈 (재확인)

라운드 1이 기록한 "`gh pr checks`의 fail이 실제로는 cancelled"가 이번에 실증됐다.
`gh api .../check-runs`에서 `conclusion=cancelled`를 확인하고 `gh run rerun --failed`를
걸었더니 그대로 통과했다. **`gh pr checks`의 fail 표시만으로 코드 실패를 단정하면 안 된다** —
`conclusion` 필드를 직접 확인하는 절차를 후속 라운드에서도 유지한다.

대비: #610은 같은 방법으로 확인했을 때 진짜 Test 스텝 실패(`EEXIST: epoll_ctl`)였고,
Luna 레인 조사에서도 대응하는 Bun 이슈를 찾지 못했다. 알려진 회귀로 단정하지 않고
별도 조사 대상으로 남긴다.

## 열어둔 것 (의도적)

- **#553** — #575가 오류 표시만 개선하고 TLS 가로채기 자체는 프록시 밖. 오너가 PR 본문과
  이슈 코멘트 양쪽에 "이 PR로 닫히지 않는다"고 명시.
- **#572** — 우산 이슈. #652는 phase 1이고 #653(Baseten) 등 후속 PR이 남았다.
- **#700** — #711 본문에 자동 클로즈 키워드가 없어 열린 상태. 다음 라운드에서 확인 후 처리.

## 이번 사이클에서 하지 않은 것

`git push` 없음 (LOOP-GIT-01 / DEV-GIT-PUSH-01). GitHub 측 머지는 `gh pr merge`로
원격에서 직접 수행했고, 로컬 브랜치를 원격에 밀어넣은 적은 없다. 이전 세션의 문서 커밋
`aa2220726`은 여전히 미푸시 상태로 남아 있다.

## 다음 work-phase 후보

1. **#700 클로즈 판정** — #711이 실제로 해결했는지 확인 후 처리 (가장 저렴)
2. **#646** — `cursor/kimi-k3`. draft + CHANGES_REQUESTED. 필요한 것은
   `modelDefaultReasoningEfforts: { "kimi-k3": "max" }` 한 줄과 docs-site Cursor 커버리지 갱신.
   Moonshot 공식 기본값이 `max`이고 다른 K3 경로는 이미 이 값을 갖고 있다.
3. **#653** — Baseten preset. 선행 #652가 랜딩됐으므로 이제 CI 재실행 가치가 있다.
4. **#696** — Windows tray Run 값 260자 초과. 미수정 확인됨. 신고자가 493자 실측값 제공.
