# wp3 결과 — p2(#2776) 재스택 + D1 구현 + T20

브랜치 `codex/remote-hub-p2`: `7099760a5` → `b7282858b`.
베이스는 재스택된 `codex/remote-hub-p1@07d7f1006`.

## 충돌

`tests/cli-dispatch.test.ts`와 `tests/cli-registry.test.ts`에서 순수
추가-추가 충돌. dev와 이 단계가 같은 위치에 서로 다른 테스트를 넣었다.

처음에 정규식으로 충돌 마커만 지우는 방식을 썼는데, 그게 닫는 중괄호를
삼켜서 두 파일이 파싱 불가가 됐다(dispatch 3개, registry 1개 손실).
테스트가 "Unexpected end of file"로 죽고 나서야 드러났다.

고친 방법: dev 원본 파일에서 시작해 이 단계가 **추가한 블록만** 얹었다.
마커 텍스트를 편집하는 대신 양쪽의 의도를 재구성하는 쪽이 안전하다.
두 테스트 파일 42건 전부 통과한다.

## D1 구현 — 평문 pairing 제거

설계(wp1)에서 계약을 고쳤지만 코드는 그대로였다. `src/server/gui-session.ts`의
`consumeGuiPairingGrant`가 `remoteGui.allowInsecureHttp === true`이면
비-loopback HTTP로 `insecure-http-pairing` 세션을 발급하고 있었다.

제거했다. 그리고 **순서를 바꿨다.** 기존 코드는 grant를 찾아 검증한 뒤에
scheme을 판정해서, 거절된 교환이 이미 단회용 코드를 소비했다. TLS 종단을
걷어낸 공격자가 운영자가 출력하는 코드를 전부 태울 수 있다는 뜻이다.
이제 grant를 읽기 전에 거절하며, 회귀 테스트가 "같은 미사용 grant가 HTTPS로는
여전히 통한다"로 이를 증명한다.

`allowInsecureHttp` 키는 스키마에 남기고 retired로 표시했다. 설정 스키마가
`.strict()`라 키를 지우면 기존 설정 파일 전체가 로드 실패한다. 받아들이되
무시하는 쪽이 피해가 작다.

## T20 (P1) — 미인증 바디 무제한 버퍼링

`POST /opencodex-session`은 자격증명 없이 도달 가능한데, 바디 제한이
`Content-Length`에 의존했다. 헤더를 생략하면 `Number(null ?? "0")`이 0이고,
chunked를 쓰면 헤더 자체가 없다. 둘 다 사전 검사를 통과해 `req.text()`에
도달했고, 그건 끝까지 버퍼링한다. 사후 검사는 이미 프로세스가 붙들도록
강요당한 문자열을 잰 것이다.

읽는 중에 limit+1에서 멈추고 바디를 cancel하도록 바꿨다. 회귀 테스트는
4 KiB 제한에 512 KiB를 `Content-Length` 없이 스트리밍하고, 서버가 제공된
청크보다 적게 당겼음을 단언한다.

**레드-퍼스트 확인:** 수정 전 코드로 되돌려 이 테스트가 실제로 실패하는 것을
확인한 뒤 다시 적용했다. 경계값(정확히 4096바이트)이 여전히 통과하는 것도
함께 고정했다.

## 검증

- `bun run typecheck` 통과.
- 포커스드 7파일 **348 pass / 0 fail**
  (server-auth, server-management-auth, config, cli-dispatch, cli-registry,
  gui-pair-capability, gui-pair-client).
- `server-management-auth` 35건 전부 통과 — D1 계약 반전 테스트 포함.

## 남은 것

T21(`hub.managementPublicOrigin`, `remoteGui.allowedTailscaleUsers`,
retired `allowInsecureHttp` 문서화)은 wp8에서 처리한다.
draft 해제도 wp8에서 CI 그린 확인 후.

## 커밋

| 커밋 | 내용 |
| --- | --- |
| `1e3f7d2b7`→재적용 | feat(remote-gui): add remote session issuance and pairing |
| `129a64184`→재적용 | fix(remote-gui): harden identity and capability replay checks |
| `53986b612`→재적용 | test(remote-gui): cover remote session consent boundaries |
| `6c8dd333e`→재적용 | fix(remote-gui): enforce exact bootstrap destination |
| `0c6670e88`→재적용 | test(remote-gui): lock replay and expiry negatives |
| `2d1262bc5` | fix(remote-gui): preserve renewal and mutation origin checks |
| `b7282858b` | fix(remote-gui): drop plaintext pairing and bound the unauthenticated exchange body (신규) |

원본 6커밋은 authorship과 메시지를 보존했고, 계약 변경은 마지막 조정 커밋
하나로 모았다. wp2와 같은 이유다 — 원저자의 커밋을 내가 편집한 것처럼
보이게 만들지 않는다.
