# 023 — wp5 결과: `desktop-c795oh4` (Windows / MINGW64)

## 사전 상태

```
npm 글로벌 = @bitkyc08/opencodex@2.32.1
ocx        = ~/AppData/Roaming/npm/ocx
~/.opencodex = 존재
node v24.19.0, bun 1.3.14
프록시 PID 26208 가동 중 (uptime 638755s = 약 7.4일)
```

## QA

CLI 계약이 세 OS에서 동일하다. 빈 입력 exit 0, 오플래그 exit 1, 미매칭 라우트
exit 4. HTTP도 같다: healthz/readyz 200, 반복 200/200, `/v1/nope` 404,
GUI `/` 200.

### 버전 스큐 경고가 실제로 동작한다

CLI를 2.39.0으로 올렸는데 실행 중인 프록시는 2.32.1이었다. `ocx status`가
이렇게 말했다:

```
CLI 2.39.0 does not match the running proxy 2.32.1 — this ocx on PATH is
stale. Its help and features describe a different build.
```

`skills/ocx/SKILL.md`가 "관리 명령 전 3단계" 중 2단계로 문서화한 바로 그
확인이다. 문서에만 있는 규칙이 아니라 런타임이 실제로 잡아준다.

## 복구 — Windows 고유 실패

첫 시도가 실패했다. npm이 이렇게 경고했다:

```
npm warn cleanup [Error: EPERM: operation not permitted, unlink
  '...AppData/Roaming/npm/node_modules/@bitkyc08/.opencodex-*/node_modules/bun/bin/bun.exe']
```

실행 중인 프록시가 `bun.exe`를 잡고 있어서 npm이 교체하지 못했다. POSIX라면
열린 파일도 unlink되지만 Windows는 잠긴 실행 파일을 지우지 못한다.

그런데 npm은 이걸 `warn cleanup`으로 출력하고 종료 코드는 성공처럼 흘려보낸다
— 그래서 설치가 된 줄 알고 넘어갈 뻔했다. 사후 대조에서 버전이 여전히
2.39.0인 것을 보고 잡았다.

순서를 바꿔 해결했다: `ocx stop` → 재설치 → `ocx start`.

## 최종 대조

| 항목 | 사전 | 사후 |
| --- | --- | --- |
| npm 글로벌 | 2.32.1 | **2.32.1** |
| `ocx` 경로 | AppData/Roaming/npm/ocx | **동일** |
| `~/.opencodex` | 존재 | **존재** |
| CLI 버전 | 2.32.1 | **2.32.1** |
| 프록시 | 가동(PID 26208) | **가동(PID 5988), healthz 200, served 2.32.1** |
| 스큐 경고 | 없음 | **없음** |

PID가 바뀐 것은 재기동 때문이고, 프록시가 다시 떠 있다는 사실이 복구의 기준이다.

## 세 OS 공통 결과

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 빈 입력 | exit 0 | exit 0 | exit 0 |
| 오플래그 | exit 1 | exit 1 | exit 1 |
| 미매칭 라우트 | exit 4 | exit 4 | exit 4 |
| healthz / readyz | 200 | 200 | 200 |
| 미지 라우트 | 404 | 404 | 404 |
| GUI `/` | 200 | 200 | 200 |

플랫폼 고유 차이는 **복구 절차**에만 나타났다: macOS는 브랜치 정체성,
Windows는 파일 잠금. 런타임 계약 자체는 세 OS에서 같다.

