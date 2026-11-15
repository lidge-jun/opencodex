---
title: Remote Link
description: SSH로 OpenCodex Home 컴퓨터와 Child 컴퓨터를 연결합니다.
---

머신 링크는 SSH를 통해 OpenCodex **Home** 컴퓨터와 **Child** 컴퓨터를 연결합니다. Home이 SSH 터널을 통해 Child를 서비스하고, 두 컴퓨터는 각각 로컬 OpenCodex 서비스를 `10100` 포트에서 계속 실행합니다. 대시보드는 Child 전용 링크 키를 SSH로 전달하므로 토큰을 직접 입력하지 않습니다.

## 요구 사항

- Home 컴퓨터에서 OpenSSH 키 로그인으로 Child 컴퓨터에 접속할 수 있어야 합니다.
- 자식이 시작하는 링크에서는 자식에서 OpenSSH 키 로그인으로 홈에 접속할 수 있어야 합니다(비밀번호 로그인은 지원하지 않음).
- Child 컴퓨터에 OpenCodex 2.66.0 이상이 설치되어 있어야 합니다(자식이 시작하는 링크에서는 Home에도).
- 두 컴퓨터는 macOS, Linux 또는 Windows x64를 사용할 수 있습니다. Windows에는 OpenSSH Server와 Windows PowerShell이 필요하며 Git Bash와 curl은 필요하지 않습니다.
- Home에서 Child를 추가하는 대시보드는 Home에서 직접 열거나 페어링된 Hub 세션을 사용해야 합니다. 현재 컴퓨터를 Child로 전환하려면 운영자가 페어링한 대시보드 세션이 필요하며, 자격 증명 없이 발급된 로컬 세션은 이 라우팅 변경을 확정할 수 없습니다.

비밀번호 SSH는 지원하지 않습니다. Home 또는 Child에서 링크를 시작할 수 있습니다. Windows는 동일하게 고정된 OpenSSH 연결을 통해 PowerShell을 실행합니다.

## `#remote`에서 Child 추가하기

1. 대시보드에서 `#remote`를 열고 Remote Link를 켭니다.
2. **Home**을 선택한 뒤 **Continue**를 누릅니다. SSH 호스트 목록이 열립니다.
3. SSH 후보에서 호스트를 선택하거나 SSH 설정의 alias를 입력합니다.
4. 연결 테스트를 실행하고 표시된 호스트 지문을 연결하려는 컴퓨터의 지문과 비교합니다. 비교하면 SSH가 호스트를 신뢰하기 전에 잘못된 컴퓨터나 변경된 호스트 키를 발견할 수 있습니다.
5. 지문을 확인한 뒤 Child를 연결합니다.

대시보드는 토큰 입력을 요구하지 않습니다. 먼저 호스트를 검사하며, 지문을 명시적으로 확인하기 전에는 링크를 적용하지 않습니다.

Child 추가 창은 Child가 SSH를 통해 이 Home의 공급자를 사용한다는 점과 위의 사전 요구 사항을 안내합니다. 별칭은 브라우저를 표시하는 컴퓨터가 아니라 OpenCodex를 실행하는 Home의 `~/.ssh/config`에서 가져옵니다. 검색은 성공했지만 호스트가 없다면 아래와 같은 `Host` 항목을 추가하고 다시 검색하세요. 기존 별칭을 직접 입력할 수도 있으며, 별칭을 선택하거나 입력하면 연결 테스트가 활성화됩니다. 창에서 이 가이드도 열 수 있습니다.

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

검색에 실패하면 빈 목록이라고 표시하지 않고 불러오기 실패, 확인 가능한 원인과 재시도 버튼을 표시합니다. 연결 테스트의 구체적인 실패 원인과 정제된 SSH 힌트는 활성 창에만 표시하며 뒤쪽 페이지에 중복 표시하지 않습니다. 원인과 아래 SSH 진단 방법을 확인하고 다시 시도하세요. 다시 검색해도 입력한 별칭은 유지되지만 연결 전에 지문을 새로 확인해야 합니다.

## 이 컴퓨터를 Child로 연결하기

Home의 프로바이더를 사용할 컴퓨터에서 다음을 진행합니다.

1. 대시보드에서 `#remote`를 열고 Remote Link를 켭니다.
2. **Child**를 선택합니다. SSH 호스트 목록이 열립니다.
3. Home의 SSH 호스트를 선택하고 연결 테스트를 실행한 뒤, 호스트 지문을 비교하고 확인합니다.
4. 안내를 읽고 **Connect as Child**를 선택합니다.

연결하면 이 컴퓨터의 OpenCodex가 다시 시작됩니다. 이미 실행 중인 Codex 작업은 먼저 끝나고, 다시 시작되는 동안 최대 1분 정도 새 요청이 실패할 수 있습니다. 그 뒤 대시보드가 스스로 새로 고쳐지고 Child 링크를 보여 줍니다. Codex는 이 컴퓨터의 `http://127.0.0.1:<port>/v1`을 그대로 사용하며 토큰이나 환경 변수를 설정할 필요가 없습니다. 로컬 OpenCodex가 각 요청을 Home으로 전달하고, Home은 자신의 프로바이더와 계정으로 응답합니다.

**Child**에 이 컴퓨터를 먼저 페어링하라는 안내가 나오면, 이 컴퓨터에 설정된 IP 주소 형식의 HTTP 루프백 대시보드(예: `http://127.0.0.1:<configured-port>`)를 여세요. 로컬 페어링 양식은 페어링이 필요하고 대시보드와 API가 같은 루프백 출처를 사용할 때만 표시됩니다. 양식의 `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` 명령을 복사해 이 컴퓨터의 터미널에서 실행한 뒤, 일회용 코드를 양식에 붙여 넣으세요. 양식에 표시된 정확한 출처를 사용해야 하며, 프로바이더 API 키나 관리자 토큰은 페어링 코드가 아닙니다. 페어링 누락과 설정된 포트의 불일치는 서로 다른 사유입니다.

