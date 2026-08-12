# 081 — #1149 재계획: 기여자 PR #1180 채택 + 개선

`080` 은 우리가 처음부터 구현하는 전제로 썼다. 그 사이 기여자 PR
[#1180](https://github.com/lidge-jun/opencodex/pull/1180) (`luvs01`,
`agent/fix-windows-acl-effective-sid`, head `df6989c17`) 이 같은 결함을 거의
같은 설계로 이미 고쳐놨다. 처음부터 다시 쓰는 것은 기여자 저작을 버리는
행위이고, 우리 계획이 요구한 제약을 그 PR 이 대부분 이미 만족한다.

## #1180 이 080 의 제약을 어디까지 지켰나

| 080 제약 | #1180 |
|---|---|
| `whoami` 신규 작성 금지 | 지킴 — `[WindowsIdentity]::GetCurrent().User.Value` |
| 제3의 System32 리졸버 금지 | 지킴 — `resolveTrustedWindowsPowerShellExe()` 재사용 |
| sync/async 양쪽 | 지킴 — `resolveCurrentWindowsPrincipal{,Async}` |
| SID 타임아웃이 `timedOutPaths` 오염 금지 | 지킴 — 별도 코드 `EACLIDENTITY` |
| 성공만 캐시 | 지킴 — `principalFromResult` 통과 후에만 `cachedPrincipal` |
| harden 예산에서 차감 | 부분 — 남은 예산을 자식 timeout 으로 넘기지만, 실행 파일 리졸브와 spawn 준비는 그 timeout 이 시작되기 전에 일어난다 (아래 D) |
| `required:true` fail-closed | 지킴 |

`user-identity.ts` 를 직접 재사용하는 대신 저수준 프리미티브를 새로 뽑은 것도
`080` 의 "extract a neutral primitive" 와 같은 결론이다. 그쪽은 도메인 전용
예외를 던지고, 무자격 `powershell.exe` 를 띄우며, 타임아웃도 `windowsHide` 도
없고, 동기 전용이다.

## 감사에서 뒤집힌 것 — 폴백 복원안 철회

이 문서의 첫 판은 optional read path 에 `USERDOMAIN\USERNAME` 폴백을 복원하자고
했다. 독립 감사가 P1 으로 되돌렸고, 그 논증이 옳다.

`DOMAIN\User` 라는 **형태**는 그 계정이 현재 토큰의 주체라는 **증거가 아니다**.
두 환경변수 모두 우리를 띄운 프로세스가 쓸 수 있다. 그리고 optional 경로도
`required` 와 똑같은 파괴적 시퀀스를 돈다:

```
/grant:r <principal>:(F)   ← 이 시점에 잘못된 계정이 Full Control 을 얻는다
/inheritance:r             ← 상속 ACE 를 전부 끊는다
/remove:g <broad SIDs>     ← Everyone/Users/Authenticated Users 만 지운다
```

공격자가 고른 이름이 다른 실제 사용자로 해석되면 그 사용자의 ACE 가 시크릿에
남고, 현재 사용자는 방금 끊긴 상속 접근을 잃는다. 고른 이름이 `BUILTIN\Users`
로 해석되면 3단계가 방금 만든 ACE 를 지워서 파일이 접근 불가가 된다.

"optional 은 status quo 라서 안전하다" 는 논증은 성립하지 않는다. status quo 가
안전했던 게 아니라, status quo 가 바로 #1149 가 신고한 결함이다.

**따라서 optional SID 실패는 icacls 를 한 번도 실행하지 않고 끝낸다** — #1180 의
동작 그대로다. 이름 폴백이 언젠가 필요하다면 환경변수가 아니라 토큰 SID 를 OS
의 신뢰된 API 로 이름 변환하는 별도 권위 경로여야 하고, 그건 이 유닛의 범위가
아니다.

## 우리가 얹는 것

### (A) 테스트 전용 상수가 프로덕션 파일 한가운데 있다

```ts
const FORCED_NON_WINDOWS_TEST_PRINCIPAL = "*S-1-5-21-1-2-3-1001";

function currentWindowsPrincipal(deadline: number): string {
  if (platformOverride === "win32" && platform !== "win32") {
    return FORCED_NON_WINDOWS_TEST_PRINCIPAL;
  }
  ...
```

**이것은 보안 결함이 아니다.** 감사가 정확히 지적한 대로, 프로덕션 Windows 에서는
`platform !== "win32"` 가 거짓이라 이 분기에 도달할 수 없고, POSIX 에서도
테스트 전용 setter 를 호출해야 켜진다. 위생 문제이며, 그 이상으로 포장하지 않는다.

옮기는 진짜 이유는 (B) 다. 합성값이 프로덕션 모듈에 있는 한 실패 주입이 불가능하다.

이 분기가 필요한 이유 자체는 실재한다. POSIX CI 는 `setPlatformForTests("win32")`
로 ACL 분기를 강제로 돌리는데, 그 호스트에는 PowerShell 도 System32 도 없다.
이미 그렇게 도는 테스트가 7개 파일 30여 곳이다.

**해결:** 합성 SID 를 `windows-user-principal.ts` 의 테스트 seam 으로 옮기고,
`setPlatformForTests` 가 그 seam 을 켜고 끈다. `windows-secret-acl.ts` 에는
`FORCED_NON_WINDOWS_TEST_PRINCIPAL` 상수도, 그것을 고르는 분기도 남지 않는다.

### (B) 실패 경로 테스트가 POSIX CI 에서 통째로 스킵된다

