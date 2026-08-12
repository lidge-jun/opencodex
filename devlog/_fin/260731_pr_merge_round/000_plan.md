# 000 — 열린 PR 43건 머지 판단

로컬 `dev`는 성능 최적화 유닛이 진행 중이라 손댈 수 없다. 그래서 이번 라운드는
`dev`에 직접 올리지 않고 **스테이징 브랜치**에 쌓는다. 최적화 작업이 끝나면
사용자가 이 브랜치를 `dev`로 머지하고 릴리스한다.

- 워크트리: `/Users/jun/.codex/worktrees/260731-merge/opencodex`
- 브랜치: `codex/260731-pr-merge-round`
- 기준: `origin/dev = 356924263` (2026-07-31 재측정)
- 금지: `dev` / `main` / `preview` 푸시, npm 배포, 버전 bump

메인 체크아웃(`/Users/jun/Developer/new/700_projects/opencodex`)에는 커밋되지 않은
파일 22개가 있다. 이 라운드의 실패 조건 1번은 그 파일들이 스테이징되거나 사라지는
것이다. 배치마다 `git status --porcelain`으로 확인한다.

## 이 저장소의 머지 컨벤션 (이력에서 추출)

세 가지 형태가 실제로 쓰이고 있다. 커밋 이력에서 직접 확인한 것만 적는다.

| 형태 | 예시 | 언제 쓰이나 |
|---|---|---|
| GitHub 기본 머지 커밋 | `Merge pull request #773 from Wibias/fix/735-openai-chat-eof` (`5718d44e1`) | 웹 UI에서 머지할 때 |
| 손으로 쓴 머지 커밋 | `merge: PR #737 — tolerate late proxy readiness (#720)` (`62e937614`) | 메인테이너가 CLI로 머지할 때. 이슈 번호를 괄호로 단다 |
| 스쿼시 | `fix(cursor): add kimi-k3 with low/high/max effort tiers (#646)` (`275345a61`) | 기여자 PR을 한 커밋으로 접을 때 |

스쿼시가 지배적이다. 최근 300커밋 중 머지 커밋은 25개이고 나머지 275개는 전부
`type(scope): subject` 단일 부모 커밋이다.

**기여자 크레딧**: 스쿼시할 때 원저자를 `--author`로 유지하거나 `Co-authored-by`
트레일러를 단다. 최근 300커밋에 23건 있다(본문 기준 22건 + 머지 커밋 1건).
`275345a61`은 기여자를 author로 두고
메인테이너를 `Co-authored-by`에 넣었다 — 기여자 PR 위에 수정을 얹은 경우다.
`d24c5233f`는 반대로 메인테이너가 author, 기여자가 `Co-authored-by`다.
이번 라운드는 후자를 쓴다. 브랜치에서 재작성하는 건이 많기 때문이다.

**커밋 메시지 본문**: 이 저장소는 본문을 길게 쓴다. 무엇이 왜 깨졌는지, 어떤
측정을 했는지, 무엇이 반증됐는지까지 적는다(`1a46299b5`, `c777c8e76` 참고).
한 줄 요약만 있는 커밋은 이 저장소의 관행이 아니다.

**CI 게이트** (`AGENTS.md` + `MAINTAINERS.md`):

- PR 타깃은 `dev`만. `enforce-target`이 `main` 조상 위에 있으면서 `dev`보다 한참
  뒤처진 PR과 빈약한 설명을 거부한다.
- 인증/자격증명/OAuth/Actions/릴리스 자동화/의존성 설치를 건드리면 **명시적 보안
  리뷰**가 필요하다.
- 새 provider preset은 자격증명 목적지 변경이다. 문서화된 엔드포인트, ToS와 법인,
  중개업체면 재판매·라우팅 권한, 유지보수 담당자, 인용 가능한 검증 날짜가 있어야
  canonical 등록이 된다. 증거가 부족하면 `free-directory.ts`의 비활성 행으로.
- `bun run typecheck`, `bun run test`, `bun run privacy:scan`이 게이트다.

## 판정 매트릭스

terra 서브에이전트 4개를 겹치지 않는 슬라이스로 병렬 파견해 각 PR을 **현재 HEAD
코드와 직접 대조**했다. PR 설명은 근거로 인정하지 않았고, `git cherry`와 patch-id로
이미 HEAD에 있는지부터 확인했다. 아래 SHA는 전부 내가 직접 재확인했다.

### 이미 dev에 들어간 것 — 닫는다 (7건)

같은 수정이 다른 커밋으로 이미 랜딩됐다. 지금 머지하면 **더 새로운 코드를 되돌린다.**

