# 010 — WP1: CI 승인 해제 + 무충돌 소형 13건 재발행

선행: WP0(이 문서군). 절차: `003_republish_protocol.md`.

## 왜 이것이 첫 구현 phase인가

CI 승인이 풀리지 않으면 어떤 재발행 PR도 green을 증명할 수 없고, 준비완료 게이트를
통과할 수 없다. 나머지 모든 phase가 이 결과를 소비한다.

## 파트 0 — 라이브 갱신 게이트 (필수 선행)

dev가 캠페인 중에 세 번 움직였다(`ec8ceef00`, `a259d63dc`, `d55b903d8`). PR
#1257은 `db371021c` 로 머지되어 열린 집합에서 빠졌다. 따라서 WP1 착수 직전에
반드시 다시 확인한다.

```bash
git fetch origin dev
git rev-parse origin/dev

# 제목 접두사 AND 라벨 양쪽으로 조회한다 (감사 라운드 3 블로커 1)
gh pr list --repo lidge-jun/opencodex --state open --limit 100 \
  --json number,title,labels,baseRefName,state \
  --jq '.[] | select((.title | test("^fix|^test")) or (.labels | map(.name) | any(. == "bug")))'

gh run list --repo lidge-jun/opencodex --status action_required --limit 400 \
  --json databaseId,headBranch
```

**이슈도 함께 갱신한다 (감사 라운드 4 블로커 2).** PR만 갱신하면 이미 닫힌
이슈에 대해 코드 작업이나 close 액션을 수행하게 된다.

```bash
# 재발행 후보의 head SHA를 반드시 확보한다 (감사 라운드 7 블로커 1)
gh pr list --repo lidge-jun/opencodex --state open --limit 100 \
  --json number,title,headRefOid,updatedAt \
  --jq '.[] | "\(.number)\t\(.headRefOid)\t\(.updatedAt)\t\(.title)"'

# 라벨로 걸러 캠페인 모수와 직접 비교한다 (전체 64건을 훑지 않는다)
gh issue list --repo lidge-jun/opencodex --state open --limit 200 \
  --json number,title,labels \
  --jq '.[] | select(.labels | map(.name) | any(. == "bug" or . == "provider-compatibility")) | "\(.number)\t\(.title)"'

# WP5/WP6이 건드릴 이슈의 개별 상태를 확인한다
for n in 1245 1236 1230 1229 1222 1219 1213 1196 1176 1162 1145 1128 1059 1024 904 796 418 417 241 92; do
  gh issue view $n --repo lidge-jun/opencodex --json number,state --jq '"#\(.number) \(.state)"'
done
```

**통과 조건 (PR과 이슈 모두에 적용):**

1. 위 라벨 필터 결과를 `001_inventory.md` 의 이슈 표와 대조한다. 표에 없는
   번호가 하나라도 나오면 **작업을 시작하지 않는다.** 먼저 처분을 배정하고
   `001`과 `002`에 기록한 뒤 진행한다
2. 상태가 바뀐 이슈(OPEN에서 CLOSED로, 또는 그 반대)도 같은 처리를 한다.
   종결된 이슈에는 코드 작업도 close 액션도 보내지 않는다
3. 새 PR도 동일하다. 처분 없는 항목이 있는 채로 실행하지 않는다
4. **CI 상태는 두 조회를 함께 쓴다.** `gh pr checks <n>` 는 `action_required` 런을
   표시하지 않으므로, 승인 대기와 런 부재가 구분되지 않는다. 반드시
   `gh api "repos/lidge-jun/opencodex/actions/runs?head_sha=<headSha>"` 로 실제
   런과 `conclusion` 을 확인한다. green은 **CI 런이 존재하고 결론이 success** 인
   경우뿐이다
5. **각 재발행 후보의 `headRefOid` 를 `002` 에 기록된 커밋과 대조한다.**
   SHA가 다르면 그 PR의 작업을 **중단하고** 새 diff를 다시 읽는다. 파일 맵,
   활성화 테스트, 보안 범위를 재검토한 뒤에야 진행한다

### 왜 SHA 대조가 별도 조건인가

제목·라벨·base·state가 모두 그대로여도 기여자가 head를 갱신할 수 있다. 그러면
우리가 검토한 커밋은 더 이상 그 PR의 내용이 아니다. 낡은 커밋을 리베이스하면
기여자의 최신 작업을 되돌리는 셈이 된다.

