# 003 — 재발행 프로토콜 (공통 절차)

모든 재발행 work-phase가 이 절차를 따른다. phase 문서는 이 절차를 다시 쓰지 않고
대상과 차이점만 기술한다.

## 원칙

원작자의 작업물이다. maintainer는 이를 현재 `dev` 위로 옮겨 착지 가능하게 만들 뿐,
저작을 가져오지 않는다. 따라서 커밋에 `Co-authored-by` 트레일러를 남기고 PR 본문에
원작자와 원본 PR 번호를 명시한다.

## 브랜치 명명

```
codex/260808-<slug>
```

`slug` 는 원본 브랜치의 의미를 유지한다. 예: `codex/260808-history-index-stream-tail`.

## 절차

```bash
# 0. 착수 직전 head SHA를 확보한다 (감사 라운드 7)
REVIEWED_SHA=$(gh pr view <n> --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)
echo "$REVIEWED_SHA"
#    -> 002 문서에 기록된 SHA와 다르면 중단하고 diff를 다시 읽는다
#    -> 이 값을 발행 직전까지 보관한다 (아래 5단계에서 재사용)

# 1. 원작자 fork를 remote로 확보 (이미 있으면 생략)
git remote add <owner> https://github.com/<owner>/opencodex.git 2>/dev/null || true
git fetch <owner> <headBranch>
git rev-parse <owner>/<headBranch>   # $REVIEWED_SHA 와 일치해야 한다

# 2. 최신 dev 확보
git fetch origin dev
BASE_DEV_SHA=$(git rev-parse origin/dev)
echo "$BASE_DEV_SHA"   # 이 값도 발행 직전까지 보관한다

# 3. dev 위에 새 브랜치
git switch -c codex/260808-<slug> origin/dev

# 4. 원본 변경을 적용 (squash로 가져오되 저작은 트레일러로 보존)
git cherry-pick --no-commit <sha>...   # 또는 git merge --squash <owner>/<branch>

# 5. 충돌 해소 후 **잠정** 로컬 커밋
#    리베이스를 하려면 커밋이 있어야 하므로 여기서 만든다.
#    아래 발행 루프에서 되돌려지거나 다시 만들어질 수 있다.
git commit
```

5단계 커밋은 잠정이다. 이 시점에는 아직 발행하지 않는다. 원격에 나가는 행위
(push, PR 생성)는 아래 루프를 통과한 뒤에만 일어난다. 기여자 head가 바뀌어
중단되면 이 로컬 커밋은 버린다.

## 발행 직전 재확인 (STRICT, 감사 라운드 8)

0단계의 확인만으로는 부족하다. 충돌을 해소하고 테스트를 돌리는 동안에도 기여자는
push할 수 있다. 그 사이 로컬 fetch한 ref는 낡은 커밋 그대로이므로, 그대로 발행하면
**기여자의 최신 작업을 조용히 빠뜨린 재발행**이 된다.

커밋과 PR 생성 **직전에** 다시 확인한다.

```bash
MAX_ATTEMPTS=3
attempt=0

while :; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt "$MAX_ATTEMPTS" ]; then
    echo "ABORT: base unstable after $MAX_ATTEMPTS attempts"
    echo "  contributor head: $(gh pr view <n> --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)"
    echo "  origin/dev:       $(git rev-parse origin/dev)"
    # 재계획 대상이다. 이 상태로 발행하지 않는다
    exit 1
  fi

  # (a) 기여자 head — 바뀌었으면 재검토 대상이지 재시도 대상이 아니다
  CURRENT_SHA=$(gh pr view <n> --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)
  if [ "$CURRENT_SHA" != "$REVIEWED_SHA" ]; then
    echo "ABORT: head moved $REVIEWED_SHA -> $CURRENT_SHA"
    # 새 diff를 읽고 파일 맵/활성화 테스트/보안 범위를 재검토한 뒤 0단계부터
    exit 1
  fi

  # (b) dev — 바뀌었으면 리베이스 후 재검증하고 루프를 다시 돈다
  git fetch origin dev
  CURRENT_DEV_SHA=$(git rev-parse origin/dev)
  if [ "$CURRENT_DEV_SHA" = "$BASE_DEV_SHA" ]; then
    break                      # 둘 다 안정. 발행 가능
  fi

  echo "dev moved $BASE_DEV_SHA -> $CURRENT_DEV_SHA (attempt $attempt); rebasing"
  git rebase --onto origin/dev "$BASE_DEV_SHA" || {
    echo "ABORT: rebase conflict against new dev"; exit 1; }
  BASE_DEV_SHA="$CURRENT_DEV_SHA"

  # 새 base에서 검증을 처음부터 다시 돌린다 — 이전 결과는 무효다
  bun install
  bun run typecheck || exit 1
  bun test tests/<대상>.test.ts || exit 1
  # 이 유닛의 활성화 시나리오도 전부 다시 수집한다 (아래 재수집 규칙 참조)
done

# 루프를 빠져나온 시점에만 push와 PR 생성을 진행한다.
# (5단계의 잠정 커밋은 이미 있고, 리베이스로 갱신됐을 수 있다.
#  필요하면 여기서 커밋 메시지를 정리한다 — Co-authored-by 트레일러 확인 포함)
```