**Child** 역할을 선택하려면 OpenCodex가 독립형 런타임으로 설정된 포트에서 실행 중이어야 합니다. Child는 정확히 그 포트에서 다시 시작하기 때문입니다. 대시보드가 설정된 포트에서 실행되고 있지 않다고 알리면, 먼저 그 포트에서 OpenCodex를 다시 시작하세요.

## 링크 상태

- **Connected**는 SSH 터널이 준비되어 Child가 Home 링크를 사용할 수 있다는 뜻입니다.
- **Reconnecting**은 터널을 다시 연결하는 중이라는 뜻입니다. 재시도 중에는 요청이 일시적으로 `Retry-After`와 함께 `503`을 반환할 수 있습니다. 자기 대시보드에서 연결한 Child에서는 요청이 먼저 터널이 돌아오기를 최대 15초 기다립니다.
- **Failed**는 조치가 필요하다는 뜻입니다. SSH 인증, 확인한 호스트 키, 포워딩 또는 타임아웃 사유를 확인하세요. SSH 터널을 띄운 쪽이 절전, 장애, 재시작 뒤에도 스스로 다시 시도합니다. Home이 추가한 Child라면 Home이, 자기 대시보드에서 연결한 Child라면 Child가 시도합니다. 타임아웃이나 포워딩 오류 뒤에는 1분 뒤에 다시 시도하고, 다시 실패할 때마다 간격을 두 배로 늘려 최대 5분마다 시도합니다. 인증 오류 뒤에는 5분마다 시도합니다. 호스트 키가 바뀐 경우에는 다시 시도하지 않습니다. 바로 다시 연결하려면 Home 대시보드에서 **Retry**를 누르거나 Home에서 `ocx link reconnect --link-id <id>`를 실행하세요. OpenCodex를 재시작하지 않고 그 링크의 터널만 다시 띄웁니다.

링크가 실패해도 로컬 프로바이더로 조용히 전환하지 않습니다.

## Child 제거하기

Child의 **Disconnect**를 선택하고 alias를 확인합니다. Home은 터널을 중지하고 해당 Child의 링크 키를 폐기한 뒤 저장된 링크 기록을 삭제합니다. 경량 에이전트(`ocx-child`)로 연결된 Child는 기본적으로 빠른 재연결을 위해 `~/.cache/opencodex/bin/ocx-child` 파일을 남겨두며, 확인 대화상자에서 **심어둔 경량 에이전트 파일까지 원격 컴퓨터에서 함께 삭제**를 선택하거나 `ocx link revoke --link-id <id> --purge`를 실행하면 에이전트 파일까지 함께 삭제합니다. Home은 이 삭제를 `PATH`에 있는 다른 `ocx-child`가 아니라 `~/.cache/opencodex/bin/ocx-child`(Windows에서는 `%LOCALAPPDATA%\opencodex\bin\ocx-child.exe`)에 심어둔 파일로 실행합니다. 그 파일이 없거나 Child가 파일을 삭제했다고 확인하지 않으면 Disconnect는 오류를 보고하고 링크를 그대로 남겨 두므로, 다시 시도하거나 삭제 옵션 없이 연결을 해제하거나 파일을 직접 지울 수 있습니다. `--purge`는 경량 Child에만 적용됩니다. 전체 OpenCodex 설치에서는 Home이 거부하고, Home이 Child 종류를 기록하기 전에 저장된 링크라면 먼저 Child를 확인합니다.

Home에서 Child의 연결 해제 명령을 실행할 수 없으면 **Remove here only**를 선택합니다. 그러면 이 컴퓨터의 터널, 키, 기록만 삭제됩니다. 그 다음 Child에 로그인하여 실행합니다.

```bash
ocx disconnect   # 경량 모듈 Child인 경우 ~/.cache/opencodex/bin/ocx-child detach
```

자식 연결을 끊으려면 자식에서 `ocx disconnect`를 실행합니다. 이 명령은 클라이언트 터널을 끊고 SSH를 통해 홈에서 링크를 폐기합니다. 홈에서 폐기하지 못하면 다음 문구를 출력합니다: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## 기기별 Route to

Home의 Route to 의도는 Child에 기본으로 동기화됩니다. 각 기기는 자신의 설치된 클라이언트, 경로, 수신 포트, 제공 모델 카탈로그로 설정을 생성합니다. 우선순위는 기기 override > Home 기본값 > 내장 기본값(Codex·Claude Code만 켜짐)입니다.

등록 시 클라이언트를 명시적으로 선택하지 않으면 Child는 Home 기본값과 이후 변경을 상속합니다. 클라이언트별 명령은 해당 클라이언트의 실패를 반환하고 다른 클라이언트의 미해결 충돌은 경고하며, 전체 sync는 모든 미해결 실패를 보고합니다. Claude Desktop first-party 모드는 이미 OpenCodex를 거치므로 켜기 의도는 아무것도 쓰지 않고 `current`로 표시합니다. 끄기 의도는 실행할 모드 전환 명령(Home에서는 `ocx integrations native claude-desktop off`, Child에서는 `ocx claude desktop apply --gateway` 후 `ocx route to sync`)을 알려 주는 충돌로 표시합니다.

Home 자신에서 Codex, Claude Code, Grok, Claude Desktop은 Home의 켜기/끄기 스위치를 따릅니다. `ocx restore`, `ocx restore back`, `ocx claude desktop apply`, Messages API 끄기, 에이전트 설정, 대시보드 토글이 바꾸는 바로 그 스위치입니다. 명시적인 `false`만 꺼짐이고 설정하지 않은 스위치는 켜짐입니다. Home 기본값과 기기 override는 Home에서 이 네 클라이언트를 결정하지 않습니다. 어떤 route 쓰기도 결정하고 있지 않은 Grok·Claude Desktop 스위치가 설정되지 않았거나 켜져 있으면 시작 시 동작과 같은 범위만 적용합니다. Grok은 시작 시 동기화 규칙을 따르고, Claude Desktop은 OpenCodex가 이미 소유한 gateway 프로필만 갱신하며 새로 만들거나 Desktop 모드를 바꾸지 않습니다. OpenCodex가 쓴 뒤 바뀐 소유 프로필은 갱신하지 않고 충돌로 보고합니다. OpenCodex가 소유한 적 없는 Desktop 라이브러리는 건드리지 않고 current로 보고하므로 전체 sync가 이 때문에 실패하지 않습니다. Desktop 프로필을 만들려면 `ocx route to claude-desktop on --device home`(또는 `ocx route to claude-desktop on`)을 실행하세요. 이것만으로 Child의 Grok·Claude Desktop이 켜지지는 않습니다.