```ts
test("identity lookup failure is fail-closed but never memoized as an icacls timeout", () => {
  if (process.platform !== "win32") return;
```

`timedOutPaths` 오염 금지는 `080` 이 명시적으로 요구한 제약인데, 그것을 지키는
유일한 테스트가 Linux/macOS 러너에서 한 줄도 실행되지 않는다. 원인은 (A) 다 —
합성 principal 이 runner 보다 먼저 반환하므로 POSIX 에서는 실패를 주입할 방법이
없었다.

**해결:** 어느 runner 를 쓸지 고를 때 명시적 override 가 합성값을 이기게 한다.

```
runner 선택:  explicit override  >  synthetic(test)  >  default
성공 캐시:    선택된 경로와 무관하게 그대로 authoritative
```

"override 가 캐시보다 먼저" 라는 뜻이 아니다 — 성공한 조회는 여전히 캐시되고
재사용된다. 바뀌는 것은 캐시가 비어 있을 때 **무엇을 실행하느냐** 뿐이다.
그러면 실패 주입 테스트가 세 플랫폼 전부에서 돈다. 스킵 가드를 제거한다.

### (C) `required` 경계에서 `EACLIDENTITY` 코드가 소실된다

`sanitizedAclError` (`src/lib/windows-secret-acl.ts:557-566`) 는 허용 목록에 든
코드만 재부착한다:

```ts
if (code === "ETIMEDOUT" || code === "EICACLS" || code === "EACCES" || code === "EPERM") {
  error.code = code;
}
```

`EACLIDENTITY` 가 없다. #1180 은 `sanitizeDiagnostics` 에는 케이스를 추가했으므로
**메시지 문자열**에는 남지만, `required: true` 가 던지는 오류의 `error.code` 는
`undefined` 다. 호출자가 원인을 프로그램적으로 구분할 수 없다.

#1180 의 테스트가 이걸 가린다: `.toThrow(/EACLIDENTITY/)` 는 메시지만 본다.

**해결:** 허용 목록에 `EACLIDENTITY` 를 추가하고, 테스트를 코드 검사로 바꾼다.

### (D) 예산 caveat 을 문서로 정직하게 남긴다

`080` 은 "lookup 을 harden 예산에 차감" 을 요구했다. #1180 은 남은 예산을 자식
프로세스 timeout 으로 넘기지만, 그 timeout 이 시작되기 전에 두 가지가 일어난다:
`resolveTrustedWindowsPowerShellExe()` 의 `GetSystemDirectoryW` FFI 호출, 그리고
`Bun.spawn` 반환 이후에야 걸리는 async 타이머.

통상 작지만 hard bound 는 아니다. 남는 위험은 잘못된 권한 부여가 아니라 —
두 작업 모두 ACL 이 바뀌기 전에 끝난다 — 예산을 조금 넘길 수 있는 가용성
문제다. 강제하려면 runner 계약과 동기 실행 모델까지 손대야 해서 채택 개선과
분리한다. 대신 `windows-user-principal.ts` 상단에 caveat 을 명시해서, 다음에 이
예산을 조이는 사람이 착각하지 않게 한다.

## 변경 파일

- `src/lib/windows-user-principal.ts` — 합성 seam 추가, override 우선순위, 예산 caveat
- `src/lib/windows-secret-acl.ts` — 합성 상수/분기 제거, `EACLIDENTITY` 허용 목록 추가
- `tests/windows-user-principal.test.ts` — override 우선순위 케이스
- `tests/windows-secret-acl.test.ts` — 스킵 가드 제거, sync/async × required/optional 행렬

## 수용 기준

1. `windows-secret-acl.ts` 전체에 `FORCED_NON_WINDOWS_TEST_PRINCIPAL` 문자열도,
   합성 principal 을 고르는 `platformOverride` 분기도 없다 (`rg` 로 확인 가능).
2. SID 실패 + `required: true` → 던져진 오류가 `toMatchObject({ code: "EACLIDENTITY" })`
   를 만족하고, `timedOutSecretPathCountForTests() === 0`, icacls 호출 0회.
   **POSIX 러너에서 실제로 실행된다** (스킵 가드 없음).
3. SID 실패 + `required: false` → `{ ok: false, diagnostics }` 반환, icacls 호출 0회,
   ACL 변경 없음. 환경변수 폴백 없음.
4. 2·3 이 sync (`hardenSecretPath`) 와 async (`hardenSecretPathAsync`) 양쪽에
   동일하게 성립한다.
5. ablation — 각각 되돌렸을 때 red 가 되는 테스트를 명시한다:
   - (A)+(B) 우선순위를 `synthetic → override` 로 되돌리면: 주입한 실패 runner 가
     호출되지 않아 `identityCalls === 0` 이 되고, required 하든이 성공해버려
     기준 2 가 **red**.
   - (C) 허용 목록에서 `EACLIDENTITY` 를 빼면: `error.code` 가 `undefined` 가 되어
     기준 2 의 `toMatchObject` 가 **red**.
   - 철회한 환경변수 폴백을 되살리면: 기준 3 의 icacls 호출 0회 assertion 이
     **red**. 이 mutation 을 명시해 두는 이유는, 폴백 철회가 이 유닛에서 가장
     되돌아오기 쉬운 결정이기 때문이다.

## 커밋 구성

기여자 커밋 `df6989c17` 을 cherry-pick 해서 저작을 보존하고, 그 위에 개선
커밋을 얹는다. #1180 은 대체 PR 번호를 남기고 close 한다.
