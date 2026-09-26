---
title: ChatGPT 데스크톱 전송 잠금 해제
description: 계정 사용량 한도가 소진되어도 ChatGPT 데스크톱 앱의 입력창을 계속 쓸 수 있게 합니다(macOS, 옵트인).
---

로그인한 ChatGPT 계정의 사용량 한도가 소진되면 ChatGPT 데스크톱 앱은 전송 버튼을 비활성화합니다.
그 대화의 모델 호출을 opencodex가 다른 프로바이더로 라우팅하는 경우에도 마찬가지입니다. 이 옵트인
macOS 통합은 입력창을 계속 쓸 수 있게 합니다. 기본값은 꺼짐입니다.

## 바뀌는 것

opencodex는 `chatgpt.com`용 로컬 TLS 리스너를 실행합니다. 앱은 `chatgpt.com`을 이 리스너로 보내는
Chromium 스위치와 함께 실행되며, 서브도메인을 포함한 다른 모든 호스트는 평소 경로를 유지합니다.
요청은 앱 자신의 자격 증명으로 실제 `chatgpt.com`에 중계되고, WebSocket(음성 받아쓰기 등)도
중계됩니다. 아무것도 기록하거나 저장하지 않습니다.

응답은 다음 두 엔드포인트를 제외하고 그대로 전달됩니다.

- 대화 메타데이터(`/backend-api/conversation/init`와 대화 스트림): 사용량 한도로 인한 전송 잠금을 제거합니다.
- 사용량 스냅샷(`/backend-api/wham/usage`): "한도 도달" 게이트를 엽니다.

구독 필요 등 다른 이유의 전송 잠금은 그대로 두며 `ocx chatgpt status`에 표시됩니다. 표시되는
사용량(비율, 초기화 시각, 배너)은 바뀌지 않으며, OpenAI 서버는 자체 요청에 모든 한도를 계속 적용합니다.

## 설정

1. `~/.opencodex/config.json`에서 기능을 켜고 opencodex를 다시 시작합니다.

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   리스너는 프록시 포트에 200을 더한 포트(기본 `10300`)를 씁니다. 다른 포트를 쓰려면
   `chatgptDesktop.port`를 설정합니다.

2. 로컬 인증 기관을 한 번만 신뢰합니다. 이 명령은 로그인 암호를 묻기 때문에 직접 실행하세요.

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   이 신뢰가 없으면 앱이 계정, 사용량, 설정 페이지를 불러오지 못합니다. opencodex 홈을 바꿔 쓰는
   경우 `ocx chatgpt status`가 환경에 맞는 정확한 명령을 출력합니다.

3. opencodex를 통해 앱을 실행합니다.

   ```bash
   ocx chatgpt launch
   ```

4. 선택: Dock과 Spotlight에서 평소처럼 실행해도 경로를 쓰게 합니다.

   ```bash
   ocx chatgpt install-watcher
   ```

   감시자는 앱이 시작될 때마다 동작합니다. opencodex가 실행 중일 때 앱이 평소 방식으로 열리면,
   실행 직후 앱을 종료하고 경로와 함께 다시 엽니다. 이미 사용 중인 앱에는 아무것도 하지 않고,
   opencodex가 실행 중이 아닐 때도 아무것도 하지 않습니다. 이 명령은 확인을 요청하며, `--yes`로
   비대화식으로 확인할 수 있습니다.

## 네트워크 환경

VPN이나 프록시 규칙을 설정할 필요가 없습니다. 기본 모드에서는 실행 인자가 앱이 시작될 때마다 시스템
프록시에 따라 정해집니다.

| 환경 | 앱 실행 인자 |
|---|---|
| 프록시 없음 | `chatgpt.com` 경로만. |
| 시스템 프록시 모드 VPN | 경로, 직접 연결 폴백이 있는 시스템 프록시, `chatgpt.com`만 우회. |
| TUN 모드 VPN | 경로만. 루프백 트래픽은 터널에 들어가지 않습니다. |
| PAC 파일 | 경로만. PAC 파일이 `chatgpt.com`을 프록시에 남길 수 있어 입력창이 잠긴 채로 있을 수 있지만, 다른 기능은 망가지지 않습니다. |

