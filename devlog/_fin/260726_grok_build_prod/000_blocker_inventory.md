---
created: 2026-07-26
status: plan
tags: [grok-build, pr-403, review-blockers, production]
---

# 000 — PR #403 리뷰 블로커 인벤토리 (실측)

대상: `codex/260726-grok-build-prod` (PR #403 재기반), 로컬 `dev` @`5a550867` 위 15커밋.
수집일: 2026-07-26. 출처: `gh api repos/lidge-jun/opencodex/pulls/403/comments`,
`gh api repos/lidge-jun/opencodex/issues/403/comments` (메인테이너 리뷰 2026-07-24T13:05:24Z).

## 리뷰 소스별 원본 개수

| 소스 | 건수 | 성격 |
|------|------|------|
| 메인테이너 (lidge-jun) | 4 | blocking (High 2 / Medium 2) |
| chatgpt-codex-connector | 5 | 전부 P2 |
| coderabbitai | 6 인라인 | Major 4 / Minor 2 |

중복을 접으면 고유 블로커는 8건(B1–B8)이다.

## B1 — 비루프백 바인드에서 관리 블록이 실토큰을 덮어씀 (High)

- 지적: 메인테이너 #2, codex P2 `src/grok/inject.ts:134`, CodeRabbit `docs/guides/grok-build.md:54`
- 현재 코드: `buildGrokManagedBlock()`가 모든 모델에 `api_key = "opencodex-loopback"` 고정 방출
  (`src/grok/inject.ts` 내 `lines.push(... 'api_key = "opencodex-loopback"')`).
- 실제 결과: `src/server/auth-cors.ts`는 비루프백 바인드에서 실제 `OPENCODEX_API_AUTH_TOKEN`을
  요구하므로 자동 등록된 모델은 전부 401. 사용자가 손으로 키를 고쳐도 다음
  `start`/`ensure`/`restart`의 `syncGrokConfig()`가 블록을 통째로 재생성하며 되돌린다.
  메인테이너 재현 결과 `REAL_TOKEN_PRESERVED=false`.
- 판정: 유효. 자동 등록 자체를 루프백 바인드로 제한하고, 비루프백에서는 fence 밖 수동 설정을
  안내해야 한다(사용자 소유 영역을 우리가 계속 덮어쓰지 않는 것이 핵심).

## B2 — 서비스 소유권 가드 실패가 삼켜지고 공유 설정이 제거됨 (High)

- 지적: 메인테이너 #1, codex P2 `src/cli/index.ts:397`, CodeRabbit `src/cli/index.ts:398`
- 현재 코드: `src/service.ts:869-891` `stopServiceIfInstalled()`는 첫 줄에서
  `assertServiceEnvironmentMatchesInstall()`를 호출해 다른 `CODEX_HOME`/`OPENCODEX_HOME`에
  설치된 서비스면 **매니저를 건드리기 전에** throw한다.
  `handleStop()`(`src/cli/index.ts` 내 try/catch)은 이 예외를 경고만 찍고 계속 진행해,
  아래에서 `stripGrokConfig()`로 공유 `~/.grok/config.toml` 블록을 제거한다.
- 실제 결과: 설치된 서비스는 살아 있는데 공유 라우팅 설정만 사라진다. 서비스가 프록시를 다시
  띄우면 grok에는 모델이 없는 상태가 된다. `ocx restart`도 정지되지 않은 서비스 위에서 진행된다.
- 판정: 유효. 소유권 불일치(정지 시도조차 못 한 상태)와 단순 정지 실패를 구분해야 한다.
  전자는 공유 자원 teardown을 건너뛰고 실패로 전파한다.

## B3 — 인용된 첫 키 세그먼트를 놓쳐 TOML 전체가 깨짐 (Medium)

- 지적: 메인테이너 #3, codex P2 `src/grok/inject.ts:69`, CodeRabbit `src/grok/inject.ts:76`
- 현재 코드: `userModelAliases()`의 정규식이
  `/^\s*\[\s*model\s*\.\s*(?:([A-Za-z0-9_-]+)|"…"|'…')\s*\]/gm` — 두 번째 세그먼트의 인용은
  처리하지만 **첫 세그먼트 `model`은 리터럴로만** 매칭한다.
- 실제 결과: 사용자가 `["model"."ocx-mine"]` 또는 `['model'.ocx-mine]`를 소유하면 예약에서
  누락되고, 우리가 `[model.ocx-mine]`를 또 방출해 같은 테이블을 재정의한다. grok의 TOML 파서는
  `Cannot redefine key 'model'`로 설정 파일 전체를 거부한다 — 우리 블록뿐 아니라 사용자 설정까지 죽는다.
- 판정: 유효. 첫 세그먼트도 정규화하고 두 인용 형태 회귀 테스트를 추가한다.

## B4 — CLI 라이프사이클 회귀 테스트 부재 (Medium)

- 지적: 메인테이너 #4, CodeRabbit `src/cli/index.ts:278`
- 현재: `tests/grok-*.test.ts`는 inject/sync 헬퍼만 덮는다. `handleStart`의 grok 동기화 배선,
  `handleEnsure`의 두 분기(라이브 프록시 발견 / 신규 spawn 후), stop 시 strip, 소유권 불일치
  경로는 직접 테스트가 없다. B2가 이 구멍으로 통과했다.
- 판정: 유효. 변경된 라이프사이클 분기에 집중 회귀를 붙인다.

## B5 — 개행 없는 설정 파일이 byte-for-byte 복원되지 않음 (P2)

- 지적: codex P2 `src/grok/inject.ts:230`
- 현재 코드: inject는 `content.endsWith("\n") ? "\n" : "\n\n"`로 구분자를 넣고,
  strip은 `prefix.endsWith("\n\n")`일 때 **한 개만** 되돌린다.
- 실제 결과: 원래 마지막 개행이 없던 사용자 파일이 `ocx stop` 후 개행 하나를 얻는다.
  사용자 소유 파일의 바이트 불일치.
- 판정: 유효. 주입한 구분자를 알 수 있어야 정확히 되돌릴 수 있다.

## B6 — 의도적 서비스/API 종료가 fence를 남김 (P2)

- 지적: codex P2 `src/cli/index.ts:212`
- 현재 코드: 데몬의 `syncCleanup()`은 `if (!process.env.OCX_SERVICE)`일 때만
  `stripGrokConfig()`를 부른다 — 서비스 매니저의 크래시/재spawn 때 fence를 지키려는 의도이며
  이 배제 자체는 옳다. 그러나 `src/server/management-api.ts:136-148`의 `POST /api/stop`은
  `stopServiceIfInstalled()` + `restoreNativeCodex()`만 하고 grok strip을 전혀 호출하지 않는다.
  대시보드에서 정지하면 grok에는 죽은 엔드포인트를 가리키는 모델이 남는다.
- 판정: 유효. 명시적 종료 경로(서비스 정지, `POST /api/stop`)에서만 strip하고
  크래시/재spawn 배제는 유지한다.

## B7 — 문서가 비루프백 요건과 리로드 동작을 과장 (docs)

- 지적: CodeRabbit `docs-site/.../grok-build.md:54`, `:92`
- 현재: 비루프백일 때 `api_key`만 교체하라고 안내한다(도달 불가한 `127.0.0.1` base_url 유지).
  또 "최근 grok이 config.toml을 감시해 열린 세션에 `[model.*]`를 핫리로드한다"고 단언한다 —
  버전 보증 없는 주장.
- 판정: 유효. `base_url`+`api_key` 동시 요구, 도달 가능한 예시 호스트, `grok inspect` 후
  세션 재개라는 문서화된 절차로 교체. (B1에서 자동 등록을 루프백으로 제한하면 문서도 그에 맞게
  "비루프백은 수동 설정"으로 재작성된다.)

## B8 — devlog 권장 백엔드가 자기 영수증과 모순 (docs)

- 지적: CodeRabbit `devlog/_plan/260723_grok_build_bridge/020_docs_and_residual_smoke.md:14`
- 현재: 020 문서는 `responses`를 권장하지만 같은 유닛의 `011_receipt.md:53-55`는 grok이
  `response.heartbeat`에서 종료한다고 기록했고, 이후 계획은 그래서 `chat_completions`를 골랐다.
- 판정: 유효. `chat_completions` 권장으로 정정하고 Responses는 알려진 한계로 기록.

## 작업 위상 매핑

| 블로커 | 실행 사이클 |
|--------|------------|
| B3, B5 | 010 — 설정 안전성 코어 |
| B1 | 020 — 비루프백 자동 등록 거부 |
| B2, B6 | 030 — 라이프사이클 teardown 정합성 |
| B4 | 040 — CLI 라이프사이클 회귀 |
| B7, B8 | 050 — 문서/devlog 진실 정렬 |

## A-게이트 감사에서 추가로 발견된 결함 (2026-07-26)

독립 감사자가 리뷰 목록 밖에서 찾아낸 것들. 리뷰에는 없었지만 같은 모듈의 실제 결함이다.

| # | 결함 | 귀속 |
|---|------|------|
| D1 | `handleStart`의 grok 동기화가 Desktop3P `try` 안에 중첩돼, 카탈로그 조회가 던지면 fence가 조용히 건너뛰어짐 (`src/cli/index.ts:263`) | 030 §5 |
| D2 | `ocx stop`이 `stripGrokConfig`의 `!ok`(orphaned-marker 거부 등)를 삼키고 0으로 종료 (`src/cli/index.ts:447`) | 030 §2d |
| D3 | `serviceCommand("stop")`이 설치 여부 가드 없이 `ops.stop()` 실행 (`src/service.ts:1151`) | 030 §3 |
| D4 | `POST /api/stop`의 `stopServiceIfInstalled()`가 무보호라 소유권 예외가 500으로 새고 프록시가 살아남음 | 030 §4 |
| D5 | `[[model.x]]`, `[model.x.sub]` 철자가 우리 블록과 duplicate-key 충돌하는데 예약되지 않음 | 010 (B3 확장) |
| D6 | 백업 `config.toml.bak-opencodex`가 최초 1회만 생성돼 임의로 낡을 수 있음 (`src/grok/inject.ts:186`) — orphaned-marker 안내가 이 파일을 가리킨다 | **미할당 잔여 위험** |
| D7 | 루트 dotted 키(`model.ocx-mine.x = 1`), `[model]` + dotted 키 형태도 충돌하나 예약 대상 아님 | **미할당 잔여 위험** |

D6/D7은 이번 PR 범위(리뷰 블로커 해소)를 넘어서므로 여기 기록만 하고, 후속 유닛에서 다룬다.
D6은 사용자 데이터 복구 경로라 우선순위가 높다.

## 정정 이력

- **2026-07-26, B1 설계 반전.** 초판은 `env_key` 방출로 자동 등록을 유지하려 했다. 감사에서
  `env_key` 미해석 시 grok이 xAI 세션 토큰을 우리 평문 LAN 주소로 전송함이 원본 코드와 상위
  테스트로 확인됐다(`001` E3 정정). 메인테이너 원안(비루프백 자동 등록 거부)으로 되돌렸다.
- **2026-07-26, B5 알고리즘 교체.** 초판 strip 규칙은 정보 이론상 불가능한 복원을 시도했고
  중간 삽입 경로에서 개행이 누적되는 퇴행을 유발했다. inject를 단사로 만드는 방식으로 교체.
