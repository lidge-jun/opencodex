# 021 — wp3 결과: `macmini-cf` (macOS, 소스 체크아웃)

사용자의 실제 프록시가 launchd로 돌고 있는 호스트다. 배포보다 복구가 어려운
쪽이었고, 실제로 복구에서 한 번 틀렸다.

## 사전 상태

```
HEAD   = 0cc73411aec36699aa30e98156a685665d8d8e5b
BRANCH = dev
DIRTY  = 0
LINK   = ~/opencodex/bin/ocx.mjs
SVC    = 80761  com.opencodex.proxy
서빙 버전 = 2.39.0, /healthz 200
```

파일로 남겼다. 나중에 대조할 것이 없으면 "복구했다"는 주장은 검증 불가능하다.

## 배포

`git pull --ff-only origin dev` → `0d8147c20`, `bun install`은 변경 없음.
`launchctl kickstart -k`로 재기동한 뒤 `/healthz`가 `version 2.40.0`을
응답했다. 소스만 바꾸고 끝내면 서비스는 옛 코드를 계속 들고 있으므로,
**서빙되는 버전 문자열**까지 확인해야 배포가 증명된다.

## QA — 적대적 클래스

| 클래스 | 명령 | 결과 |
| --- | --- | --- |
| 정상 | `/readyz` | 200 |
| 정상 | `ocx status` | running PID 64052, health ok |
| 정상 | `ocx ready --json` | `{"ready":true,"status":"ready"}` |
| 빈 입력 | `ocx provider` | usage 출력, exit 0 |
| 오입력 | `ocx status --nope` | usage 출력, **exit 1** |
| 경계 | `ocx capabilities --route /api/does-not-exist` | **exit 4** |
| 반복 | `/healthz` ×2 | 200 / 200 |
| 미지 라우트 | `/v1/nope` | 404 |

종료 코드는 파이프 없이 다시 쟀다. `| head`를 통과시키면 파이프라인의 마지막
명령 코드가 나와서 전부 0으로 보인다 — 처음 측정이 그랬다. `exit 4`는
`skills/ocx/SKILL.md`가 "not found"로 문서화한 값이고, 실제와 일치한다.

## 복구에서 한 번 틀렸다

`git checkout 0cc73411a`로 커밋과 버전(2.39.0)은 되돌아왔다. 그런데 사전
상태 파일과 대조하니 `BRANCH`가 `dev`가 아니라 `HEAD`였다 — detached
HEAD로 남은 것이다.

커밋이 같으니 동작은 같지만 **원래 상태는 아니다**. 사용자가 다음에
`git pull`을 하면 detached HEAD에서 실패한다. `git branch -f dev <sha>` +
`git checkout dev`로 브랜치 정체성까지 복원했다.

이걸 잡은 건 사전 상태를 **파일로** 남겼기 때문이다. 기억으로 대조했다면
"커밋 같으니 됐다"로 넘어갔을 것이다.

## 최종 확인

```
BRANCH = dev            (사전과 일치)
HEAD   = 0cc73411a...   (사전과 일치)
DIRTY  = 0              (사전과 일치)
LINK   = ~/opencodex/bin/ocx.mjs  (사전과 일치)
SVC    = 64484 com.opencodex.proxy  (PID는 재기동으로 바뀜, 실행 상태 일치)
버전   = 2.39.0         (사전과 일치)
```

증거: `.codexclaw/evidence/<sid>/qa/macmini-{prestate,deploy,cli-adversarial,restore}/`

