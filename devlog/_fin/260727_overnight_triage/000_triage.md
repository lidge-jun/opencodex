# 밤샘 트리아지 — 2026-07-26 저녁 ~ 07-27 오전

기준선: `v2.7.41` 릴리스(2026-07-26T15:44Z) 이후 `origin/dev`에 들어온 것 전부.
집계 시각: 2026-07-27 09:30 KST.

## 한 줄 요약

머지된 41개 커밋은 전부 `dev`에만 있고 `main`/`preview`에는 하나도 없다.
즉 **밤새 고친 것 중 사용자에게 나간 것은 아직 없다.** npm `latest`는 여전히
`2.7.41`이고, 그 안에는 Kiro 재시도 수정도, Retry-After 수정도, Grok
dead-port 진단도 들어 있지 않다. 이게 이번 트리아지에서 가장 중요한 항목이다.

## 규모

| 항목 | 수 |
| --- | --- |
| dev에 쌓인 커밋 (main 기준) | 41 |
| 그중 fix/feat | 79 (머지 커밋 포함 집계) |
| 변경 파일 | 181 files, +8148 / -378 |
| 머지된 PR | 21 |
| 닫힌 이슈 | 16 |
| 열린 PR | 14 (ready 2, draft 12) |
| 열린 이슈 | 21 |

## 머지된 것 — 주제별

### Kiro 스트리밍 안정화 (가장 큰 덩어리, 7 커밋)

`#519`(mid-stream socket close), `#507`(429에 Retry-After 없이 전달되어 Codex
turn 즉사), `#508`(입력 토큰 보고 누락)이 한 묶음으로 닫혔다. 핵심 판단은
"출력이 이미 나갔는가"를 재시도 가능 여부의 기준으로 삼은 것 —
`58c3dc21`, `5f22d280`, `8ea2c521`가 각각 fallback setup / 분류된 에러 /
fallback incomplete에 같은 규칙을 적용한다.

부분 출력 후 재시도는 사용자에게 중복 텍스트로 보인다. 이 세 커밋이
그걸 막는다.

### Retry-After 처리 (`#507`, `#452`)

`6b772cac`가 재시도 가능한 429에 Retry-After를 붙이고, `7f34fc02`가
"클라이언트에게 돌려줄 값"과 "내부 쿨다운 값"을 분리한다. `51c50bed`는
비어있지 않은 에러 본문에 딸려온 passthrough Retry-After를 소독한다.
`#452`(503 리포트)도 이 흐름에서 닫혔다.

### UX paper cuts (`#488`)

`69ac0dc0` 한 커밋으로 세 가지: config 편집 경고 문구, combo effort 피커,
모델 "숨김" 네이밍. zh/ja 로케일도 `0e26bb66`에서 같이 맞췄다.

### Combo 카탈로그 누락 (`#484`)

`525fc58f`가 sync와 GUI 양쪽에 누락 사유를 노출하고, `4d2fb613`이
"incomplete(아직 못 받음)"과 "incompatible(원래 안 됨)"을 구분한다.
사용자가 볼 때 이 둘은 대응이 완전히 다르므로 구분이 맞다.

### GUI react-doctor 정리 (22 커밋)

`#468`~`#481` 계열. 기능 변경이 아니라 lint/구조 정리다. 리스크는 낮지만
파일 수가 많아 이번 배포 diff를 부풀리는 주된 원인이다.

### CI 이슈 번역 파이프라인 (10 커밋)

`#510`, `#513`, `#523`. LLM이 뱉은 깨진 JSON 이스케이프 복구, 번역
미완료 상태 처리, freeform 이슈 템플릿 우회 차단. 제품 코드가 아니라
저장소 운영 자동화 쪽이다.

### Grok (내 작업, 3 커밋)

`#511` 후속. 어제 `7ba0fec3`까지가 orphan 입양이었고, 오늘 새벽
`5451cd19`가 "fence가 죽은 포트를 가리켜도 아무도 모른다"는 진단 공백을
막았다. 상세는 `devlog/_plan/260727_grok_orphan_adoption/041_stale_port_closeout.md`.

## 열린 PR — 처리 판단

| PR | 상태 | 판단 |
| --- | --- | --- |
| #522 logs 상관 ID (`#330`) | **CLEAN, 전 체크 통과** | 머지 가능. 리뷰만 남음 |
| #518 stale app-server (`#476`) | UNSTABLE — windows만 pending | windows 끝나면 머지 |
| #524 Console Go 스키마 | draft, UNSTABLE | 작성자 대기 |
| #512 account namespace (`#425`) | draft | 작성자 대기 |
| #498 native subagent 기본값 | draft | 작성자 대기 |
| #495 main 계정 최후수단 예약 | draft | 작성자 대기 |
| #493 Claude per-account 쿼터 (`#294`) | draft | 작성자 대기 |
| #491 OAuth 로그인이 API 키 삭제 | draft | **보안 인접 — 리뷰 필요** |
| #461 `ocx opencode` 런처 | draft | 작성자 대기 |
| #455 | **잘못된 브랜치(dev2-go)** | 정리 대상 |
| #447 Kiro 브라우저 다중계정 | draft | 작성자 대기 |
| #429 Cursor 프롬프트 오염 | draft | 작성자 대기 |
| #424 Grok 이미지 브리지 | draft | 작성자 대기 |
| #355 Gemini 인라인 이미지 | ready | 리뷰 필요 |