### 루프 설계 근거

### 중단 시 로컬 상태 정리 (감사 라운드 12)

중단(기여자 head 변경, 리베이스 충돌, 3회 소진)이 발생하면 `codex/260808-<slug>`
브랜치와 잠정 커밋이 남는다. 그대로 두면 재시작할 때 `git switch -c` 가 같은
이름으로 브랜치를 만들지 못해 절차가 막힌다.

**지우지 않는다.** 이름을 바꿔 보관한 뒤 원래 이름을 비운다. 중단 시점의 작업은
왜 멈췄는지 조사할 근거이며, 특히 기여자 head가 바뀐 경우 우리가 무엇을
검토했었는지 대조할 기준이 된다.

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
git switch --detach                       # 정리 대상 브랜치에서 벗어난다
git branch -m codex/260808-<slug> codex/260808-<slug>-aborted-$STAMP
```

정리는 이름 변경까지다. **여기서 브랜치를 다시 만들지 않는다.** 0단계부터
절차를 다시 시작하면 3단계가 그때의 `origin/dev` 기준으로 브랜치를 만든다.
정리 단계에서 미리 만들어두면 3단계의 `git switch -c` 가 이름 충돌로 실패하고,
게다가 그 브랜치는 재시작 시점이 아니라 중단 시점의 dev를 가리키게 된다.

보관된 `*-aborted-*` 브랜치는 로컬에만 둔다. 원격에 push하지 않는다 — 발행되지
않은 중간 상태이며, 기여자 작업을 낡은 형태로 공개하는 셈이 된다.

캠페인이 끝난 뒤 정리한다. 그전까지는 각 중단이 왜 일어났는지 기록으로 남는다.

### 루프 설계 근거

두 확인의 처리가 다르다.

- **기여자 head 변경은 중단이다.** 재시도로 해결되지 않는다. 내용이 달라졌으므로
  사람이 다시 읽어야 한다.
- **dev 이동은 재시도다.** 우리 변경은 그대로이고 base만 옮기면 되므로 리베이스와
  재검증으로 흡수된다.

3회 상한을 두는 이유: dev가 그보다 자주 움직이는 상황이라면 리베이스 경주를
계속하는 대신 사람이 개입할 시점이다. 상한 소진 시 현재 두 head를 기록하고
중단하며, 재계획 후 다시 시작한다.

### 재검증 시 활성화 증거 재수집 범위

base가 바뀌면 다음을 **다시 수집한다**:

- 해당 유닛의 decade 문서에 표로 적힌 활성화 시나리오 전부
- 특히 "수정 전 red 확인" 이 필요한 항목(가드, 차단, 거부 경로)

**이월 가능한 것:** 원본 PR의 diff 검토 결과. 기여자 head에 종속되며 dev 이동과
무관하다. 기여자 head가 바뀌면 무효다.

**보안 검토는 자동 이월되지 않는다 (감사 라운드 11).** 깨끗한 리베이스라도
합쳐진 결과물의 보안 경계는 달라질 수 있다. 우리 변경이 그대로여도 dev가 인접
경로를 바꿨다면 둘의 조합이 새로운 표면을 만든다. 리베이스가 충돌 없이 끝났다는
것은 텍스트가 겹치지 않았다는 뜻이지 의미가 안전하다는 뜻이 아니다.

보안 민감 유닛에서 dev가 움직이면, 지명된 검토자가 **최종 리베이스된 diff**를
다시 확인한다. 깨끗한 리베이스라면 초점을 좁힌 재확인으로 충분하고 전면
재검토까지는 필요 없지만, 확인 없이 통과시키지는 않는다.

해당 유닛:

| 유닛 | 사유 |
|---|---|
| 010-11 (#1260) | 평문 sideband 호스트 검증 — 인증/자격증명 경계 |
| WP3 (#1259) | `.github/workflows/` 보호 표면 |
| 040-3 (#1178) | OAuth 흐름, 아웃바운드 POST 하드닝, 캐시 격리 |

이 셋은 발행 직전 루프를 돌 때마다 재확인 기록을 남긴다.

세 확인이 모두 통과해야 PR을 연다. 불일치는 예외 없이 중단 또는 재작업이다.
"거의 같으니 괜찮겠지" 로 넘어가면 이 절차 전체가 무의미해진다.

**낡은 base에서 나온 검증 결과는 증거가 아니다.** dev가 움직였으면 typecheck와
테스트를 새 base에서 다시 돌린다. 리베이스만 하고 이전 green을 재사용하는 것이
이 규칙이 막으려는 행동이다.

타이밍 요약:

| 시점 | 확인 대상 | 불일치 시 |
|---|---|---|
| 0단계 (착수 전) | `002` 기록 SHA 대 라이브 head | 중단, diff 재검토 후 처음부터 |
| 2단계 | `BASE_DEV_SHA` 기록 | — (기준값 확보) |
| 발행 직전 | `$REVIEWED_SHA` 대 라이브 head | 중단, 처음부터 재시작 |
| 발행 직전 (루프) | `$BASE_DEV_SHA` 대 현재 `origin/dev` | 재리베이스 + **검증 전량 재실행** + 루프 재진입 (최대 3회) |

마지막 행이 루프인 이유: 재리베이스와 재검증에도 시간이 걸리므로 그 사이 다시
움직일 수 있다. 두 SHA가 모두 안정된 상태에서만 발행한다. 리베이스 충돌은
중단이며 자동 해소를 시도하지 않는다. 3회를 소진하면 현재 두 head를 기록하고
중단한 뒤 재계획한다 — 무한 재시도는 하지 않는다.

## 커밋 메시지 형식

```
fix(<scope>): <원본 제목의 요지>

