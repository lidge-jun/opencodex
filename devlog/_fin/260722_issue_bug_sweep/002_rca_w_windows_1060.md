# 002 — RCA W: Windows sc.exe 1060 오분류 잔존 갭 (#216, #199)

- 이슈: #216 (pt-BR/Bun), #199 (ko/Bun exit 36)
- 조사: sol 레인 W (2026-07-22 dev 트리 실측)
- 성격: **resolved-in-dev 부분 + 잔존 갭** — 1e6bd6d4(v2.7.27부터 포함)가 영어 `FAILED 1060` 스트림 스캔을 고쳤으나, **로컬라이즈드 텍스트와 Bun status 36 케이스는 HEAD에서 여전히 재현**.

## 증상 → HEAD 분류

| 리포트 | 조건 | HEAD 상태 |
|--------|------|-----------|
| #216 pt-BR | WinSW exe 부재 + `FALHA 1060`(영문 토큰 없음) | **재현됨** — `/FAILED 1060/i` 불일치 → "error" → "unknown" → install abort |
| #199 ko/Bun | Bun이 status를 36(=1060&0xff)으로 노출 + 로컬라이즈드 출력 | **재현됨(조건부)** — status!==1060 이고 텍스트 불일치일 때. "Bun이 항상 36으로 절단"은 외부 미검증 (아래 Open Questions) |

영어 호스트에서 status 36 단독은 더 이상 치명적이지 않음(출력에 `FAILED 1060` 있으면 매칭됨).
잔존 실패는 (1) status!==1060 **그리고** (2) 출력이 영어 패턴 불일치일 때만.

## 현재 코드 상태 (파일:라인)

- `src/lib/winsw.ts:215` probeScmRegistration — true(쿼리 성공) / false(`e.status===1060 || /FAILED 1060/i`) / "error"(그 외)
- `src/lib/winsw.ts:220` stderr/stdout/message 전 스트림 스캔 (1e6bd6d4 산물)
- `src/lib/winsw.ts:236` queryScmForService — `sc.exe query opencodex-proxy-native`, utf8
- `src/lib/winsw.ts:189` statusWinswRaw — exe 존재 시 WinSW status 파싱; 부재 시 SCM probe; false만 "nonexistent", true/"error"는 "unknown"
- fail-closed 소비자: `src/service.ts:493`(scheduler install → unknown이면 native cleanup → abort), `:505`("still present" 오표현), `:764`(unknown을 installed로 취급, stop 오보고), `:796`(best-effort 문서와 달리 예외 미포획)
- 테스트: `tests/winsw.test.ts:123-131` — status 1060, 영어 FAILED 1060 stderr/stdout, status 5 fail-closed. **status 36 / FALHA / 한국어 / message 단독 1060 미커버**

## 잔존 갭

- **W1 (주원인)**: 영어 전용 텍스트 매칭 `/FAILED 1060/i` — FALHA/한국어 미매칭
- **W2**: Bun status 36 미인식 (단, 36 단독 수용은 충돌 위험 — 256 모듈로 동치 상태 다수)
- **W3**: "error"/"unknown" 구분 소실 — access denied·sc.exe 부재·로컬라이즈드 절대부재가 모두 동일 파괴 경로
- **W4**: 진단 메시지에 status/출력 발췌 부재, `sc query` 안내는 PowerShell alias 모호성

## 수정 방향 (010 패치 단위 입력)

1. **W1**: `winsw.ts:226`을 `e.status === 1060 || /\b1060\b/.test(text)`로 — 1060은 로케일 불변 숫자 식별자. 고정 명령·고정 서비스명이라 오탐 위험 낮음. 회귀 테스트 4종 추가(FALHA/localized stderr/message/status5-without-1060→"error").
2. **W2**: status 36 단독 수용 금지 — `\b1060\b` 텍스트 매칭이 도입되면 별도 36 처리 불필요. (선택: 텍스트 1060 동반 시에만 36 수용)
3. **W3**: 호출부 tri-state 보존 — "unknown"을 "still present"로 표현하지 않기, stopped/removed 플래그는 실제 성공 후에만, `uninstallServiceIfInstalled` 예외 포획.
4. **W4**: 에러 메시지에 `status=<n>` + sanitized 출력 발췌 + `sc.exe query opencodex-proxy-native`(exe 명시) 안내, denied/launch-fail/unrecognized 구분.
5. (대안, 채택 보류) Win32 OpenServiceW 직접 프로브 — 확정적이지만 FFI 표면 확대. 텍스트 매칭 불신 시에만.

## Open Questions

- Bun Windows 네이티브 레이어의 1060→36 절단이 보편적인지 미검증 (JS 레이어는 exitCode 그대로 전달 확인: oven-sh/bun child_process.ts). 이슈 2건의 재현이 간접 증거.
- 현재 Windows 빌드의 한국어 sc.exe 출력 정확 형태·스트림은 Windows 실기 검증 필요.