`#518`은 이슈 `#476`("카탈로그 바꿔도 실행 중인 app-server가 옛 목록을 계속
씀")을 직접 겨냥한다. 재부팅해야 고쳐지던 문제라 체감 우선순위가 높다.

## 열린 이슈 — 분류

### 코드가 이미 있는데 안 닫힌 것

- **`#511` Grok 200k** — `dev`/`preview`/`main`에서 고쳐졌다고 코멘트까지
  달렸는데 아직 OPEN. 오늘 새벽 dead-port 후속(`5451cd19`)까지 들어갔으니
  닫아도 된다. **가장 먼저 정리할 항목.**

### 진단은 끝났고 수정이 필요한 것

- **`#509` Windows 메모리** — 신고자가 `heapUsed` 5729MB vs RSS 3001MB
  샘플을 제출했다. 코드 확인 결과 `src/server/memory-watchdog.ts:90`은
  `s.rss >= warnThresholdBytes` 하나만 본다. 즉 **JS 힙이 터져도 경고가
  안 나가는 게 맞다.** 신고 내용이 코드와 정확히 일치하므로 `needs-info`가
  아니라 실제 수정 대상으로 승격해야 한다.

- **`#521` web-search 499** — `src/lib/errors.ts:88,97,108`에 이미
  "client closed request" → `client_closed_request` 매핑이 있다. 즉 이건
  분류 로직 문제가 아니라 web-search 루프가 실제로 abort를 일으키는
  쪽일 가능성이 높다. `needs-info`를 유지하되 조사 방향은 `src/web-search/loop.ts`로 좁힐 수 있다.

### 상류(upstream) 대기

`#462`(모델 제거 시 Codex 크래시), `#417`(한국어 음성 U+FFFD),
`#241`(Desktop 모델 누락), `#92`(V2 서브에이전트 encrypted_content),
`#401`(음성 모델 변경). 우리가 고칠 수 있는 범위 밖이라 라벨 유지.

### 로드맵/기능 요청

`#294` Claude 계정 풀, `#95` 멀티유저 프록시 호스팅, `#42` 스토리지 페이지,
`#201`/`#178`/`#177` 신규 프로바이더(TRAE/Factory/Warp), `#414`/`#415`
검색 사이드카 백엔드, `#386` macOS 메뉴바 앱, `#425` 계정 네임스페이스.
이 중 `#294`는 `#493`이, `#425`는 `#512`가 이미 draft로 붙어 있다.

### 미해결 버그

`#418` V2 custom-parent→custom-child 위임 실패(2.7.39에서도 재현),
`#476` app-server stale(→ `#518`로 처리 중).

## 다음 액션 (우선순위)

1. **배포 판단.** 41커밋이 `main`/`preview` 어디에도 없다. Kiro 안정화와
   Retry-After는 사용자가 지금 겪고 있는 증상이므로 preview 승격을 먼저
   고려할 만하다. 다만 GUI 정리 22커밋이 같이 실려 diff가 크다 — 승격
   전에 릴리스 노트 분리가 필요하다.
2. **`#511` 종료.** 수정도 후속 진단도 끝났다.
3. **`#518` 머지.** windows 체크만 남았고 `#476`을 직접 해결한다.
4. **`#522` 머지 검토.** 전 체크 통과 상태.
5. **`#509` 재분류.** `needs-info` → 실제 버그. watchdog에 heap 기준 추가.
6. **`#491` 보안 리뷰.** OAuth 로그인이 저장된 API 키를 지우는 문제 —
   자격증명 경로라 MAINTAINERS.md 기준 별도 리뷰 대상.
7. **`#455` 정리.** `dev2-go` 대상 PR.

## 판단 근거로 쓴 명령

    git rev-list --count origin/main..origin/dev        # 41
    git rev-list --count origin/preview..origin/dev     # 41
    npm view @bitkyc08/opencodex dist-tags              # latest=2.7.41
    gh pr view 522 --json mergeStateStatus              # CLEAN
    gh pr checks 518                                    # windows-latest pending
    rg -n "s.rss >= warnThresholdBytes" src/server/memory-watchdog.ts
    rg -n "client closed request" src/lib/errors.ts