Child는 Home의 스위치를 읽지 않습니다. Child는 기기 override, 저장된 Home 기본값, 내장 기본값 순으로 따릅니다. Home은 이 네 클라이언트의 기본값을 한 번만 저장합니다. Codex와 Claude Code는 저장 시점의 Home 스위치 값(명시적으로 끄지 않았다면 켜짐)으로, Grok과 Claude Desktop은 꺼짐으로 저장합니다. Home 기본값 쓰기(`--device` 없는 `ocx route to <client> on|off`)와 Child 등록은 항상 저장합니다. Home에 링크가 있으면 Home 전용 작업이 스위치를 바꾸기 전에도 저장합니다. 링크 리스너를 시작할 때, 그리고 `ocx restore`, `ocx restore back`, `ocx claude desktop apply`, Messages API 끄기, Claude 토글, native 토글, `--device home` route 쓰기 안에서입니다. Home 전용 통합 변경(대시보드 토글, `ocx integration client enable|disable`, 통합 기록에서의 되돌리기, Aside 프로필 변경) 전에는 링크가 있는 Home이 Child가 상속하는 모든 기본값을 파일 통합까지 포함해 저장하며, 링크 리스너도 시작할 때 같은 일을 합니다. 그래서 이 네 기본값만 저장하던 버전에서 업그레이드한 Home도 무엇이 바뀌기 전에 나머지를 고정합니다. 경량 `ocx-child` 링크는 여기서 링크로 세지 않습니다. route 의도를 읽지 않으므로 경량 링크만 있는 Home에는 보호할 Child가 없습니다. 링크가 없는 Home에서는 이 Home 전용 명령이 기본값을 저장하지 않으므로, 나중에 등록한 Child는 등록 시점의 스위치 값을 상속합니다. 단, Home 기본값 쓰기로 기본값이 이미 저장되어 있으면 그 값을 상속합니다. 이전 기본값 쓰기로 이미 route 의도를 쓰고 있는 Home이라면, Home 전용 통합 변경은 `ocx sync`가 유지하도록 Home 자신의 행으로 기록되며, 이 행은 Child가 상속하지 않습니다. 링크 리스너가 시작할 때 저장에 실패하면(예: 다른 프로세스가 설정 잠금을 잡고 있을 때) 백그라운드에서 계속 다시 시도합니다. `ocx route to status`나 Child가 route 의도를 읽는 것은 아무것도 저장하지 않습니다. 그 뒤 Child가 상속하는 값은 Home 기본값 쓰기로만 바뀝니다. 위의 Home 전용 명령은 Home만 바꿉니다. 저장된 route 의도 파일(OpenCodex 설정 디렉터리의 `route-intent.json`)을 읽을 수 없으면, 링크가 있는 Home의 이 명령들과 모든 `ocx route to` 변경은 아무것도 바꾸지 않고 거부하며, 고치거나 지울 파일을 알려 줍니다. 링크가 없는 Home에서는 native 토글, `ocx restore`, Home 전용 통합 변경이 그대로 동작합니다. 이때 통합 변경은 아무것도 기록하지 않으며, `ocx sync`도 이 파일을 읽지 못하므로 그 변경을 되돌릴 수 없습니다.

`ocx route to <client> on|off --device home`이 Codex, Claude Code, Grok, Claude Desktop을 결정하면 먼저 그 클라이언트의 스위치를 저장한 뒤 적용합니다. 적용이 충돌이나 실패로 끝나면(예: 외부 Codex provider, 불완전한 Grok 블록, 바뀐 Claude Desktop 프로필) 명령은 실패하고 스위치가 저장되었는지 알려 줍니다. "The Home's grok switch was saved, but applying it ended in conflict"는 스위치가 바뀌었다는 뜻이고, "The Home did not apply"는 아무것도 바뀌지 않았다는 뜻입니다. first-party 모드의 Claude Desktop은 저장하기 전에 거부합니다.

이 Home이 route 의도를 쓰기 시작하면(저장된 기본값이나 Home override가 있으면) `ocx sync`는 Home의 모든 클라이언트에 route 의도를 적용합니다. 그래서 Home 전용 통합 변경은 그 클라이언트에 대한 이 Home의 결정으로 기록되고 `ocx sync`가 유지합니다. 대시보드 토글, `ocx integration client enable|disable`(같은 Home 전용 결정이며, Child가 상속하는 값은 `ocx route to <client> on|off`로 바꿉니다), 통합 기록에서의 되돌리기, Aside 프로필 변경이 여기에 해당합니다. Aside는 변경 뒤 Home이 라우팅하는 모든 프로필의 안정적인 Aside userId로 기록합니다. 링크된 Child는 기본값을 그대로 따릅니다. Aside의 `accounts.json`에 안정적인 userId가 없는 프로필이 있으면 이런 Home의 Aside 프로필 변경은 아무것도 바꾸기 전에 거부합니다(`route_intent_aside_unresolved`). 명세를 고치거나 `ocx route to aside on|off --device home`으로 Home의 Aside를 직접 결정하세요. 이 명령은 Home의 `devices.home.aside` 결정을 저장하며, 이후 `ocx sync`도 그 결정을 유지합니다. Child의 기본값을 확인할 수 없는 경우에는 `--device` 없이 `ocx route to aside on|off`로 기본값을 정하기 전까지 별도 Aside 결정이 없는 Child가 route 의도를 동기화할 수 없습니다. 해당 Child의 상태는 `unresolved`로 남으며, Child에 직접 지정한 결정은 계속 적용됩니다. route 의도를 쓰기 전부터 이런 프로필을 라우팅하던 Home(예: 링크가 있는 상태로 업그레이드한 경우)에서도 `ocx sync`는 계속 동작합니다. Aside를 결정하거나 명세를 고치기 전까지 sync는 Aside를 그대로 두고 나머지 클라이언트만 적용하며, 해결 방법을 알려 줍니다. `ocx route to sync`도 같게 동작하며, 이 명령과 `ocx route to status`는 Aside의 의도를 `off`가 아닌 `unresolved`로 표시하고 같은 안내를 보여 줍니다.