실제로 감사 라운드 7에서 이 일이 일어났다. #1266의 head가 `ae28b69ef` 에서
`c0ffaef64` 로 바뀌었고(2026-08-08T06:21:28Z), 다른 게이트 조건은 하나도 변하지
않아 통과했을 것이다.

이것은 과거 캠페인에서 학습한 실패 유형이기도 하다. `updatedAt` 은 저자 활동의
증거가 아니며, 정확한 원격 SHA만이 무엇을 리베이스하는지 확정한다.

이 조건이 이 게이트의 존재 이유다. 라이브 상태는 계속 움직이므로 문서를 고정된
시점에 얼려두는 대신, 실행 직전에 차이를 흡수한다. 실제로 감사 중에만 #1263,
#1264, #1265, #1266이 새로 생겼고 #1255, #1257이 머지됐으며 이슈 3건이 닫혔다.

**이미 종료된 이슈 (2026-08-08 확인):**

| 이슈 | 상태 | 영향 |
|---|---|---|
| #1100 | CLOSED 02:14:24Z | WP6 close 대상에서 제외. 이미 처리됨 |
| #1102 | CLOSED 02:14:44Z | WP6 close 대상에서 제외. 이미 처리됨 |
| #1218 | CLOSED 03:40:15Z | WP5 050-5 재검토. 외부에서 종결됨 |

세 건 모두 이 캠페인 밖에서 종결됐다. WP5/WP6의 해당 항목은 실행하지 않는다.
독립적인 코드 근거가 여전히 수정을 요구하는 경우에만 새 이슈로 다시 연다.

제목만으로 거르면 `bug` 라벨이 붙었지만 제목이 다른 PR을 놓친다. 실제로 감사
라운드 3에서 이 방식으로 #1264와 #1265를 놓쳤다.

확인 항목:

1. 대상 PR이 아직 열려 있는가 (머지·종료된 것은 제외)
2. 새로 열린 버그 PR이 있는가 (있으면 처분 배정 후 진행)
3. `baseRefName` 이 `dev` 인가. `main` 타겟은 릴리스 경로이므로 이 캠페인
   범위 밖으로 분류한다 (#1265가 그 예)
4. `002` 문서의 file:line 인용이 현재 head에서 유효한가

이 게이트를 통과하지 않은 재발행은 무효다. 낡은 base 위에서 리베이스하면 그
자체가 다시 낡은 PR이 된다.

**#1257 제외 확정:** `fix(gui): Cursor OAuth accounts stay visible` 는
2026-08-08T05:50:40Z에 `db371021c` 로 머지됐다. 재발행하지 않는다.

## 파트 1 — CI 승인 해제

열린 PR의 **현재 head SHA**에 속한 `action_required` 런만 승인한다. 전량 승인은
하지 않는다 — 대부분 이미 머지됐거나 버려진 브랜치다.

**브랜치 이름으로 고르면 안 된다 (감사 라운드 6).** force-push는 브랜치 이름을
유지한 채 SHA만 바꾸므로, 브랜치 교집합으로 승인하면 **이미 대체된 커밋의 런을
승인**하게 된다. 이 캠페인이 막으려는 바로 그 실수다.

SHA 대조로 선별한다:

```bash
REPO=lidge-jun/opencodex
LEDGER=/tmp/ocx_approval_ledger.tsv

for n in <대상 PR 번호들>; do
  sha=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid)

  # 그 SHA의 승인 대기 런만 고른다
  for rid in $(gh api "repos/$REPO/actions/runs?head_sha=$sha" \
      --jq '.workflow_runs[] | select(.conclusion=="action_required") | .id'); do

    # 승인 직전 재확인: 런의 head_sha와 PR의 현재 head를 다시 읽어 대조한다
    run_sha=$(gh api "repos/$REPO/actions/runs/$rid" --jq .head_sha)
    now_sha=$(gh pr view "$n" --repo "$REPO" --json headRefOid --jq .headRefOid)
    if [ "$run_sha" != "$now_sha" ]; then
      printf '%s\t%s\t%s\tSKIP head moved %s -> %s\n' "$rid" "$n" "$run_sha" "$run_sha" "$now_sha" >> "$LEDGER"
      continue
    fi

    # 응답 상태까지 기록한다
    code=$(gh api --include -X POST "repos/$REPO/actions/runs/$rid/approve" 2>&1 | head -1)
    printf '%s\t%s\t%s\t%s\n' "$rid" "$n" "$run_sha" "$code" >> "$LEDGER"
  done
done
```

조회와 승인 사이에도 기여자가 push할 수 있으므로 재확인이 필수다. 건너뛴 항목도
사유와 함께 원장에 남긴다.

**승인 후 확인은 Actions API로 한다.** `gh pr checks` 는 `action_required` 런을
표시하지 않으므로 전이를 관찰할 수 없다:

```bash
gh api "repos/$REPO/actions/runs/$rid" --jq '"\(.id) \(.name) status=\(.status) concl=\(.conclusion)"'
```

**`status` 와 `conclusion` 은 다른 필드다.** `queued`/`in_progress` 는 `status`
값이고, 그때 `conclusion` 은 `null` 이다. 실제로 승인 직후 Cross-platform CI 런
`31245339885` 은 `status=queued, conclusion=null` 이었다.

판정 기준:

| 관찰 | 의미 |
|---|---|
| `status` 가 `queued` 또는 `in_progress`, `conclusion` 이 `null` | 승인 반영됨, 실행 중 |
| `status=completed`, `conclusion=success` | 통과 (조회 전에 끝난 경우) |
| `status=completed`, `conclusion=action_required` | **아직 미승인** |
| `status=completed`, 그 외 conclusion | 실패한 런 |

대상 27건: #1264 #1263 #1260 #1259 #1258 #1256 #1249 #1244 #1240 #1235 #1228
#1226 #1224 #1212 #1210 #1209 #1205 #1202 #1195 #1192 #1189 #1187 #1185 #1184
#1178 #1169 #1109 #1010.

(#1257은 머지되어 제외. #1263은 감사 라운드 2, #1264는 라운드 3에서 추가.
#1265는 `main` 타겟이라 이 목록에 없다.)

수용 기준: 위 PR들의 런이 Actions API 조회에서 `conclusion=action_required` 를
벗어나 `status` 가 `queued`/`in_progress`(`conclusion=null`)이거나 이미
`completed`+`success` 인 상태가 되고, `/tmp/ocx_approval_ledger.tsv` 에 런 ID·PR·
head SHA·응답이 기록된다. `gh pr checks` 로는 이 전이를 관찰할 수 없다.

## 파트 2 — 무충돌 소형 13건 재발행

아래 13건은 서로 파일이 겹치지 않는다. 스택이 아니라 각각 `origin/dev` 에서
분기한 독립 PR이다.

구성: 010-1 ~ 010-9(초안 9건), 010-10 ~ 010-12(감사 라운드 2 추가),
010-13(감사 라운드 3 추가).

### 010-1 · #1189 history index stream tail

원작자 `luvs01 <27862058+luvs01@users.noreply.github.com>`
원본 브랜치 `luvs01:agent/fix-history-index-stream-tail`
원본 커밋 `6e7269d05`, `d5242a231`
새 브랜치 `codex/260808-history-index-stream-tail`

MODIFY `src/routing/history/indexer.ts`

현재 `:195-196`:

```ts
const length = size - fromOffset;
const buffer = Buffer.allocUnsafe(length);
```

`:266` 이 미인덱스 tail 전체를 이 경로로 보낸다. 원장이 커지면 시작 시 그 크기만큼
단일 할당이 일어난다.

변경: 고정 크기 청크 반복 읽기로 대체하고, 청크 경계에 걸친 부분 라인은 다음
반복으로 이월한다. 기존의 부분 라인 오프셋 규칙을 유지해야 인덱스 정확도가 보존된다.

MODIFY `tests/request-history-index.test.ts` — 청크 경계에 라인이 걸치는 픽스처와
대용량 tail에서 상한 할당이 지켜지는지 확인.

활성화 증거(C-ACTIVATION-GROUNDING-01): 청크 경계 분할 케이스를 구동하는 테스트가
실제로 이월 분기를 타는지 확인한다. 단순 green이 아니라 그 분기가 발화해야 한다.

### 010-2 · #1187 routing analytics malformed attempts

원작자 `luvs01 <27862058+luvs01@users.noreply.github.com>`
원본 브랜치 `luvs01:agent/fix-routing-analytics-malformed-attempts`
원본 커밋 `8b413ac50`
새 브랜치 `codex/260808-routing-analytics-malformed`

MODIFY `src/routing/analytics.ts`

현재 `:153-154`:

```ts
const attempts = attemptsOf(entry) ?? [];
... attempt.recoveryKinds.some(...)
```

`attempts` 가 배열이 아니거나 개별 attempt가 기대 형태가 아니면 throw. 분석
읽기가 손상된 JSONL 한 줄로 전체 실패한다.

변경: `Array.isArray` 로 컨테이너를 검증하고, 각 attempt에 대해 `recoveryKinds` 가
배열인지 확인한 뒤 순회한다. 검증 실패 행은 건너뛰되 나머지 행 처리는 계속한다.

MODIFY `tests/routing-analytics.test.ts` — 비배열 `attempts`, 비객체 attempt,
`recoveryKinds` 누락 세 케이스.

활성화 증거: 손상 행이 실제로 skip 분기를 타고, 같은 파일의 정상 행은 여전히
집계된다는 것을 어서션으로 확인.

### 010-3 · #1184 command-code own-property lookups

원작자 `luvs01 <luvs01@hanmail.net>`
원본 브랜치 `luvs01:agent/fix-command-code-own-lookups`
원본 커밋 `cc01ba04e`
새 브랜치 `codex/260808-command-code-own-lookups`

MODIFY `src/adapters/command-code.ts` — `:321`, `:350` 의
`COMMAND_CODE_MODEL_ALIASES` 직접 인덱싱
MODIFY `src/providers/command-code-efforts.ts` — `:34`, `:62` 의 객체 테이블 인덱싱

`constructor`, `toString`, `__proto__` 같은 모델 ID가 상속 속성으로 해석되어
통과하지 못하고 엉뚱한 값을 얻는다.

변경: 네 지점 모두 `Object.hasOwn(table, key)` 확인 후 접근.

MODIFY `tests/command-code-provider.test.ts` — `constructor`, `toString`,
`hasOwnProperty` 를 모델 ID로 넣어 통과(pass-through)를 확인.

활성화 증거: 가드가 없으면 red가 되는 케이스여야 한다. 먼저 가드를 빼고 red를
확인한 뒤 넣는다.

### 010-4 · #1258 reasoning-effort trace hydration bound

원작자 `luvs01 <luvs01@hanmail.net>`
원본 브랜치 `luvs01:agent/fix-reasoning-effort-hydration-bound`
원본 커밋 `1af3b74de`
새 브랜치 `codex/260808-trace-hydration-bound`

MODIFY `src/routing/trace.ts`

현재 `:468-474` 가 잘라낸 접두부만 검증한 뒤 `:470` 에서
`raw.reasoningEfforts.some(...)` 로 전체 영속 배열을 순회한다. 검증 범위와 순회
범위가 어긋나 있다.

변경: 보존 대상인 8개 항목만 읽고 검증한다. sparse hole(구멍 뚫린 인덱스)도 거부.

MODIFY `tests/route-decision-trace.test.ts` — 8개 초과 배열, sparse 배열.

### 010-5 · #1256 usage startup hydration tail bound

원작자 `luvs01 <luvs01@hanmail.net>`
원본 브랜치 `luvs01:agent/fix-usage-tail-bound`
원본 커밋 `501178956`
새 브랜치 `codex/260808-usage-tail-bound`

MODIFY `src/usage/log.ts`

현재 `:658-664` 는 주석으로 "파일 전체까지" 확장한다고 명시하며
`Buffer.alloc(size - start)` 를 호출하고, `:671` 이 창을 `size` 까지 키운다.

변경: 64 MiB 상한을 도입해 그 이상은 읽지 않는다. 상한에 걸리면 가장 최근
구간만 취한다.

MODIFY `tests/usage-log.test.ts` — 상한 초과 원장에서 할당이 상한 이하인지 확인.

활성화 증거: 상한 분기가 실제로 발화하는 크기의 픽스처를 써야 한다. 작은 파일만
테스트하면 이 분기는 죽은 채로 남는다.

### 010-6 · #1195 unbound account quota evidence

원작자 `luvs01 <27862058+luvs01@users.noreply.github.com>`
원본 브랜치 `luvs01:agent/fix-unbound-quota-evidence`
원본 커밋 `e555f7b44`, `6eff3f6a5`
새 브랜치 `codex/260808-unbound-quota-evidence`

MODIFY `src/router.ts` — `:516-529`(프로세스 활성 Codex 계정 주입),
`:531-533`(활성 Anthropic 계정 주입)
MODIFY `src/server/management/routing-profile-routes.ts` — `:118-135` 의 동일 동작

미바인딩 계정에 활성 계정을 대체 주입하면, 쿼터 근거가 없는 상태가 근거 있는
것처럼 보인다.

변경: 두 경로 모두에서 대체 주입을 제거하고 명시적 계정 근거만 사용한다. 근거가
없으면 unknown으로 남긴다.

MODIFY `tests/quota-scoring.test.ts` — 미바인딩 계정이 unknown으로 남는지, 라이브
경로와 dry-run 경로가 동일하게 동작하는지.

### 010-7 · #1202 history lock false positive

원작자 `Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>`
원본 브랜치 `Yuxin-Qiao:fix/1191-history-lock-false-positive`
원본 커밋 `d30ad97ab`, `fe1d1e539`, `e9d58d805`, `44b0a04b6`
새 브랜치 `codex/260808-history-lock-false-positive`
해소 이슈 **#1191**

두 개의 독립 결함이다.

진단 문구 수렴: `src/codex/inject.ts:1036-1041`, `:1261-1263`,
`src/cli/index.ts:900-903` 이 모든 history 실패를 "DB locked" 로 보고한다. 원인이
무엇이든 같은 문구가 나와 사용자가 오진한다.

Windows 경로 동일성: `src/codex/history-lock.ts:184-187` 이
`realpathSync.native(databasePath) !== databasePath` 일 때 거부하는데,
`src/codex/user-identity.ts:157-163` 이 정규화되지 않은 Windows 루트를 반환한다.
대소문자나 8.3 축약이 다르면 정상 경로가 거부된다.

변경: 실패 원인을 분리해 각각의 문구로 보고하고, Windows에서는 대소문자 무시
비교를 사용한다.

MODIFY `tests/codex-history-job.test.ts`, `tests/codex-user-identity.test.ts`
NEW `tests/codex-inject-history-wording.test.ts` — 현재 dev에 없다. 원본 PR이
새로 만드는 파일이다. 픽스처: lock이 아닌 실패(권한 거부, 파일 부재, 손상 DB)를
주입하고 각 문구가 서로 다른지 어서션.

활성화 증거: lock이 아닌 실패(권한 오류 등)를 주입해 새 문구가 실제로 출력되는지
확인한다. 전부 green만으로는 문구 분리를 증명하지 못한다.

### 010-8 · #1169 codex-shim readiness warning

원작자 `TyroneXie <328347833@qq.com>`
원본 브랜치 `TyroneXie:agent/codex-shim-readiness-warning`
원본 커밋 `d8968b7e6`
새 브랜치 `codex/260808-codex-shim-readiness`

MODIFY `src/cli/codex-shim-readiness.ts` (NEW), `src/cli/index.ts:1151-1155`

현재는 `r.installed` 만으로 green을 출력한다. Codex가 실제로 OpenCodex를 경유하는지,
프록시 설정이 백그라운드 실행 후에도 유지되는지 확인하지 않는다.

변경: 읽기 전용 경고를 추가하되 설치 성공 동작 자체는 유지한다. **프로브가 throw해도
정상 설치를 실패로 만들면 안 된다** — 원본 리뷰에서 지적된 지점이므로 프로브 전체를
try/catch로 감싼다.

NEW `tests/codex-shim-readiness.test.ts` — 현재 dev에 없다. 원본 PR이 새로 만드는
파일이다. 픽스처: (a) 라우팅이 증명되지 않은 설치에서 경고가 출력되는지,
(b) 프로브가 throw해도 설치가 성공으로 보고되는지.

### 010-9 · #1192 bounded synthesized SSE expansion

원작자 `luvs01 <27862058+luvs01@users.noreply.github.com>`
원본 브랜치 `luvs01:agent/fix-bounded-json-sse-expansion`
원본 커밋 `b50f23943`
새 브랜치 `codex/260808-bounded-sse-expansion`

MODIFY `src/server/responses-json-events.ts` — `:24-38`(항목당 프레임 배열 생성),
`:49-51`(전부 join)
MODIFY `src/server/responses/core.ts` — `:2452` 가 그 전체 본문을 반환
MODIFY `structure/04_transports-and-sidecars.md`

출력 항목이 많으면 모든 프레임이 한 문자열로 합쳐져 메모리에 올라간다.

변경: 항목 수에 상한을 두고 HTTP 프레임을 스트리밍한다.

**리베이스 주의:** 유일한 충돌이 `structure/04_transports-and-sidecars.md` 의 2줄
추가다. 현재 dev 문서 텍스트와 새 텍스트를 **양쪽 다 보존**한다.

MODIFY `tests/responses-json-events.test.ts`,
`tests/deepseek-responses-item-id-repair.test.ts`

활성화 증거: 항목 수 상한과 스트리밍 경로 둘 다 발화시켜야 한다. 상한 미만
픽스처만 쓰면 두 분기 모두 죽은 채로 남는다. 상한을 넘기는 출력 항목 수로
(a) 상한이 적용되어 잘리는지, (b) 프레임이 한 문자열이 아니라 순차 전송되는지
어서션한다. 후자는 전송 횟수나 청크 경계로 관찰한다.

## 검증 전 선행조건

### 010-10 · #1263 네이티브 프로파일 FIFO 거부

원작자 `luvs01 <27862058+luvs01@users.noreply.github.com>`
원본 브랜치 `luvs01:agent/reject-native-profile-fifo`
원본 커밋 `b12244e81`
새 브랜치 `codex/260808-reject-profile-fifo`

MODIFY `src/codex/native-profile-store.ts`

프로파일 경로가 FIFO(명명 파이프)를 가리키면 읽기가 블로킹된다. 공격자나 사고로
FIFO가 놓이면 프록시 시작이 무한 대기한다. 정규 파일이 아닌 경로를 거부한다.

MODIFY `tests/native-profile-store.test.ts`

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| FIFO 거부 | `mkfifo` 로 만든 경로를 프로파일로 지정 | 블로킹 없이 즉시 거부. 테스트가 타임아웃으로 끝나지 않음 |
| 정규 파일 통과 | 일반 프로파일 파일 | 기존과 동일하게 정상 로드 |

거부 경로가 없으면 테스트 자체가 행에 걸린다. 그것이 이 수정의 존재 이유다.

### 010-11 · #1260 루프백 sideband 호스트 제한 (보안)

원작자 `luvs01 <27862058+luvs01@users.noreply.github.com>`
원본 브랜치 `luvs01:agent/fix-live-loopback-host`
원본 커밋 `ed1d72974`
새 브랜치 `codex/260808-loopback-host-validation`

MODIFY `src/server/live.ts`

평문 Realtime sideband 예외가 `hostname.startsWith("127.")` 를 썼다.
`http://127.evil.example/v1` 같은 DNS 호스트가 이 검사를 통과한다. 원격 호스트로
평문 sideband 연결이 만들어진다.

변경: 127.0.0.0/8 범위의 숫자 IPv4만 허용한다. `localhost` 와 IPv6 루프백은
유지하고, `127.` 로 시작하는 DNS 이름은 거부해 보안 Realtime 엔드포인트로
폴백한다.

MODIFY `tests/server-live.test.ts`

**보안 검토 대상이다.** AGENTS.md의 인증/자격증명 경계에 해당한다. 이 항목은
단순 재발행이 아니라 검토자 지정과 검토 기록이 필요하다.

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| DNS 우회 차단 | `http://127.evil.example/v1` | 거부되고 보안 엔드포인트로 폴백. 평문 연결 미생성 |
| 숫자 루프백 허용 | `http://127.0.0.1:PORT` | 기존대로 허용 |
| localhost 허용 | `http://localhost:PORT` | 허용 (회귀 없음) |
| IPv6 루프백 허용 | `http://[::1]:PORT` | 허용 (회귀 없음) |

차단 케이스가 수정 전 코드에서 통과(=취약)했음을 먼저 보인 뒤 고친다.

### 010-12 · #1210 per-role model fallback 설정 이전

원작자 `Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>`
원본 브랜치 `Yuxin-Qiao:fix/1190-subagent-model-fallback-config`
원본 커밋 5개: `9281c3a5e`, `f666b0241`, `2b6a50f4f`, `7325fbac9`, `6b1ce0cd1`
새 브랜치 `codex/260808-subagent-fallback-config`
해소 이슈 **#1190**

per-role `model_fallback` 이 Codex 0.146.0의 커스텀 에이전트 TOML 스키마에서
거부된다. 해당 설정을 opencodex 자체 설정으로 옮겨 Codex가 이해하지 못하는 키를
TOML에 쓰지 않게 한다.

MODIFY `src/codex/subagent-model-fallback.ts`, `src/config.ts`, `src/types.ts`,
`src/cli/doctor.ts`
MODIFY `tests/subagent-model-fallback.test.ts`
MODIFY docs 5개 로케일의 `guides/sub-agent-surface.md`,
`reference/configuration/agents.md`

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| TOML 청결 | per-role fallback 설정 후 생성된 에이전트 TOML | `model_fallback` 키가 없음. Codex 0.146.0이 수용 |
| 폴백 동작 유지 | 1차 모델 실패 주입 | opencodex 설정에서 읽은 폴백 모델로 전환 |
| doctor 진단 | 낡은 TOML에 키가 남아 있는 상태 | `ocx doctor` 가 감지하고 안내 |

`src/config.ts` 와 `src/types.ts` 를 건드리므로 PLAN-FIELD-CHAIN-01 적용: 새 설정
필드의 생성(설정 파싱), 직렬화, 역직렬화(미지 값 처리), 소비자(4곳) 전 체인을
리베이스 시 확인한다.

### 010-13 · #1264 null Claude 토글 본문 거부

원작자 `luvs01 <27862058+luvs01@users.noreply.github.com>`
원본 브랜치 `luvs01:agent/fix-claude-null-toggle-body`
원본 커밋 `c85d792d8`
새 브랜치 `codex/260808-claude-null-toggle-body`

MODIFY `src/server/management/native-integration-routes.ts`

Claude 토글 관리 엔드포인트가 `null` 본문을 받으면 역참조 크래시가 난다.
`JSON.parse("null")` 이 예외 없이 `null` 을 돌려주는 것과 같은 계열의 결함이다
(WP2의 #1219와 원인 구조가 동일하지만 파일과 경로가 달라 독립 처리).

MODIFY `tests/native-claude-code-toggle.test.ts`

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| null 본문 거부 | 요청 본문에 리터럴 `null` | 400류 응답. 크래시 없음 |
| 비객체 본문 거부 | 배열이나 스칼라 본문 | 동일하게 거부 |
| 정상 본문 | 유효 토글 객체 | 기존과 동일 동작 (회귀 없음) |

수정 전 코드에서 null 본문이 크래시를 내는지 먼저 확인한다.

## 검증 전 선행조건

이 체크아웃에서 `bun run typecheck` 가 `bun-types` 부재로 exit 1이다(감사 실측,
0.808초). 각 재발행 브랜치에서 검증 명령을 돌리기 전에:

```bash
bun install
```

를 먼저 실행한다. 이것 없이 나온 typecheck 결과는 증거가 아니다.

## WP1 수용 기준

- 27개 PR의 CI 런이 승인되어 실행 상태로 전환
- 13개 재발행 PR이 열리고 각각 `Co-authored-by` 트레일러 보유
- 각 재발행 PR에 **두 번의 SHA 확인 기록**이 남는다: 착수 전(`002` 기록 대조)과
  발행 직전(`$REVIEWED_SHA` 재대조). 절차는 `003` 문서의 타이밍 표 참조
- 각 PR에서 `bun install` 후 `bun run typecheck` exit 0
- 각 PR의 대상 테스트 파일 green
- 조건부 분기를 추가한 항목은 해당 분기가 발화하는 증거 확보:
  010-1(청크 이월), 010-2(손상 행 skip), 010-3(프로토타입 키 가드),
  010-5(64 MiB 상한), 010-7(lock 아닌 실패 문구), 010-9(항목 상한·스트리밍),
  **010-10(FIFO 거부)**, **010-11(DNS 우회 차단)**, **010-12(TOML 청결·폴백·doctor)**,
  **010-13(null 본문 거부)**
- **#1260(010-11)은 보안 검토 완료 전 PR을 열지 않는다.** 지명된 검토자와 검토
  기록이 선행 조건이다. 평문 sideband 호스트 검증은 AGENTS.md의 인증/자격증명
  경계에 해당한다
