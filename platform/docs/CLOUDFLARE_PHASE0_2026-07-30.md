# Cloudflare Mesh private-hostname Phase 0 — 2026-07-30

## 결론

실제 Cloudflare account와 `opencodexpages.me` zone에서 Linux Cloudflare Mesh node → private hostname route → dedicated Cloudflare Tunnel → RFC1918 origin 경로가 통과했다. 일반 WARP client만이 아니라 central Gateway 역할의 headless Mesh node에서도 확인했다.

Phase 0에서 확정된 private instance domain은 `*.private.remote.opencodexpages.me`다. 2026-07-30 운영 ingress에서는 Cloudflare Universal SSL이 바로 지원하는 `<slug>.opencodexpages.me`를 공개 instance domain으로 확정했다. 중첩 wildcard인 `<slug>.remote.opencodexpages.me`는 별도 인증서가 필요해 사용하지 않는다.

## 필수 구성

1. Gateway TCP/UDP proxy를 켠다.
2. Mesh와 client profile에서 synthetic `100.80.0.0/16`을 WARP로 보낸다. Exclude mode에서는 기본 `100.64.0.0/10` 제외를 제거한다.
3. private hostname TLD를 Local Domain Fallback에 넣지 않는다.
4. private hostname의 DNS-only A record를 먼저 만들고 고유 RFC1918 `/32`를 반환하게 한다.
5. 같은 `/32` CIDR route와 hostname route를 dedicated Tunnel에 연결한다.
6. privileged `opencodex-remote-agent prepare-network`가 `/32`를 loopback에 할당하고 비특권 Agent runtime이 `:10101`에 bind한다.

Hostname route만 만들었을 때 DNS 합성은 가능했지만 TCP가 `No route to host`로 실패했다. 좁은 CIDR route가 추가되자 Tunnel remote config의 `warp-routing.enabled`가 `true`로 바뀌고 TCP가 통과했다. `cloudflared --max-active-flows` 수동 override는 필요하지 않았다.

## 실측 결과

| 항목 | 결과 |
|---|---:|
| Mesh client | Linux `warp-cli 2026.6.880.0` |
| cloudflared | `2026.3.0`, QUIC, 4 connections |
| DNS | private hostname → synthetic `100.80.0.0/16` |
| 기본 HTTP | 200, 10회 19.37–23.68 ms |
| 100 MiB download | 104,857,600 bytes / 1.500 s |
| 100 MiB upload | 104,857,600 bytes accepted |
| SSE | 5-event smoke pass |
| WebSocket | bidirectional echo pass |
| Rust Agent assertion E2E | authorized 200, unauthorized concealed as 404 |
| Rust Agent 100 MiB download | 104,857,600 bytes / 1.707 s |
| Rust Agent 100 MiB upload | 104,857,600 bytes accepted |
| Rust Agent SSE / WebSocket | 5-event SSE and bidirectional echo pass |
| Tunnel restart | active SSE closed with curl rc 18; new HTTP recovered in 39.632 s |
| 30-minute transport SSE | pass: rc 0, 1,801 s, 1,800 events |
| 30-minute Rust Agent SSE | pass: rc 0, 1,800 s, 1,800 events |

Restart 결과 때문에 health computation은 connector connection 수가 돌아온 직후 online으로 바꾸면 안 된다. hostname data plane의 synthetic route가 회복될 시간을 포함해 Gateway synthetic health를 authoritative signal로 유지하고 최소 60초 grace를 둔다.

## 실패에서 확인한 사항

- `.internal`은 기본 Local Domain Fallback에 포함돼 Gateway DNS를 우회했다.
- DNS record보다 먼저 private hostname을 질의하면 Gateway가 zone SOA의 negative TTL 동안 NXDOMAIN을 캐시했다.
- `cloudflared` virtual DNS는 컨테이너 `/etc/hosts`의 `127.0.0.1` 매핑을 origin 주소로 사용하지 않았다.
- public DNS의 `127.0.0.1` 답은 synthetic IP로 바뀌지 않고 그대로 반환됐다.
- RFC1918 origin과 `/32` CIDR activation route를 함께 사용했을 때 Mesh/Tunnel L4가 통과했다.

## 운영 경계

- DNS record는 proxied public application route가 아니며 RFC1918 주소만 반환한다.
- private hostname label은 160-bit random 값이고 사용자 slug에서 유도하지 않는다.
- Cloudflare account credential은 Control Plane만 보유한다.
- 활성 Agent가 재연결 중인 suspend에서도 hostname route, CIDR route, DNS record를 먼저 제거하고 공식 connector-cleanup API를 호출한 뒤 Tunnel을 삭제했다. Gateway는 즉시 404로 닫혔고 Cloudflare 리소스 네 개가 모두 제거됐다.
- Phase 0의 service token, WARP enrollment app/policy/registrations, Mesh node, Tunnel, DNS/route는 측정 종료 후 모두 삭제했다. 테스트를 위해 변경한 Gateway TCP/UDP, virtual IP, split-exclude 기본값도 사전 백업과 동일하게 복원했고 활성 `ocxr-` Cloudflare 리소스가 0개임을 다시 확인했다.

[Decision Log]
- 목적과 의도: 문서상 가정이 아니라 실제 Cloudflare account에서 transport 적합성을 확정한다.
- 기존 구현 및 제약 조건: 기존 계획은 Agent의 hosts file이 private hostname을 `127.0.0.1`로 해석한다고 가정했다.
- 검토한 주요 대안: hosts loopback, public DNS loopback, custom DNS, RFC1918 loopback alias와 CIDR activation route.
- 선택한 방식: DNS-backed 고유 RFC1918 `/32`, Tunnel CIDR route, Tunnel hostname route, Agent loopback bind.
- 다른 대안 대신 이 방식을 선택한 이유: 현재 공식 API와 Linux Mesh/Tunnel 버전에서 유일하게 DNS 합성 및 TCP 종단이 함께 실측 통과했다.
- 장점, 단점 및 영향: private-only 경계는 유지되지만 네 Cloudflare 리소스의 idempotent lifecycle, connector cleanup, 60초 restart grace가 필요하다.