```sh
ocx route to status --device all --json
ocx route to aside on --accounts all
ocx route to aside on --device my-child --accounts stable-aside-user-id
ocx route to pi off --device my-child
ocx route to pi inherit --device my-child
ocx route to sync --device my-child
```

`--device` 없는 Home 쓰기는 기본값을 바꾸고 Home에는 지정한 클라이언트만 같은 적용 경로로 반영합니다. Codex, Claude Code, Grok, Claude Desktop은 Home의 스위치를 써서 반영하므로 `ocx route to codex off`는 Home의 Codex를 끄고 Child가 상속하는 기본값도 바꿉니다. `--device home`(Home에서는 `this`)은 Home만 결정합니다. 이 네 클라이언트는 Home의 스위치만 쓰고 Child 기본값은 그대로 두며, `inherit`는 Home의 스위치를 현재 기본값(저장된 기본값이 없으면 내장 기본값)으로 맞춥니다. 다른 클라이언트는 Home override를 기록합니다. 다른 클라이언트에 대한 route 쓰기, `ocx route to sync`, Home에서 실행한 일반 `ocx sync`는 Home의 native 스위치를 바꾸지 않고 각 스위치가 가리키는 상태만 갱신하므로 `ocx restore`, `ocx restore back`, Messages API 끄기, 대시보드 토글을 되돌리지 않습니다. Child는 다음 동기화 tick에 반영합니다. Home이 추가한 Child는 명시적 sync로 즉시 적용합니다. `--overwrite-conflict`(`ocx route to`나 `ocx sync`)를 쓰면 Home은 OpenCodex 2.100.0 이상인 Child에서만 그 sync를 실행합니다. 이전 버전은 이 플래그를 무시하고 일반 sync를 성공으로 보고하기 때문이며, 그런 Child는 `child-ocx-lacks-overwrite`로 건너뜁니다. Child가 먼저 연결한 링크는 인증된 읽기 watch를 유지하며, Home sync가 이를 즉시 깨웁니다. 적용 보고가 도착하기 전에는 `pending`으로 표시하고, 활성 watch가 없으면 다음 tick을 기다린다고 안내합니다. 이 링크의 충돌 덮어쓰기는 Child에서 사람이 `ocx route to sync --overwrite-conflict`로 허용해야 합니다. Child의 로컬 sync는 즉시 적용합니다.

Aside 계정은 로컬 `u/N` 번호가 아닌 **userId**로 선택합니다. `all`은 해당 기기의 모든 계정 프로필, `none`은 선택 없음입니다. Child의 일반 쓰기는 실행할 정확한 Home 명령을 안내하며 거부합니다. Child 사용자는 `ocx route to aside off --local`로 자신의 기기만 제외하고 `inherit --local`로 복귀할 수 있습니다. 로컬 `on`은 허용하지 않습니다. 연결된 Child에서 실행한 native 명령보다도 Home 의도가 우선합니다. 그곳의 `ocx restore`는 약 1분 뒤 다음 동기화가 Home 의도를 다시 적용할 때까지만 Codex 라우팅을 끕니다. 해당 Child에서 Codex를 계속 끄려면 `ocx route to codex off --local`을 사용하세요. Child는 1분마다 조정하며, 적용할 때마다 무엇을 바꾸기 전에 이전 적용 확인을 철회하므로 적용 중에 보낸 상태 보고는 다음 보고 전까지 잠시 미적용으로 보일 수 있습니다. 적용 중단이나 로컬 제외가 발생하면 Home의 이전 적용 확인을 철회합니다. 의도나 카탈로그 조회가 지연된 명시적 로컬 sync는 캐시된 off 상태가 정리되어 있어도 0이 아닌 종료 코드를 반환합니다. 토글에서 생략한 계정·모델 이름 정책은 유지됩니다. 소유 기록이 있는데 Aside 계정 명세에서 사라진 프로필은 소유권을 해결하기 전까지 완료로 표시하지 않습니다.