| PR | HEAD의 해당 커밋 | 이슈 |
|---|---|---|
| #736 Windows 서비스 상태 locale 독립 | `1d9e196e7` | #722 FULL |
| #752 tray host 소켓 상속 차단 | `c1ecbe1b5` | #733 FULL |
| #743 discovery 경로 하드닝 | `fd1933099` | #572 PARTIAL |
| #610 `codex --version` 프로브 캐싱 | `716f39cb6` | #606 FULL |
| #734 `OPENCODEX_BUN_PATH` 존중 | `9b5c864ff` + `f81e98aca` | #721 FULL |
| #777 catalog video modality | `e64a00e9f` (+ `7a041e2bc`, `299f35dc9`) | #759 PARTIAL |
| #533 npm 캐시 복구 | #557이 같은 14커밋 + 후속 2건 | — |

#736이 대표적인 함정이다. HEAD는 `decodeSchtasksOutput()`로 schtasks의 UTF-16LE
출력을 디코딩하는데(`src/service.ts:364-393`), PR head를 머지하면 그 블록이 통째로
삭제되고 `encoding: "utf8"`로 되돌아간다. "CLEAN하게 머지된다"가 "머지해도 된다"를
뜻하지 않는다는 걸 보여주는 사례다.

#734는 이전 라운드가 macOS `/var` vs `/private/var` 테스트 실패 때문에 뺐던
건인데, `f81e98aca`가 `realpathSync`로 그 테스트를 고쳤다. 이제 8/8 통과한다.

#533은 결함이 남아 있지만 #557이 같은 커밋 시리즈에 하드닝 2건을 더 얹은
후속이다. 둘 다 열어둘 이유가 없다.

### 이번 브랜치에 태울 것 (배치 A, 6건)

HEAD에 결함이 남아 있고, 보안 경계를 넓히지 않으며, 실패하는 회귀 테스트를
가져오는 건들이다. 전부 재기준(restack)이 필요하다 — 76커밋 이상 뒤처져 있다.

| PR | 내용 | 이슈 | 손봐야 할 것 |
|---|---|---|---|
| #772 | `GET /api/catalog` | #709 FULL | restack만 |
| #774 | `ocx init` 파이프 stdin EOF 무한루프 | #754 FULL | restack만 |
| #783 | Claude Desktop 모델 목록에서 `native/*` 제외 | #767 FULL | restack만 |
| #768 | Kiro Windows 실행파일 PATH 해석 | — | 디렉터리/비실행 파일 거부 추가 |
| #781 | Anthropic `/v1/messages` baseUrl 중복, 스트림 quirk | #765 PARTIAL | 문자열 `tool_use.input` 정규화, 죽은 `sawContent` 제거, **`/api/logs` 봉투 테스트 헬퍼 분리** |
| #769 | Baseten free-directory 행 | — | 없음 (canonical 아님) |

#772와 #783은 `src/codex/catalog.ts`에서 충돌한다. `readCatalog`와
`desktopVisibleNativeSlugs` export를 둘 다 살려야 한다.

**감사가 잡아낸 것 — #744를 배치 A에서 뺀다.** 이 PR은 OAuth 재조정을 바꾸고
provider 설정을 영속화하며 토큰 해석 순서를 static 분기 앞뒤로 옮긴다
(`59d95c0e4`, `39543a3c0`). `MAINTAINERS.md` 기준 명시적 보안 리뷰 대상이다.
"카탈로그를 static으로 고정한다"는 요약이 그 사실을 가렸다. 보류로 옮긴다.

**#781도 그대로 못 태운다.** 토픽 커밋 `70031f470`이 Anthropic 코드와 함께
`/api/logs` 테스트를 `logsFromApiBody`로 갈아끼운다. 그 헬퍼(`2f6c031cc`,
`tests/helpers/logs-api.ts`)는 배열과 `{logs}` 봉투를 **둘 다** 받아준다 — 배치 B가
거부하기로 한 바로 그 봉투 계약을 테스트 쪽에서 미리 받아들이는 것이다.
Anthropic 변경만 떼어내고 HEAD의 배열 단언은 그대로 둔다.

### 브랜치에서 다시 만들 것 (배치 B, 3건)

결함은 진짜인데 구현이 지금 트리와 맞지 않는다. 기여자 커밋을 그대로 태우면
회귀가 난다. `Co-authored-by`로 크레딧을 유지하며 재작성한다.

- **#790 / #784 — 대시보드 로그.** 둘 다 `/api/logs`를 배열에서
  `{timeZone, logs}` 봉투로 바꾼다. 그 계약 변경이 배열을 가정한 기존 소비자를
  깬다: `tests/server-auth.test.ts:1623`, `tests/claude-native-passthrough.test.ts:119`,
  `tests/openai-provider-option-e2e.test.ts:489`, GUI mock 다수. 게다가 #790이
  고친 유일한 테스트는 두 형태를 모두 허용해서 **패치 없이도 통과한다.**
  배열 계약을 유지하고 타임존은 응답 헤더로 나르는 쪽으로 재작성한다.
  #726(200건 상한)과 #725(타임존)를 함께 닫는다.
