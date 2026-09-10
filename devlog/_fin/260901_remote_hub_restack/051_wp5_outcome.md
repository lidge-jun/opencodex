# wp5 결과 — p4(#2781) 재스택 + 블로커 5건

브랜치 `codex/remote-hub-p4`: `44f9973a2` → `95787b9bc`.
베이스는 재스택된 `codex/remote-hub-p3@ad1ab25d8`.

## 충돌

`src/usage/summary.ts`(2회), `gui/src/pages/Integrations.tsx`.

usage/summary는 dev가 주석을 옮기고 이 단계가 그 위에 apiKeyId 필터를
얹은 구조였다. 두 필터의 층이 다르다는 점을 주석으로 명시했다: apiKeyId는
엔트리 전체를 자르고(키가 엔트리를 소유하므로), provider/model은 어트리뷰션
단위로 좁힌다(콤보 엔트리의 다른 시도 비용이 딸려오면 안 되므로).

**중간에 실수가 있었다.** 첫 해소에서 고아 마커 한 줄이 커밋에 들어갔고,
rerere가 그 잘못된 해소를 기억해 재시도에서 재현했다. 리베이스를 중단하고
원본에서 다시 시작해 마커를 제거한 뒤, 스택 전 범위에 대해
`git grep`으로 마커 0건을 확인했다.

원본 8커밋 보존.

## 블로커 5건

### `/api/machine/*` 7개 미선언 (wp6에서 재배정됨)

`tests/cli-headless-parity.test.ts:287`이 잡은 그대로다. 7개 라우트는
문서화되지 않은 게 아니라 선언되지 않은 것이었다: status/clients는
`ocx connect status`, sync는 `ocx sync`, shim은 클라이언트 통합 명령,
disconnect는 `ocx disconnect`에 대응한다. hub-relay만 자체 verb가 없는데
그건 `--management-transport relay`가 고르는 전송 경로이기 때문이다.
한 프리픽스로 선언하고 대응 관계를 주석에 적었다.

### T25 (P1) — relay가 항상 throw

`connectClient()`가 "relay management transport is not available before
Remote Hub Phase 4"를 던졌다. **그런데 이 단계가 Phase 4다.** 머신 리스너와
hub-relay가 모두 여기서 랜딩한다. Phase 3의 가드가 남은 것이고, 문서화된
옵션이 항상 실패하는 상태였다.

### T26 (P1) — supervised 클라이언트가 disconnect 후 안 돌아온다

`scheduleStandaloneRecycle()`이 `OCX_SERVICE=1`이면 자가 재시작을 건너뛴다.
그것 자체는 옳다 — supervisor가 프로세스를 소유하므로 두 번째 복사본은
포트를 두고 다툰다. 문제는 그 다음 `process.exit(0)`이다.

실제 supervisor 설정은 전부 failure-only다: systemd `Restart=on-failure`,
WinSW `<onfailure action="restart"/>`, Task Scheduler ERRORLEVEL 루프.
깨끗한 종료는 "서비스가 끝났다"로 읽혀 아무것도 재시작하지 않는다.
클라이언트가 누군가 알아챌 때까지 죽어 있었다.

supervised일 때 exit 1로 바꿨다. 대시보드 recycle이 이미 쓰는 정책이고
(`src/server/management/system-restart.ts`), launchd `KeepAlive`는 어느
쪽이든 정상 동작한다.

### D1 클라이언트 측

`--allow-insecure-http`가 CLI, connect 옵션, hub-client에 남아 있었다.
허브가 이제 평문 pairing을 거부하므로 플래그를 남기면 단회용 grant를
확실한 거절에 태우는 것뿐이다. 클라이언트도 같은 규칙을 로컬에서 검사해
전송 전에 거절한다.

### D2 클라이언트 측 — 연결 자체가 깨질 뻔했다

`connect`가 `catalog.etag`가 없으면 "initial hub catalog did not include a
fresh ETag"로 **실패**했다. D2로 서버가 validator를 안 주게 됐으니 그대로면
모든 연결이 실패한다. 조건부 페치를 걷어내고, 저장하던 `catalogEtag`를
`catalogFingerprint`(우리가 쓴 바이트의 해시)로 바꿨다.

그 값은 애초에 캐시 관심사가 아니었다 — disconnect가 파일을 지우기 전에
"디스크의 이 파일이 아직 우리 것인가"를 묻는 소유권 검사이고, 서버의 참여가
필요 없다. ETag 문자열을 재사용했기 때문에 캐시처럼 보였을 뿐이다.

## 검증

- `bun run typecheck` 통과.
- 포커스드 8파일 **356 pass / 0 fail**.
- 스택 전 범위 충돌 마커 0건.

## 남은 것

T27/T28(GUI disconnect 타깃 갱신, pairing 전 페이지 게이팅), T2(연결된 GUI의
인증된 models 경로), D5(릴레이 응답 no-store)는 wp8 또는 후속 단계에서.

## 커밋

| 범위 | 내용 |
| --- | --- |
| `67c6387a5`..`da6f97a39` | 원본 8커밋 재적용 |
| `95787b9bc` | fix(two-plane): declare the machine plane, enable relay, and finish the D1/D2 client side (신규) |

앞선 단계들과 같은 원칙: 원본 커밋의 authorship과 메시지를 보존하고,
계약 변경은 마지막 조정 커밋 하나로 모은다.
