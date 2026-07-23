# 010 — 패치 계획 W: Windows sc.exe 1060 로케일 안전 탐지 (#216, #199)

- 소스 RCA: `002_rca_w_windows_1060.md` (리뷰어 검증 완료)
- 위험도: 낮음 (탐지 로직 + 메시지, Windows 전용 경로)
- 선행 조건: 없음 (독립 패치 단위)
- **구현 완료 (2026-07-22)**: winsw.ts:226 `/\b1060\b/`, service.ts tri-state(:505 재검증 문구/:764 stop-guard/:798 uninstall try-catch), tests/winsw.test.ts +4 회귀. 검증: `bun test tests/winsw.test.ts` 21 pass, `bun x tsc --noEmit` exit 0. 커밋: WP-impl-1.

## 파일 변경 맵

| 파일 | 작업 | 내용 |
|------|------|------|
| `src/lib/winsw.ts` | MODIFY | 1060 매칭 로케일 안전화 + 진단 메시지 |
| `src/service.ts` | MODIFY | tri-state 표현 정정("unknown"≠"still present") + best-effort 예외 포획 |
| `tests/winsw.test.ts` | MODIFY | 로케일/status-36 회귀 케이스 4종 추가 |

## Diff 1 — `src/lib/winsw.ts:226` 매칭 완화

Before (현행, `winsw.ts:226` 실측):

```ts
    if (e.status === 1060 || /FAILED 1060/i.test(text)) return false;
    return "error";
```

After:

```ts
    // ERROR_SERVICE_DOES_NOT_EXIST: the numeric identifier 1060 is locale-invariant
    // (FALHA 1060 pt-BR, localized ko output, English FAILED 1060). The query is a
    // fixed `sc.exe query <service>` so a standalone 1060 in its output is proof of
    // absence. Bun may deliver e.status as 36 (1060 & 0xff) — status 36 ALONE is
    // NOT accepted (collides with any status ≡ 36 mod 256); the textual 1060 is
    // required corroboration and covers those hosts.
    if (e.status === 1060 || /\b1060\b/.test(text)) return false;
    return "error";
```

## Diff 2 — `src/service.ts` tri-state 소비자 정정

- `:505` "Native service still present after removal attempt" → "unknown" 케이스와 "확인된 잔존"을 분리:
  probe 결과가 `"error"`였다면 문구를 "could not re-verify the SCM registration (status=<n>, output excerpt)"로.
- `:764` `stopServiceIfInstalled`: `stopped = true`는 stop 명령이 실제 성공 신호를 반환했을 때만 설정.
- `:796` `uninstallServiceIfInstalled`: best-effort 문서 계약대로 `uninstallWinswService()` 예외를 try/catch로 포획하고 경고 로그로 격하.
- 에러 메시지 공통: `sc query` 대신 `sc.exe query opencodex-proxy-native` 안내(PowerShell alias 모호성 제거), `status=<n>` + sanitized 출력 발췌 포함.

## Diff 3 — `tests/winsw.test.ts:123` 이후 회귀 케이스 추가

```ts
// pt-BR localized output with Bun low-byte status (issue #216 + #199)
expect(probeScmRegistration(() => { const e = new Error("fail") as Error & { status: number; stdout: string }; e.status = 36; e.stdout = "[SC] EnumQueryServicesStatus:OpenService FALHA 1060: ..."; throw e; })).toBe(false);
// localized stderr carrying only the numeric code
expect(probeScmRegistration(() => { const e = new Error("fail") as Error & { status: number; stderr: string }; e.status = 36; e.stderr = "[SC] OpenService 1060: 지정된 서비스가 설치된 서비스로 존재하지 않습니다."; throw e; })).toBe(false);
// numeric code only present in the error message
expect(probeScmRegistration(() => { const e = new Error("<localized> 1060") as Error & { status: number }; e.status = 1; throw e; })).toBe(false);
// access denied (status 5) WITHOUT 1060 must stay fail-closed "error"
expect(probeScmRegistration(() => { const e = new Error("Acesso negado") as Error & { status: number; stderr: string }; e.status = 5; e.stderr = "[SC] OpenSCManager FALHA 5: Acesso negado."; throw e; })).toBe("error");
```

## 명시적 비채택

- status 36 단독 수용: 충돌 위험으로 기각 (002 W2).
- Win32 OpenServiceW FFI 프로브: 확정적이지만 표면 확대 — 텍스트 매칭 실패 사례가 나오면 재검토.

## 수용 기준 / 검증

- [ ] `bun test tests/winsw.test.ts` 전체 통과 (신규 4케이스 포함)
- [ ] `bun run typecheck` (또는 `tsc --noEmit`) 통과
- [ ] FALHA/localized/message-only 1060 → `false`(absence), status-5-without-1060 → `"error"` 유지
- [ ] service.ts 에러 문구에 status·출력 발췌·`sc.exe` 명시 확인 (문구 스냅샷 or 수동 확인)
