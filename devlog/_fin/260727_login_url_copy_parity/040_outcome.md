# 040 — 실행 결과 (wp1~wp4 종료)

## 무엇이 바뀌었나

세 로그인 표면이 하나의 `LoginUrlBlock`을 쓴다. 사용자가 지적한 표면
(ChatGPT 계정 추가·재인증 모달)은 이제 인증 URL 전문, 수동 열기 링크,
3-상태 복사 피드백을 갖는다.

| | 이전 | 이후 |
|---|---|---|
| Workspace 패널 | URL + 3-상태 복사 (복제본 1) | 공용 블록 |
| 프로바이더 추가 모달 | URL + 3-상태 복사 (복제본 2) | 공용 블록 |
| Codex 계정 모달 | 복사 버튼만, 실패는 에러 notice | 공용 블록 |
| 비보안 컨텍스트 복사 | 표면별로 제각각 | `copyTextToClipboard` 폴백 통일 |

## 커밋 (dev, 전부 미푸시)

| 커밋 | 내용 |
|------|------|
| `ef656be2` | wp0 문서 4건 |
| `c136ecec` | `LoginUrlBlock` 신설 + 테스트 6건 |
| `555c3d63` | 복사 피드백을 effect 리셋에서 파생 상태로 (lint 규칙) |
| `3f05fa00` | Codex 계정 모달 채택 + 죽은 i18n 키 3개 제거 |
| `853c4088` | 표면 A·B 이관, 중복 2벌 제거 |
| `a19ce5dd` | 비보안 컨텍스트 클립보드 폴백 복원 |

## 계획에서 벗어난 지점

**1. url 변경 리셋을 effect가 아니라 파생 상태로 구현했다.**
010은 `useEffect(() => setState("idle"), [url])`를 적었지만
`react-hooks/set-state-in-effect`가 막았다. 규칙이 옳다 — effect로 상태를
되돌리면 캐스케이딩 렌더가 된다. 피드백이 자기 url을 함께 들고 다니게 해
렌더 시점 불일치로 읽히게 바꿨다. 계약은 동일하고 effect만 사라졌다.

**2. wp4가 계획에 없었다.**
C 단계 독립 검증에서 나온 인접 결함이다. `execCommand` 폴백이 Codex 모달의
옛 코드에만 있었고 공용 래퍼로 옮기며 사라졌다. `hostname: 0.0.0.0`으로 LAN에
노출하면 평문 HTTP라 보안 컨텍스트가 아니고 `navigator.clipboard`가 없다.
즉 그 배포에서 복사가 영구히 죽는다. 조기 종료 대신 work-phase를 붙여
공용 래퍼에서 한 번에 고쳤다 — 세 표면이 동시에 수혜를 본다.

**3. 기기 코드 복사(`prov.copyCode`) 통일은 계획에서 뺐다.**
A 감사가 범위 이탈로 지목했고 동의했다. 별도 항목.

## 검증 (실측)

| 명령 | 결과 |
|------|------|
| `bun run typecheck` | exit 0 |
| `cd gui && bun x tsc -b` | exit 0 |
| `cd gui && bun test tests` | 319 pass / 0 fail |
| `bun run test` (루트) | 4985 pass / 0 fail |
| `bun run lint:gui` | exit 0 |
| `cd gui && bun run lint:i18n` | exit 0 |
| `bun run privacy:scan` | passed |
| `bun test tests/claude-desktop-locale.test.ts` | 6개 로케일 키 1324개로 동일 |

가드 실효(수정을 되돌리면 실패):

- url 스코프 피드백 제거 → 1 fail
- 재클릭 `clearTimer` 제거 → 1 fail
- `LoginUrlBlock` 렌더 제거(Codex 모달) → 3 fail
- 빈 url 가드 제거 → 2 fail
- `execCommand` 폴백 제거 → 2 fail

이관 동등성의 증거는 기존 테스트 두 파일
(`provider-auth-login-copy-link.test.tsx`, `add-provider-oauth-url-leak.test.tsx`)이
한 줄도 수정되지 않고 9건 전부 통과한다는 사실이다.

## 독립 검증

두 차례 독립 감사를 받았다.

- wp0 계획 감사: `GO-WITH-FIXES (blockers=2)`. 지적 11건 전부 문서에 반영.
  blocker는 (a) url 변경 시 stale 복사 상태, (b) 로케일 정합 게이트 오인
  (`lint:i18n`은 `src/i18n/**`를 globalIgnores로 제외한다).
- wp3 종료 후 최종 검증: `PASS (blockers=0)`. 지적 [M] 1건이 wp4가 됐다.

## 남은 항목

- `pwi-` 클래스 접두사 리네임 (모달에서도 쓰이는데 이름이 provider workspace를 가리킨다)
- `prov.copyCode` 기기 코드 복사 규약 통일
- push 및 배포는 사용자 승인 대기
