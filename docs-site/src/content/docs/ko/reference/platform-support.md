---
title: 플랫폼 지원
description: macOS, Windows, Linux에서 opencodex가 지원하는 기능과 일부 기능이 플랫폼별로 다른 이유를 설명합니다.
---

opencodex는 macOS, Windows, Linux에서 실행됩니다. 대부분의 기능은 세 플랫폼에서 똑같이 동작합니다. 일부는 운영체제가 제공하는 기능에 의존하며, 이 문서에서 지원 범위와 이유를 설명합니다.

## 모든 플랫폼

| 기능 | 설명 |
| --- | --- |
| 프록시, 라우팅, 프로바이더 어댑터 | 핵심 런타임은 플랫폼에 종속되지 않습니다. |
| 백그라운드 서비스 | 네이티브 백엔드 세 종류: macOS의 launchd, Windows의 Task Scheduler **또는** WinSW, Linux의 systemd 사용자 유닛. |
| 브라우저 로그인 | 플랫폼의 기본 처리기로 엽니다. |
| 클라이언트 탐지 | 플랫폼별로 Cursor, Claude Desktop, Kiro, Codex 설치 위치를 찾습니다. |

### 운영체제 자격 증명 저장소의 프로바이더 키

세 플랫폼 모두에서 **잠금이 해제된 운영체제 자격 증명 서비스를 사용할 수 있을 때** 지원합니다. macOS는 Keychain, Windows는 Credential Manager, Linux는 libsecret을 사용합니다. 키링이 잠겨 있거나 화면이 없는 세션에서는 잠금 해제된 서비스를 사용할 수 없으므로, opencodex는 조용히 다른 저장소로 전환하지 않고 사용 불가 상태를 알립니다. 저장 규칙은 [프로바이더](/ko/reference/configuration/providers/) 문서를 참고하세요.

## macOS 전용

### Claude Code 자동 연결

`ANTHROPIC_BASE_URL`과 Claude Code 설정값을 세션에 주입하는 작업은 launchd 사용자 도메인을 통해 이루어집니다. 다른 플랫폼에는 이에 정확히 대응하는 단일 방식이 없습니다.

Linux에서 가능한 세 방식은 각각 다른 프로세스 집합에 적용됩니다. `systemctl --user set-environment`는 systemd가 시작한 유닛에만, `~/.profile`은 로그인 셸에만, `~/.bashrc`는 로그인하지 않은 대화형 셸에만 적용됩니다. 사용자 세션 전체를 포괄하는 한곳이 없습니다.

Windows의 대응 수단인 `HKCU\Environment`는 부팅할 때마다 초기화되는 값이 아니라 계속 유지되는 값입니다. 여기서 문제가 생깁니다. 재부팅 시 비워지는 영역의 bearer 토큰을 계속 남는 레지스트리 하이브로 옮기면 자격 증명이 디스크에 남는 기간과 읽을 수 있는 주체가 달라집니다. 이를 이식하려면 먼저 보안 검토가 필요합니다.

Claude Code에 필요한 나머지 기능은 모든 플랫폼에서 작동합니다. 같은 변수를 직접 설정하거나 `ocx claude`로 자식 프로세스에 바로 전달할 수 있습니다.

## 가져오기와 붙여넣기

### Meta Muse Code

macOS에서는 `muse login` 뒤 Muse Code CLI가 이미 저장한 API 키를 opencodex가 가져오므로 두 번째 키를 준비할 필요가 없습니다.

다른 플랫폼에서는 키를 붙여넣도록 요청합니다. Meta는 네이티브 Windows CLI를 제공하지 않습니다. Linux에는 CLI가 있지만 자격 증명을 저장하는 위치가 검증되지 않아 opencodex가 저장소를 추측하지 않습니다. 같은 키는 [Meta 개발자 콘솔](https://dev.meta.ai)에서도 볼 수 있습니다. 붙여넣은 키도 가져온 키와 똑같은 형식 검사와 Model API에 대한 실시간 검증을 거칩니다.

## Windows 참고 사항

Windows 서비스는 Task Scheduler 또는 네이티브 WinSW 서비스로 실행할 수 있으며 둘을 동시에 사용할 수는 없습니다. `ocx service repair`가 두 방식의 상태를 모두 발견하면 진행을 거부합니다. 어느 쪽을 원하는지 추측하면 한 컴퓨터에서 두 프록시가 같은 포트를 놓고 충돌할 수 있기 때문입니다.

영어 이외의 언어로 설치된 Windows에서는 콘솔 출력이 UTF-8이 아닌 시스템 코드 페이지로 들어옵니다. opencodex가 그에 맞게 디코딩하므로 ASCII 이외의 문자가 포함된 계정 이름도 올바르게 처리됩니다.

## 기능을 사용할 수 없을 때

opencodex는 제어 기능을 조용히 비활성화하는 대신 실제 이유를 알립니다. 플랫폼에서 기능을 사용할 수 없다면 오류나 대시보드에 누락된 방식과 지원되는 대안이 표시됩니다. 그렇지 않은 경우에는 보고할 만한 버그입니다.