- **#771 — Windows autostart Run 260자 초과.** VBS 런처 방향은 맞다.
  `tests/windows-tray.test.ts` import 충돌만 있고 나머지는 깨끗하다. #696 FULL.
- **#780 — Windows 스케줄러 stop.** 진단이 얕다. 패치는 `schtasks /end`가
  **실패할 때만** 6.5초 기다린다. 그런데 보고된 실패는 `/end`가 성공했는데 래퍼가
  살아남아 5초 뒤 자식을 재생성하는 경우다. 즉 이 패치로도 여전히 거짓 성공을
  보고한다. 재시작 창을 통과할 때까지 검증하도록 다시 만든다. #764 PARTIAL.

### 보류 (증거·리뷰 대기)

**보안 리뷰가 필요한 건** — `MAINTAINERS.md`가 요구하는 명시적 보안 리뷰는
메인테이너 판단이다. 내가 대신할 수 없으므로 브랜치에 태우지 않고 근거만 남긴다.

- #782 admin token ACL opt-in. 그리고 버그가 하나 있다: 디렉터리 하드닝이 soft
  continue할 수 있는데(`management-auth.ts:61-65`) 그 결과가 버려져서
  `/api/settings`가 `aclUnverified: false`를 보고할 수 있다. 파일 하드닝만
  상태를 세운다. 이건 리뷰 전에 고쳐야 한다.
- #744 Antigravity static 고정. OAuth 설정 영속화와 토큰 해석 순서 변경.
- #750 Codex 계정 풀 plan 영속화. 자격증명·토큰 회전 경합·계정 상태 영속화.
- #746 GitHub Copilot Responses 라우팅. OAuth 갱신과 키 풀 복구 경로.
- #644 Windows tray가 활성 Codex home을 따라가게. draft이고
  `.github/workflows/pr-labeler.yml`까지 건드린다 — Actions 변경은 보안 리뷰 대상.
  게다가 `.codexclaw/goalplans/**`와 `devlog/.DS_Store`가 diff에 들어 있다.
  저장소 위생 문제라 그대로는 못 받는다.
- #779 TLS 종단 Origin scheme skew. 분석상 인증 우회는 없다 —
  `requireManagementAuth`가 먼저 돌고(`index.ts:391`) 세션 경로는 여전히
  origin 완전 일치와 CSRF를 요구한다(`management-auth.ts:205`). 그래도 CORS 수용
  범위를 넓히는 변경이라 리뷰 대상이다.
- #775 Ollama private-network discovery (SSRF/destination policy).
- #778 doctor의 provider API key 진단 (자격증명 취급).
- #693 A6API 크레딧 (Bearer 키를 새 목적지 2곳으로 보낸다).
- #616 hosted image tool (management validation 변경).

**provider preset — 증거 미달**: #751(증거는 완비, CHANGES_REQUESTED 상태만 남음),
#747, #653, #611, #776. 각각 무엇이 빠졌는지는 `010`에 적는다.

**자체 리뷰 사이클이 필요한 대형 건**: #757(GPT-5.6 Pro 브라우저 자동화, 40파일),
#581(zh-TW 로케일, 59파일), #715(계정 풀 선택 순서, 62파일),
#707(외부 기여자의 보안 하드닝, 88파일), #671(exact account routing),
#569(readiness 계약, draft), #557(npm 캐시 복구, draft).
머지 라운드에서 처리할 물건이 아니다. 블라스트 반경과 리뷰 표면 때문이지
분량 때문이 아니다.

**기타**: #745(정규화는 맞는데 회귀 테스트가 없다 — 테스트를 우리가 쓴다),
#763(코드는 괜찮은데 필수 CI 기록이 없다), #793(#773이 왜 리버트됐는지 기록이
없다. 이유를 모른 채 같은 걸 되돌리는 건 안 된다 — 오너 판단 필요).

## 사이클 구성

- `010` — 이미 랜딩된 7건 PR과 해당 이슈 정리 (머지 없음)
- `020` — 배치 A: restack 6건
- `030` — 배치 B: 재작성 3건
- `040` — 남은 이슈 정리와 인계

각 배치는 `tsc` + 대상 테스트 + 배치 종료 시 전체 스위트 + `privacy:scan`을
통과한 뒤에만 푸시한다. 이슈는 랜딩된 코드가 실제로 결함을 없앤 게 확인될 때만
닫고, 부분 해결은 코멘트만 남기고 열어둔다.
