---
title: Remote Link
description: SSH로 OpenCodex Home 컴퓨터와 Child 컴퓨터를 연결합니다.
---

머신 링크는 SSH를 통해 OpenCodex **Home** 컴퓨터와 **Child** 컴퓨터를 연결합니다. Home이 SSH 터널을 통해 Child를 서비스하고, 두 컴퓨터는 각각 로컬 OpenCodex 서비스를 `10100` 포트에서 계속 실행합니다. 대시보드는 Child 전용 링크 키를 SSH로 전달하므로 토큰을 직접 입력하지 않습니다.

## 요구 사항

- Home 컴퓨터에서 OpenSSH 키 로그인으로 Child 컴퓨터에 접속할 수 있어야 합니다.
- 자식이 시작하는 링크에서는 자식에서 OpenSSH 키 로그인으로 홈에 접속할 수 있어야 합니다(비밀번호 로그인은 지원하지 않음).
- Child 컴퓨터에 OpenCodex 2.66.0 이상이 설치되어 있어야 합니다(자식이 시작하는 링크에서는 Home에도).
- 두 컴퓨터 모두 macOS 또는 Linux여야 합니다.
- 링크는 홈에서 시작합니다. 홈 컴퓨터에서 직접 연 대시보드(독립형 설치의 브라우저 또는 데스크톱 앱)나 페어링된 Hub 세션을 사용해야 합니다.

비밀번호 SSH와 Windows는 현재 흐름에서 지원하지 않습니다. 이번 릴리스에서는 대시보드에서 컴퓨터를 자식으로 연결하는 방식(자식이 시작하는 링크)을 쓸 수 없습니다. 자식으로 참여하면 그 컴퓨터의 OpenCodex가 다시 시작되어 이미 쓰고 있는 Codex 연결이 끊어지기 때문에, 대시보드에서는 **자식** 역할을 선택할 수 없습니다. 지원되는 방법은 홈에서 시작하는 링크입니다. 홈이 될 컴퓨터에서 **Home**을 선택하고, 아래 순서대로 다른 컴퓨터를 자식으로 추가하세요.

## `#remote`에서 Child 추가하기

1. 대시보드에서 `#remote`를 열고 Remote Link를 켭니다.
2. **Home**을 선택한 뒤 **Continue**를 누릅니다. SSH 호스트 목록이 열립니다.
3. SSH 후보에서 호스트를 선택하거나 SSH 설정의 alias를 입력합니다.
4. 연결 테스트를 실행하고 표시된 호스트 지문을 연결하려는 컴퓨터의 지문과 비교합니다. 비교하면 SSH가 호스트를 신뢰하기 전에 잘못된 컴퓨터나 변경된 호스트 키를 발견할 수 있습니다.
5. 지문을 확인한 뒤 Child를 연결합니다.

대시보드는 토큰 입력을 요구하지 않습니다. 먼저 호스트를 검사하며, 지문을 명시적으로 확인하기 전에는 링크를 적용하지 않습니다.

## 링크 상태

- **Connected**는 SSH 터널이 준비되어 Child가 Home 링크를 사용할 수 있다는 뜻입니다.
- **Reconnecting**은 터널을 다시 연결하는 중이라는 뜻입니다. 재시도 중에는 요청이 일시적으로 `Retry-After`와 함께 `503`을 반환할 수 있습니다.
- **Failed**는 조치가 필요하다는 뜻입니다. SSH 인증, 확인한 호스트 키, 포워딩 또는 타임아웃 사유를 확인하세요.

링크가 실패해도 로컬 프로바이더로 조용히 전환하지 않습니다.

## Child 제거하기

Child의 **Disconnect**를 선택하고 alias를 확인합니다. Home은 터널을 중지하고 해당 Child의 링크 키를 폐기한 뒤 저장된 링크 기록을 삭제합니다.

Home에서 Child의 연결 해제 명령을 실행할 수 없으면 **Remove here only**를 선택합니다. 그러면 이 컴퓨터의 터널, 키, 기록만 삭제됩니다. 그 다음 Child에 로그인하여 실행합니다.

```bash
ocx disconnect
```

자식 연결을 끊으려면 자식에서 `ocx disconnect`를 실행합니다. 이 명령은 클라이언트 터널을 끊고 SSH를 통해 홈에서 링크를 폐기합니다. 홈에서 폐기하지 못하면 다음 문구를 출력합니다: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## 보안

Child는 링크를 통해 Home 컴퓨터의 프로바이더와 프로바이더 인증 정보를 사용합니다. Home은 Child마다 별도의 링크 키를 만들며, 링크를 제거하면 그 키를 폐기합니다. 확인 전에 호스트 지문을 비교하여 잘못된 컴퓨터나 변경된 호스트 키를 실수로 허용하지 않도록 하세요. Tailscale identity로 발급된 대시보드 세션은 머신 링크를 관리할 수 없습니다.

## CLI 레퍼런스

```text
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
```

## 관련 가이드

- [Remote Hub 배포](/ko/guides/remote-hub/)
- [Remote Workspace](/ko/guides/remote-workspace/)