<무엇이 왜 문제였는지 — file:line 근거 포함>

Supersedes #<원본 PR 번호>.

Co-authored-by: <Name> <email>
```

여러 커밋을 합칠 때는 모든 원작자를 각각 트레일러로 나열한다.

## 확보된 트레일러 문자열

아래는 조사 시점의 커밋 저자 정보다. **커밋 SHA는 시간에 따라 바뀌지만 저자
정보는 대체로 안정적이다.** 그래도 리베이스 직전에 실제 커밋에서 다시 읽어
확인한다 — 기여자가 head를 갈아끼우면서 저자 정보가 달라질 수 있다.

조사에서 확인한 커밋 저자 정보다. 그대로 사용한다.

```
Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>
Co-authored-by: luvs01 <luvs01@hanmail.net>
Co-authored-by: Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>
Co-authored-by: TyroneXie <328347833@qq.com>
Co-authored-by: snowyukitty <270071858+snowyukitty@users.noreply.github.com>
Co-authored-by: Myroslav Dosiak <miroslavdosiak@gmail.com>
Co-authored-by: 关俊江 <each1024@qq.com>
Co-authored-by: xinweigao <xinwei.gao.7@yandex.com>
Co-authored-by: Xinwei Gao <xinweigao.1@bytedance.com>
Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>
Co-authored-by: WZBbiao <16611004+WZBbiao@users.noreply.github.com>
```

**주의:** luvs01은 커밋에 따라 두 이메일을 쓴다. 원본 커밋의 이메일을 그대로 쓴다.

## PR 본문 템플릿

`.github/PULL_REQUEST_TEMPLATE.md` 의 세 섹션을 전부 채운다. `enforce-target` 이
빈 설명과 얇은 설명을 거부한다.

```markdown
## Summary

Republishes #<원본> by @<원작자> on current `dev`.

- <무엇을 고치는지>
- <왜 필요한지 — file:line 근거>

The original branch was <N> commits behind `dev` / blocked on CI approval, so this
carries the same change onto the current head with the author preserved as
co-author. Original PR: #<원본>.

## Verification

- `bun run typecheck`
- `bun test tests/<대상>.test.ts`
- <추가 게이트>

## Checklist

- [x] Scope stays focused and avoids unrelated cleanup.
- [x] Docs or release notes were updated when needed.
- [x] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.
```

GUI를 건드리는 PR은 제목이나 본문에 `gui` 가 들어가면 스크린샷이 **필수**다
(`enforce-target` 이 거부한다). 해당 PR은 #1257, #1244, #1245 수정, #1213 수정이다.

## 원본 PR 처리

재발행 PR이 열린 뒤 원본에 코멘트를 남긴다. 원본을 닫는 것은 재발행이 머지된
뒤이며, 이번 캠페인에서는 **재발행 PR 생성까지만** 수행하고 원본 close와 머지는
별도 승인 대상이다.

## 검증 게이트

각 재발행 PR 생성 전 로컬에서:

```bash
bun run typecheck
bun test tests/<관련>.test.ts
```

공유 서브시스템(라우팅, 어댑터, 설정, 서버)을 건드리면 전체 스위트를 돌린다.
GUI 변경은 `bun run lint:gui`, 워크플로 변경은 `bun test tests/ci-workflows.test.ts`.