opencodex는 다른 외부 트래픽과 마찬가지로 자체 `proxy` 설정으로 실제 `chatgpt.com`에 접속합니다.

## opencodex를 멈춰도 앱 계속 쓰기

기본 모드에서는 경로가 적용된 앱이 리스너에 의존합니다. opencodex가 멈춰 있는 동안 `chatgpt.com`
요청은 실패합니다. PAC 폴백은 대신 생성된 PAC 파일로 앱을 실행하므로, 앱이 스스로 폴백합니다.

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback`은 `unblockSend`와 함께일 때만 적용됩니다. 이때 opencodex는 리스너 포트 + 1(기본값
`10301`)에서도 대기하고, 시작할 때마다 홈 디렉터리의 `chatgpt-unblock.pac`을 다시 씁니다. PAC는
`chatgpt.com`을 먼저 opencodex로 보내고, 다른 호스트는 시스템 경로대로 보냅니다.

| 환경 | 다른 호스트, 그리고 opencodex가 멈춘 동안의 `chatgpt.com` |
|---|---|
| 프록시 없음 또는 TUN 모드 VPN | 직접 연결. |
| 시스템 프록시 모드 VPN | 시스템 프록시, 그다음 직접 연결. |
| PAC 파일 | 시스템 PAC(생성된 파일에 포함). |

opencodex가 멈춰도 앱은 재시작 없이 이 경로로 계속 동작하며, 보내기 잠금 해제만 opencodex가 돌아올
때까지 멈춥니다. 경로는 opencodex가 시작될 때 가져옵니다. VPN 모드를 바꾼 뒤에는 opencodex를 다시
시작하고 `ocx chatgpt launch`를 실행하세요. 그 시점에 시스템 PAC가 설정되어 있지만 읽을 수 없으면 다른
호스트는 직접 연결되고 opencodex가 경고를 출력합니다.

`pacFallback`을 켜거나 끈 뒤에는 opencodex를 다시 시작하고 `ocx chatgpt launch`를 실행하며, 감시자를
쓰고 있다면 `ocx chatgpt install-watcher`도 다시 실행하세요.

## 상태 확인

```bash
ocx chatgpt status
```

기능이 켜져 있는지, 포트의 리스너가 opencodex 것인지, 인증서가 신뢰되는지, 감시자 상태, 실행 중인
앱이 경로를 갖고 있는지, 의도적으로 남긴 전송 잠금을 보고합니다.

## 끄기

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore`는 경로가 적용된 앱을 기본 네트워크로 다시 엽니다. 그런 다음
`chatgptDesktop.unblockSend`를 `false`로 설정하고 opencodex를 다시 시작합니다. 인증 기관은
opencodex의 Claude 통합과 공유되므로, 둘 다 쓰지 않을 때만 신뢰를 제거하세요.

## 문제 해결

- **계정, 사용량, 설정 페이지가 로드되지 않음:** 인증서가 신뢰되지 않았습니다. 2단계를 다시
  실행하세요. `ocx chatgpt status`가 신뢰 상태를 보여 줍니다.
- **전송 버튼이 여전히 회색:** `ocx chatgpt status`를 확인하세요. 앱이 경로 없이 실행 중이거나
  (`ocx chatgpt launch` 실행), 잠금 이유가 사용량 한도가 아니어서 "send blocks kept"에 표시될 수 있습니다.
- **opencodex를 멈추면 앱이 아무것도 불러오지 못함:** 기본 모드에서는 경로가 적용된 앱이 리스너에
  의존합니다. opencodex를 다시 시작하거나 `ocx chatgpt restore`를 실행하세요. PAC 폴백을 켜면 앱이
  스스로 폴백합니다.
