# 001 — QA 증거 레이아웃

`cxc-qa` §3 계약을 이 유닛에 적용한 형태다. 시나리오 하나가 디렉터리
하나이고, 그 안에 실행 명령과 아티팩트와 판정이 함께 있다.

```
.codexclaw/evidence/<sessionId>/qa/
  <host>-<scenario>/
    invocation.txt     실행한 명령 그대로, 복사해 붙이면 재현된다
    <artifact>         출력 캡처 / 스크린샷 / 응답
    verdict.json       판정과 그 근거가 가리키는 파일
```

## 시나리오 id 규칙

`<host>-<surface>-<class>`. 예: `macmini-cli-normal`,
`lidge-cli-malformed`, `desktop-http-repeat`, `gui-viewport-320`.
호스트가 앞에 오는 이유는 같은 시나리오를 네 곳에서 돌리기 때문이다.

## verdict.json 필수 필드

`scenario`, `criterion`, `surface`, `verdict`,
`artifactRefs`, `note`, `capturedAt`, `sourceSnapshotAt`.
web/gui 표면에는 `captureChecks` 네 키가 추가된다.

`inferred`와 `partial`은 없다. 실제 표면에서 돌았거나 안 돌았거나 둘 중
하나다. 돌리지 못한 시나리오는 skip이 아니라 FAIL이고 블로커를 적는다.

## receipt

모든 시나리오가 끝나면 집계한다:

```bash
node plugins/codexclaw/skills/qa/scripts/validate-evidence.mjs   .codexclaw/evidence/<sid>/qa/ --emit-receipt
```

실패하면 receipt를 남기지 않는다 — 이전 실행이 만든 것까지 지운다. 자기가
증명하는 QA보다 오래 사는 receipt는 없는 것보다 나쁘기 때문이다.

## 정리 영수증

QA가 띄운 모든 것에 각각 정리 증거를 남긴다: 프록시 PID, 포트, tmux 세션,
임시 디렉터리. `lsof -i :<port>` 비어 있음, `ps` 확인, 파일 부재 확인.
아무것도 안 띄웠으면 "무엇을 확인했는지"와 함께 그렇게 적는다.