상태 JSON은 `ocx.route-to/1`이며 의도·출처·적용 결과를 구분합니다. 출처는 `builtin`, `default`, `device`, `local`(Child 제외)이며, Home의 Codex·Claude Code·Grok·Claude Desktop 행은 Home 자신의 스위치를 뜻하는 `native`로 표시합니다. `not_installed`, `conflict`, `failed`는 성공으로 처리하지 않습니다. 의도가 바뀌면 이전 충돌이나 실패를 포함한 이전 결과는 모두 `stale`이 됩니다. 충돌 덮어쓰기는 해당 실행의 명시적 `--overwrite-conflict`가 필요합니다. 쓰기가 route 정책이나 Home 스위치를 저장한 뒤 적용이 예상치 못하게 실패하면 오류가 그 사실을 알리고 `desiredCommitted: true`를 담습니다. 경량 `ocx-child` Child는 `ocx sync`로 Home 카탈로그만 갱신하며 route 의도를 읽지 않습니다. `ocx route to status`는 이 Child를 `route intent unsupported (ephemeral-child-no-route-intent)`로 표시하고, 이 Child를 `--device`로 지정한 route 쓰기와 `ocx route to sync --device`는 아무것도 바꾸기 전에 `409 route_intent_unsupported`로 거부하며, `ocx route to sync --device all`은 접속하지 않고 `unsupported`로 보고합니다. 등록할 때 route 의도를 저장하지 않으며, `ocx sync`는 `--overwrite-conflict`가 있어도 일반 카탈로그 sync를 보냅니다. 자세한 동작은 [영문 가이드](/guides/remote-link/#route-clients-per-device)를 참고하세요.

기존에 소유권 기록이 있는 연동은 Home 기본값으로 이전합니다. 명시적인 `connect --clients` 선택은 초기 기기 override로 유지하며, Home의 해당 기기 `on|off|inherit`가 그 선택을 대체합니다. Child 보고는 Home 정책을 변경하지 않습니다.

Home이 결정한 클라이언트를 Home에 적용하지 못하면 그 쓰기는 실패합니다. first-party 모드인 Home에서 `ocx route to claude-desktop off`를 실행하면 `--device home` 여부와 관계없이 409로 응답하고, 해당 클라이언트의 충돌과 모드 전환 명령을 알려 주며, CLI는 0이 아닌 코드로 끝납니다. Home의 스위치를 쓰지 못한 경우도 같습니다. 기본값 쓰기라면 Child 기본값은 그대로 저장됩니다.

연결된 Child는 Home의 실효 의도를 자신의 Codex, Claude Code, Claude Desktop, Grok 켜기/끄기 스위치에 기록합니다. Claude Code를 끄면 Messages API 설정도 고정될 수 있습니다. Child는 처음 바꾸기 전에 각 스위치의 독립형 값을, 설정되지 않았던 상태까지 포함해 기록합니다. `ocx disconnect`와 실패한 등록은 그 값을 되돌립니다. 실패한 등록이 값을 되돌리지 못하면 서비스 토큰을 유지하고 복원하지 못한 기록 파일을 알려 줍니다. 보고된 문제를 해결한 뒤 `ocx disconnect`를 실행하면 연결되지 않은 상태에서도 스위치를 복원하고 그 토큰을 제거합니다. 연결 중 사용자가 직접 바꾼 스위치는 그 값을 유지합니다. 다만 Home이 마지막으로 적용한 값과 정확히 같은 값으로 직접 설정한 스위치는 Home의 기록과 구별할 수 없어 복원됩니다. 로컬 제외(`--local`)는 해당 Child 사용자의 선택이므로 disconnect 후에도 유지됩니다.

파일 연동도 같은 방식으로 되돌립니다. 링크 후 첫 적용 때 Child는 스스로 설정해 둔 파일 연동을 기록합니다(Aside 프로필은 제외). `ocx disconnect`는 아직 설정된 연동은 유지하고, Home이 끈 연동은 다시 설정하며, 링크가 추가한 연동만 제거합니다. 로컬 제외나 연결 중 직접 작성한 블록은 유지합니다. 복원된 연동은 처음에는 Child가 Home에서 마지막으로 받은 모델 목록을 쓰며, 다음 독립형 시작 때 로컬 카탈로그로 갱신됩니다. 이 기록을 남기는 버전을 실행하기 전에 이미 Home의 route 의도를 적용한 Child에는 기록이 없으므로, `ocx disconnect`는 링크가 소유한 연동만 제거하고 Home이 끈 연동을 다시 설정하지 않습니다. disconnect 후 직접 다시 설정하세요.

disconnect는 소유한 키만 복구하므로 이후 편집한 모델·훅·신뢰 프로젝트·Computer Use 설정이 남습니다. 중단된 작업은 `ocx disconnect`로 재개하며 최초 사용한 `--keep-catalog`를 유지하세요. 소유 키 충돌이나 소유권 근거가 남은 이전 저널은 `ocx disconnect --recover-config --yes`로 현재 상태를 비공개 백업한 뒤 키 단위로 복구합니다. 소유권을 확인할 수 없거나 프로필이 편집되어 검증할 수 없으면 계속 거부합니다. 백업 경로를 보존하고, disconnect 후 `ocx service restart`로 독립형 런타임을 시작한 다음 다시 연결하세요.

## 보안

Child는 링크를 통해 Home 컴퓨터의 프로바이더와 프로바이더 인증 정보를 사용합니다. Home은 Child마다 별도의 링크 키를 만들며, 링크를 제거하면 그 키를 폐기합니다. 확인 전에 호스트 지문을 비교하여 잘못된 컴퓨터나 변경된 호스트 키를 실수로 허용하지 않도록 하세요. Tailscale identity로 발급된 대시보드 세션은 머신 링크를 관리할 수 없습니다. Child에서 키는 OpenCodex 안에만 머뭅니다. Codex나 Claude Code가 Child에서 보내는 인증 정보는 Home으로 전달되지 않으며, Child에서 `127.0.0.1:<port>`에 접근하는 프로그램은 키 없이 Home을 사용합니다. 이는 독립형 설치가 로컬 프로그램에 주는 것과 같은 신뢰 수준입니다. 다른 사이트의 웹 페이지는 거부됩니다.

## CLI 레퍼런스

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--plant] [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--purge] [--force --yes] [--json]
ocx link reconnect --link-id <id> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

비대화형 실행(TTY 없음)에서는 `--expect-fingerprint`가 필수입니다. 대화형 터미널에서는 옵션을 생략할 수 있지만, 제시된 지문을 명시적으로 확인해야 합니다.

대시보드와 `ocx integrations native <client> on|off`의 native 토글은 Home의 스위치를 바꾸고 해당 클라이언트의 전환(Claude Desktop first-party 전환 포함)을 실행하여 Child 기본값을 유지하며, Home에 대한 route 의도는 기록하지 않습니다. 이전 버전이 저장한 이 네 클라이언트의 Home override는 무시하고 다음 route 변경 때 제거합니다. Child에서 CLI는 거부하고 해당 기기의 Home 명령을 출력합니다. 링크를 폐기하면 그 기기의 override도 정리합니다. Claude Desktop의 first-party 모드는 보존합니다. 켜기 의도는 쓰기 없이 `current`이며, 끄기 의도는 모드 전환을 마칠 때까지 conflict로 표시합니다.

