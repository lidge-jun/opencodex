---
title: macOS 메뉴 막대 앱
description: OpenCodex 데스크톱 앱의 macOS 트레이, 네이티브 사용량 패널, 위젯을 사용합니다.
---

macOS 메뉴 막대 항목은 OpenCodex 데스크톱 앱에 포함됩니다. 로컬 프록시의 사용량을 표시하고 네이티브 사용량 패널을 엽니다. 같은 앱에 대시보드와 WidgetKit 확장도 들어 있습니다. 다른 플랫폼의 설치 방법은 [데스크톱 앱 가이드](/ko/guides/desktop-app/)를 참고하세요.

## 설치

[최신 릴리스](https://github.com/lidge-jun/opencodex/releases)에서 `OpenCodex-<version>-macos.dmg`를 다운로드하세요. DMG를 열고 `OpenCodex.app`을 Applications로 드래그합니다. 데스크톱 앱은 macOS 13 이상, 위젯은 macOS 14 이상이 필요합니다.

## 첫 실행

릴리스 버전의 `OpenCodex.app`은 Developer ID로 서명되고 강화된 런타임을 사용하며, Apple 공증 티켓이 앱에 스테이플되어 있습니다. 첫 실행 시 macOS는 대개 인터넷에서 다운로드한 앱에 대한 일반 확인만 요청합니다. 그래도 차단된다면 **System Settings → Privacy & Security**를 열고 OpenCodex의 **Open Anyway**를 선택하세요. 직접 빌드한 앱은 임시 서명을 사용합니다. [소스에서 빌드](#소스에서-빌드)를 참고하세요.

앱을 열면 창에 시작 진행 상황이 표시됩니다. 첫 실행에서는 **Start at Login**을 한 번 켜며, 트레이 메뉴에서 끌 수 있습니다. 이후 로그인 항목으로 실행될 때는 창을 숨긴 채 시작하지만 트레이는 사용할 수 있습니다.

## 메뉴 막대와 사용량 패널

메뉴 막대에는 기본적으로 오늘의 총 토큰 수가 표시됩니다. 대시보드의 **Menu bar & widget** 설정에서 요청 수, 토큰 수, 추정 비용, 할당량 또는 아이콘만 표시하도록 선택할 수 있습니다.

트레이 메뉴에서 **Show Usage**를 선택하면 네이티브 패널이 열립니다. 패널에는 표시 설정에 따라 오늘 및 30일 합계, 사용량 차트, 모델 목록, 프로바이더·계정 한도가 나옵니다. 합계에는 토큰과 요청 수가 포함되며, 설정하면 추정 비용도 표시됩니다. 할당량 행에는 집계 기간, 비율, 초기화 시각이 나옵니다. 측정값이 없으면 `—`로 표시하고, 일부만 집계된 사용량은 불완전하다고 표시합니다.

패널에는 **Refresh**, **Dashboard**, **Settings** 컨트롤이 있습니다. **Dashboard**는 데스크톱 창의 사용량 화면을, **Settings**는 그 창의 컴패니언 설정을 엽니다. 트레이 메뉴에는 **Open Dashboard**, **Open in Browser**, **Start at Login**, **Stop proxy**, **Check for Updates…**, 업데이트가 있을 때의 **Install update**, **Quit**도 있습니다. **Stop proxy**는 항상 목록에 있지만 앱이 직접 프록시를 시작한 경우에만 사용할 수 있습니다. 따로 시작한 프록시는 계속 실행됩니다. 트레이를 사용할 수 있을 때 창을 닫거나 Command-Q를 누르면 앱이 숨겨집니다. 종료하려면 트레이의 **Quit**을 사용하세요.

트레이의 제목은 60초마다 갱신됩니다. 네이티브 패널을 열어 둔 동안 패널 데이터도 60초마다 갱신되며, **Refresh**를 누르면 즉시 갱신을 요청합니다.

## 위젯

macOS 14 이상에서 OpenCodex.app을 한 번 연 뒤, 데스크톱의 빈 공간을 Control-클릭하고 **Edit Widgets**를 선택하세요. **OpenCodex**를 검색해 원하는 크기를 추가합니다. 크기에 따라 프록시 상태, 오늘의 토큰·요청 수, 추정 비용, 할당량, 사용량 차트의 조합이 달라집니다. 확장은 데스크톱 앱이 기록한 로컬 스냅샷을 읽습니다. 스냅샷에는 화면 표시용 데이터만 있고 API 키나 원본 계정 데이터는 없습니다. 프록시에 연결된 동안 앱은 60초 주기 트레이 갱신을 다섯 번 할 때마다, 약 5분마다 위젯 스냅샷을 갱신합니다. WidgetKit도 5분 뒤 새 타임라인을 요청합니다.

## 프록시에 연결하기

데스크톱 앱은 번들 CLI에 `ocx resolve --json` 실행을 요청합니다. 연결 가능한 기존 로컬 프록시가 있으면 거기에 붙고, CLI가 실행 중인 런타임이 없다고 확인한 경우에만 번들 런타임을 시작합니다. 탐색 결과가 불확실하면 두 번째 프록시를 시작하지 않고 시작 과정에서 문제를 보고합니다. 앱은 확인된 포트의 `127.0.0.1`로 통신합니다.

관리 요청에는 먼저 토큰 없이 접속합니다. 프록시가 HTTP 401을 반환하면 앱 환경의 `OPENCODEX_ADMIN_AUTH_TOKEN` 또는 확인된 설정 홈의 `admin-api-token` 파일을 사용해 재시도합니다. 이 토큰을 macOS Keychain에서 가져오지는 않습니다. 앱이 loopback으로 접근할 수 없는 주소에만 바인딩된 프록시는 데스크톱 셸에서 연결할 수 없습니다.

## 소스에서 빌드

macOS 13 이상에서 Bun, Rust, macOS Swift/Xcode 도구를 준비한 뒤 저장소 루트에서 대시보드를 빌드하고 `desktop/`에서 데스크톱 명령을 실행합니다.

```bash
bun install
bun run build:gui
cd desktop
bun install
bun run prepare-sidecar
bun run prepare-widget
bun run build:local
```

`build:local`은 Tauri 업데이터 서명 키 없이 로컬 앱과 DMG를 만듭니다. `bunx tauri build`를 직접 실행하면 업데이터 산출물도 만들기 때문에 `TAURI_SIGNING_PRIVATE_KEY`가 필요합니다. 위젯 빌드는 `MACOS_SIGN_IDENTITY`가 설정되지 않았다면 임시 서명을 사용하며, 로컬 데스크톱 번들도 임시 서명됩니다. 앱은 실행되지만 macOS는 임시 서명된 위젯 확장을 등록하지 않으므로 로컬 빌드에서는 대개 OpenCodex 위젯이 보이지 않습니다. `build:local`은 언제나 앱에 임시 서명을 하므로 `MACOS_SIGN_IDENTITY`만 설정해도 해결되지 않습니다. 릴리스 빌드처럼 앱과 확장이 같은 Developer ID 팀으로 서명되어야 위젯이 등록됩니다. 위젯이 필요하다면 릴리스 빌드를 사용하세요.

## 제거

트레이 메뉴에서 **Start at Login**을 켰다면 끈 다음, Applications의 `OpenCodex.app`을 휴지통으로 옮깁니다. 번들 CLI와 위젯 확장은 제거되지만 프록시의 `$OPENCODEX_HOME` 상태나 별도로 설치한 `ocx` 서비스는 제거되지 않습니다. 데스크톱 앱은 앱 설정 디렉터리에 설치 ID와 로그인 항목 표시도 기록하고, `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json`에 위젯 스냅샷을 기록합니다. 앱을 휴지통으로 옮겨도 이 파일들은 삭제되지 않습니다.