Home에서 `ocx link check (--link-id <id> | --all)`를 실행하면 Home이 추가한 각 Child의 설치 버전, 설치 종류, 업데이트 경로를 읽습니다. 링크의 SSH로 Child의 `ocx update --plan`을 실행하며(Child마다 60초, 동시에 세 대), 이 명령은 계획만 계산하고 아무것도 바꾸지 않습니다. 2.97.0보다 오래된 Child는 `owner-action`(`legacy-ocx`)으로 표시되고, 버전은 macOS와 Linux에서는 읽기 전용 SSH 호출을 한 번 더 해서, Windows에서는 링크로 보고된 버전에서 가져옵니다. Child 쪽에서 연결한 링크와 `ocx-child` Child는 SSH 없이 보고됩니다. `ocx link status --json`은 각 행에 `child` 블록(버전, 버전 차이, 카탈로그 최신 여부, 활동, 마지막 작업)을 추가합니다. 자세한 내용과 종료 코드는 [Child install, catalog and activity](/guides/remote-link/#child-install-catalog-and-activity)(영문)를 참고하세요.

### Home에서 Child 운영하기

`ocx link sync`, `ocx link restart-codex`, `ocx link update`는 Home이 추가한 Child에서 링크의 SSH 연결로 실행되며 작업을 JSON으로 출력합니다. `sync`는 고정된 `ocx sync --expect-link`를 실행합니다(Child 2.93.0 이상). `restart-codex`는 동기화한 뒤 Child의 Codex app-server를 재시작해 실행 중인 Codex가 현재 카탈로그를 읽게 합니다. `--scope codex`는 데스크톱 앱도 다시 실행합니다. 재시작은 링크 하나만 지정합니다. `restart-codex`와 `--restart-codex`에는 `--yes`가 필요하지만 `ocx link sync --link-id <id> --restart-app-server-only`는 확인 없이 app-server를 재시작합니다. Home이 그 Child의 모델 요청을 중계하는 동안에는 재시작을 건너뜁니다(`restart-skipped:link-active`). 2.69보다 오래된 Child에서는 스트리밍이 아닌 요청이 응답이 시작된 뒤에야 보입니다. `update --yes`는 Child 자체 업데이트 도구로 Child의 OpenCodex를 이 Home의 버전으로만 업데이트합니다(Child 2.97.0 이상. npm과 pnpm은 Node 런처로 적용하므로 `ocx link check`도 그곳에서 읽기 전용 `node --version`을 실행합니다). 한 번에 Child 하나씩 처리하며, 적용이 성공, 실패, 롤백된 뒤에는 다시 동기화합니다. 결과를 알 수 없는 적용은 다시 실행하거나 동기화하지 않으므로 `ocx link check`로 확인하세요. 그 Child로 중계 중인 요청은 끝납니다. Windows Child는 `sync`만 지원하고, `ocx-child` Child는 재시작과 업데이트를 지원하지 않는다고 보고합니다. CLI는 루프백에 바인딩된 Home이 필요합니다. 그렇지 않은 Home에서는 이 작업을 실행할 수 없으며, 대시보드의 Remote Link 페이지에서는 Home이 추가한 Child에 대해 같은 작업을 제공합니다. 자세한 내용과 종료 코드는 [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home)(영문)를 참고하세요. 이 보호는 최선의 노력일 뿐입니다. 확인과 재시작 사이에 시작된 요청은 끝날 수 있으므로, 턴을 보존해야 하면 그 Child에서 새 요청을 멈추세요. Home은 Codex가 모델 요청이 아니라 도구를 실행하는 턴 중인지도 알 수 없으므로, 그 Child에서 Codex를 재시작하거나 OpenCodex를 업데이트하기 전에 진행 중인 Codex 턴이 끝나기를 기다리십시오. 수동 업데이트는 그 Child의 OpenCodex를 재시작하며 그 Child를 위해 아직 중계 중인 턴을 끝냅니다. 자동 업데이트는 Child가 유휴 상태가 될 때까지 기다립니다. `ocx sync --restart-children`(또는 `--restart-children=codex --yes`)는 Home 동기화를 전파할 때 모든 Child 또는 `--child <linkId>`로 지정한 Child에 같은 규칙을 적용합니다. 각 Child는 동기화되고, 중계 중인 요청이 있는 동안에는 재시작만 건너뜁니다(`restart-skipped:link-active`).

### Child 버전과 작업

Home에서는 모든 Remote Link 행에 Home이 그 Child에 대해 마지막으로 확인한 내용이 표시되며, Home이 시작한 행에는 그 Child를 제어하는 버튼도 함께 표시됩니다. 배지는 다음을 나타냅니다.

- Child의 버전과 그 옆의 `Behind Home (<home version>)`, `Same version as Home`, `Newer than Home`, 그리고 업데이트를 적용할 수 있을 때의 `Update available: <home version>`. Child가 자체 대시보드에서 시작한 링크라면 버전만 표시되고 버전 차이 배지는 없으며, `ocx-child` Child는 항상 `unknown`으로 표시됩니다.
- 설치 종류(`Desktop app`, `GOAT`, `Source checkout`), 또는 이 릴리스에서 이름을 붙이지 않는 토큰은 고정폭 글꼴로 표시됩니다.
- `Catalog current` 또는 `Catalog out of date`. `Codex restart needed (<n>)`와 `Codex not running` 배지는 Child가 자신의 Codex 상태를 보고한 뒤에만 표시되며, 그 보고는 이후 릴리스에서 추가됩니다. 아직 이를 보내는 Child 릴리스가 없으므로 지금은 이 두 배지가 나타나지 않습니다.
- 마지막 작업을 `Last <operation>: <state>`로 표시하고 그 사유는 고정폭으로 표시하며, 작업이 링크를 점유하는 동안에는 실행 중인 작업을 표시합니다.

Home이 그 Child를 직접 업데이트할 수 없으면 행에 대신 무엇을 해야 하는지 표시됩니다. 그 Child의 OpenCodex Desktop에서 Check for Updates를 사용하거나, 직접 업데이트하거나, `mise`를 통해 업데이트하거나, GOAT가 처리하도록 두십시오. 알 수 없는 사유는 추측한 문장 대신 토큰으로 표시됩니다.

네 가지 작업은 CLI와 같은 작업을 시작하므로 Child에도 같은 버전이 필요합니다.

- **Check**는 `ocx link check`처럼 Child의 설치 정보를 읽습니다.
- **Sync now**는 `ocx link sync`처럼 고정된 `ocx sync --expect-link`를 실행합니다.
- **Restart Codex**는 범위를 선택하게 합니다. `Codex app-servers`는 Child의 백그라운드 app-server를 재시작해 현재 카탈로그를 읽게 하며, Codex 데스크톱 앱 자체의 app-server는 새로 고치지 않으므로 그 경우에는 데스크톱 앱을 재시작하십시오. `Codex desktop app`은 데스크톱 앱도 종료하고 다시 실행하며, 그곳에서 열린 대화가 끝납니다.
- **Update**는 `ocx link update`처럼 Child 자체 업데이트 도구로 Child의 OpenCodex를 이 Home의 버전으로 올립니다. 확인 문구에는 Child의 OpenCodex가 재시작되어 그 Child를 위해 아직 중계 중인 턴이 끝난다는 점과, 자동 업데이트는 Child가 유휴 상태가 될 때까지 기다린다는 점이 나옵니다.

**Check all**과 **Update all**은 대상이 되는 모든 Home 시작 링크에 적용됩니다. Update all도 한 번에 Child 하나씩 실행하며 다른 버전을 대상으로 삼지 않습니다. 실행 중인 작업은 Child마다 한 줄로 상태, 옮겨 간 버전(이전과 이후), 카탈로그 동기화 결과, 재시작 결과를 보여 줍니다. 작업이 끝나면 패널이 사라지고 행이 새로 고쳐집니다. Home이 더 이상 알지 못하는 작업(Home이 재시작된 경우)은 그렇다고 표시하고 각 행의 상태를 답으로 남깁니다. 작업이 링크를 점유하는 동안에는 그 링크의 작업과 Disconnect가 비활성화됩니다. 서버도 어차피 그 요청을 거부합니다.

목록 아래의 **Child automation** 패널은 `ocx link policy`와 같은 정책 파일을 보여 주고 편집합니다. 카탈로그 전파(기본값 자동), Codex 재시작(기본값 안 함), 업데이트(기본값 유휴 시 자동, 이 릴리스에서는 아직 활성화되지 않음), 유휴 기간이 있습니다. 저장할 때는 변경한 값만 씁니다. 정책 파일이 손상된 경우 패널은 자동 카탈로그 전파와 자동 업데이트가 꺼져 있다고 알리고, 그때 저장하면 선택한 모드가 그대로 유지되도록 모든 설정을 씁니다. 이 컨트롤은 서버를 우회하지 않습니다. 서버는 작업마다 정책, 링크 상태, Child 활동을 다시 확인합니다.

소유하지 않은 컴퓨터는 링크하지 마십시오. Home은 여러분의 SSH 키로 그곳에서 명령을 실행합니다.

### 카탈로그 자동 전파와 Child 정책

카탈로그 전파는 기본으로 켜져 있습니다. Home의 카탈로그가 바뀌면(카탈로그 자동 새로 고침이 변경을 보고하거나, 5분마다 하는 확인이 대시보드나 관리 API에서의 편집을 발견하면) Home은 편집이 끝나도록 60초를 기다립니다(첫 변경 후 최대 5분). 그다음 사용자의 조작 없이 대상 Child마다 백그라운드 SSH 세션을 열고, `ocx link sync`와 같은 고정된 `ocx sync --expect-link`를 실행합니다. Codex 재시작은 켜지 않는 한 하지 않습니다(아래 `childCodexRestart`). Home이 시작한 링크이고, 터널이 연결되어 있고, 다른 작업이 실행 중이지 않으며, 이 Home이 그 Child에서 마지막으로 실행한 동기화가 변경보다 이전인 Child가 대상입니다. 카탈로그를 내려받기만 한 Child는 여전히 뒤처진 것으로 봅니다. 모델 요청을 중계 중인 Child는 Codex 설정이 이미 Home과 같고 그 설정을 적용한 뒤 OpenCodex 클라이언트 런타임이 재시작된 경우에만 동기화합니다. 그렇지 않으면 동기화가 그 런타임을 재시작하기 때문입니다. 그렇지 않으면 유휴 상태가 된 뒤 동기화합니다. 실패한 동기화는 5분 뒤 다시 시도하며 간격은 두 배씩 늘어 최대 6시간이 됩니다. 2.93.0보다 오래된 Child는 다른 버전을 보고할 때까지 다시 시도하지 않습니다. 이 작업들은 다른 작업과 똑같이 표시되며 `trigger: "auto"`가 붙습니다. 링크가 없는 Home에서는 이 중 어느 것도 실행되지 않습니다.

전파로 고쳐지는 것은 Child의 카탈로그 파일입니다. Child에서 이미 실행 중인 Codex app-server는 재시작할 때까지 불러온 목록을 그대로 씁니다. `ocx link restart-codex --link-id <id> --yes` 또는 `ocx sync --restart-children`을 사용하거나, `ocx link policy --child-codex-restart app-server-when-idle`로 Home이 app-server를 재시작하게 하세요. Home은 동기화가 실행될 때 여전히 유휴 상태인 Child에서만 이를 수행합니다. 이 설정은 다음 자동 동기화부터 적용되며, 카탈로그가 이미 최신인 Child는 동기화되지 않으므로 재시작도 되지 않습니다. 그런 Child는 직접 재시작하세요.

정책은 Home의 `<configDir>/link/child-policy.json`에 저장되며 `config.json`에는 들어가지 않습니다.

| 설정 | 기본값 | 값 |
|---|---|---|
| `catalogFanout` | `auto` | `auto`, `manual` |
| `childCodexRestart` | `never` | `never`, `app-server-when-idle` |
| `updates` | `auto-when-idle` | `off`, `notify`, `auto-when-idle` |
| `idleAfterMs` | `600000` (10분) | 1~60분 |

`updates`의 기본값은 유휴 Child를 자동으로 Home 버전에 맞추는 것입니다. 자동 업데이트는 이번 릴리스에서는 아직 동작하지 않습니다. 설정은 지금부터 저장되므로 `ocx link policy --updates notify` 또는 `--updates off`로 꺼 두면 자동 업데이트가 도입될 때도 그 선택이 유지됩니다. `idleAfterMs`는 중계된 모델 요청이 없는 시간이 얼마나 지나야 Child를 유휴로 볼지를 정하며, `ocx link status`의 `activity.idle`도 이 값으로 결정됩니다.

```text
ocx link policy                                    # 정책 읽기
ocx link policy --catalog-fanout manual            # 카탈로그 자동 전파 끄기
ocx link policy --child-codex-restart app-server-when-idle
ocx link policy --updates off --idle-after-minutes 20 --json
```

`GET`과 `PUT /api/link/children/policy`는 같은 설정을 읽고 바꿉니다(루프백에서의 관리자 토큰 또는 대시보드 세션). `PUT`은 바꾸는 설정만 보냅니다. 파일이 손상되었거나 알 수 없는 값을 담고 있으면 카탈로그 자동 전파와 자동 업데이트가 꺼지고, `ocx link policy`가 이를 알려 줍니다. 저장하면 경고는 사라지지만 지정하지 않은 설정은 꺼진 채로 남으므로 `ocx link policy --catalog-fanout auto --updates auto-when-idle`처럼 명시적으로 켜세요. Home은 이 파일을 스스로 다시 쓰지 않습니다.

소유하지 않은 컴퓨터는 링크하지 마세요. Home은 그 컴퓨터에서 사용자의 SSH 키로 명령을 실행합니다.

## 관련 가이드

- [Remote Hub 배포](/ko/guides/remote-hub/)
- [Remote Workspace](/ko/guides/remote-workspace/)


### 단독 실행 환경의 페어링 승인

OpenCodex가 백그라운드 서비스로 실행 중이어도 기존 `ocx gui pair --origin <로컬 주소>` 명령을 사용할 수 있습니다. 서비스의 개인 OpenCodex 폴더를 소유한 계정으로 명령을 실행하고, 반환된 일회용 코드를 로컬 대시보드에 입력하세요. 서버 터미널, 추가 비밀번호, Windows Hello 또는 하드웨어 보안키가 필요하지 않습니다. CLI와 서버는 같은 최신 버전과 설정 폴더를 사용해야 하며, 업데이트 뒤에는 이전 서버를 재시작하세요. Hub 초대도 CLI와 서버의 버전이 다르면 함께 업데이트해야 합니다. 설정 폴더나 일회용 승인 폴더가 심볼릭 링크이면 페어링을 거부하므로, `OPENCODEX_HOME`에는 보호된 실제 폴더 경로를 지정하세요.

CLI는 짧게 유효한 일회용 승인 정보를 만들고, 사용하거나 실패하면 정리를 시도합니다. 실행 정보를 읽는 것만으로는 승인받을 수 없고, 검증에 필요한 원래 비밀값은 파일에 저장하지 않습니다. 이 방식은 개인 폴더의 쓰기 권한을 확인하는 것으로, 생체 인증이나 사람의 직접 승인을 증명하지는 않습니다. 사용자 파일을 자유롭게 수정할 수 있는 프로그램은 여전히 신뢰 범위 안에 있습니다. 기존 Hub 초대의 권한 정책은 바뀌지 않습니다. 페어링 요청이 실패하면 안내된 문제를 해결한 뒤 새 명령을 실행하세요. Windows의 SSH Remote Link는 위에서 설명한 별도의 PowerShell 실행 경로를 사용합니다.

페어링 도중 프로세스가 중단되면 명령을 다시 실행해 새로운 승인을 받으세요. 서비스나 페어링 명령이 실행 중일 때는 페어링 상태 파일을 수동으로 제거하지 마세요.

Windows에서는 승인 폴더나 기록이 서버 실행 계정만 사용할 수 있도록 보호되지 않았거나, 소유자와 권한을 확인할 수 없으면 페어링을 거부합니다. 두 항목 모두 해당 계정이 소유해야 합니다. Administrators 그룹 소유는 이 그룹이 서버 실행 토큰의 기본 소유자이고 관리자 역할도 활성화된 경우에만 허용합니다. 권한 목록은 상위 항목의 권한을 상속하지 않도록 보호되어야 하며, 서버 실행 계정에 대한 일반적인 모든 권한 허용 항목을 포함해야 합니다. 그 밖에는 SYSTEM과 Administrators 그룹의 일반 허용 항목만 허용합니다. SYSTEM과 권한이 상승된 관리자는 이미 모든 파일의 소유권을 가져올 수 있고, 권한이 상승되지 않은 관리자는 이 항목으로 아무 권한도 얻지 못하기 때문입니다. 하위 항목으로의 상속은 폴더에만 허용합니다. 이 기준은 Windows가 보고하는 권한 목록에 적용되며, 같은 계정의 호환되는 중복 항목은 하나로 보고 아무 권한도 주지 않는 항목은 무시합니다. 거부된 기록은 그대로 두며 권한이나 소유자를 자동으로 수정하지 않습니다. 설정 폴더를 개인 전용으로 보호한 뒤 새 페어링 명령을 실행하세요.

이 검사는 승인 폴더와 기록에만 적용됩니다. 상위 폴더의 교체, 부모 폴더의 삭제 권한, 특권을 사용하는 복원 작업, 권한을 보호하기 전에 열린 핸들을 통한 접근까지 막지는 않습니다. 승인 정보가 일치하는 요청은 이후 폴더 권한 검사에서 거부되더라도 최대 5초로 제한된 검증 프로세스가 실행되는 동안 서버 처리를 막을 수 있습니다. 실행 파일 조회와 프로세스 시작 준비는 이 제한 시간이 시작되기 전에 이루어집니다. CLI 정리 과정에서 검증을 한 번 더 수행할 수도 있습니다. 검증 프로세스의 5초 제한은 명령의 10초 요청 제한 시간 안에 여유를 두지만, 검증이 느리면 페어링이 거부될 수 있습니다.


터미널에서도 `ocx link probe <alias> --json`으로 지문과 버전을 확인하고 `ocx link add <alias> --expect-fingerprint SHA256:… --json`으로 연결할 수 있습니다. 지문 옵션이 없으면 대화형 터미널에서 명시적으로 확인해야 합니다. Home은 Child의 재시작 지원과 curl을 먼저 확인한 뒤 연결하고 재시작하여 실제 릴레이를 검증합니다. 실패 후 Child 설정이 남았다는 안내가 나오면 Child에서 `ocx disconnect`와 `ocx restart`를 실행하세요. 자세한 조건은 [영문 안내](/guides/remote-link/#add-a-child-from-the-terminal)를 참조하세요.
