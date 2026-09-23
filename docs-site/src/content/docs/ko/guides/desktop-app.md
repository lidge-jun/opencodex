---
title: 데스크톱 앱
description: macOS, Windows, Linux에서 OpenCodex 데스크톱 앱을 설치하고 사용합니다.
---

OpenCodex 데스크톱 앱은 네이티브 트레이와 웹 대시보드를 함께 제공합니다. 번들 CLI가 기존 로컬 프록시를 찾으며, 프록시가 없다는 사실이 확인된 경우에만 앱이 번들 런타임을 시작합니다.

대시보드는 확인된 로컬 프록시 엔드포인트에서 제공됩니다. 기본 포트는 `10100`입니다. 데스크톱 앱은 해당 대시보드와 번들 런타임을 감싸는 로컬 셸입니다.

## 설치

### macOS

[최신 릴리스](https://github.com/lidge-jun/opencodex/releases)에서 `OpenCodex-<version>-macos.dmg`를 다운로드하세요. DMG를 열고 `OpenCodex.app`을 Applications로 드래그합니다. macOS 13 이상이 필요합니다.

릴리스 버전의 `OpenCodex.app`은 Developer ID로 서명되고 Apple 공증을 받으므로, 첫 실행 시에는 대개 다운로드한 앱에 대한 일반 확인만 요청합니다. macOS가 계속 차단하면 **System Settings → Privacy & Security → Open Anyway**를 선택하세요.

### Windows

`OpenCodex-<version>-windows-x64.msi`를 다운로드해 설치 프로그램을 실행하세요. 설치 프로그램은 아직 코드 서명이 없어 Windows SmartScreen이 경고할 수 있습니다. 릴리스 페이지에서 다운로드한 파일인지 확인한 뒤 **More info → Run anyway**를 선택하세요.

### Linux

릴리스 페이지에서 `OpenCodex-<version>-linux-x86_64.AppImage` 또는 `OpenCodex-<version>-linux-amd64.deb`를 다운로드하세요.

AppImage를 사용하는 경우:

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
./OpenCodex-<version>-linux-x86_64.AppImage
```

Debian 기반 배포판의 경우:

```bash
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

트레이 아이콘을 사용하려면 AppIndicator를 지원하는 데스크톱 환경이 필요합니다.

## 첫 실행

앱은 번들 CLI에 `ocx resolve --json` 실행을 요청합니다. 이미 실행 중인 로컬 프록시에 연결할 수 있으면 그 프록시를 사용합니다. CLI가 프록시의 부재를 확인한 경우에만 번들 런타임을 시작하고, 결과가 불확실하면 시작 실패로 표시합니다. 그 뒤 확인된 loopback 엔드포인트의 대시보드를 앱 webview에서 엽니다.

트레이의 **Open dashboard** 또는 **Open in browser**를 사용하면 내장 대시보드와 일반 브라우저를 오갈 수 있습니다. 트레이에서는 업데이트도 확인할 수 있습니다.

## 트레이에서 사용량 보기

macOS와 Windows에서는 트레이 아이콘을 클릭하면 작은 사용량 창이 열립니다. 트레이의 **Show usage**로도 열 수 있으며, 트레이 클릭 이벤트를 전달하지 않는 Linux 데스크톱에서도 사용할 수 있습니다. Linux에서는 트레이 아이콘이 표시되지 않는 환경을 포함해 시작할 때 대시보드가 열립니다.

사용량 창에는 오늘 및 30일 합계, 설정한 사용량 차트, 간결한 모델 목록, 프로바이더·계정 한도가 표시됩니다. 할당량 막대 옆에는 초기화까지 남은 시간이 나오며, 정확한 시각은 마우스를 올려 확인할 수 있습니다. 기존 **Menu bar & widget** 설정으로 표시할 섹션과 차트를 제어합니다. 숨긴 프로바이더는 제목, 합계, 할당량, 차트에서 제외됩니다. 차트에는 현재 시간 구간의 활동도 포함됩니다. 일부 차트 데이터를 신뢰할 수 있게 귀속할 수 없으면 부분 데이터 표시가 나타납니다. 측정값이 없는 경우를 사용량 0으로 표시하지 않습니다. Windows와 Linux에서는 계정 목록이 길 때 사용량 창을 스크롤하면 끝에 있는 Refresh와 Dashboard를 볼 수 있습니다.

macOS에서 이 창은 네이티브 SwiftUI 컨트롤과 스크롤 가능한 AppKit 패널을 사용합니다. macOS 26 이상에서는 Apple Liquid Glass를, 이전 버전에서는 네이티브 팝오버 재질을 사용합니다. 계정 목록을 스크롤해도 헤더와 Refresh, Dashboard 버튼은 계속 보입니다. **View → Show Usage** (Command-Shift-U)로도 열 수 있습니다. Escape를 누르거나 패널 밖을 클릭하면 닫힙니다.

트레이 메뉴에는 오늘의 요청 수와 토큰 수가 표시되고, 설정하면 추정 비용도 나옵니다. 위젯과 동일한 로컬 날짜 기준 사용량을 사용합니다. **Refresh now**를 선택하면 즉시 갱신하며, 앱도 60초마다 갱신합니다. 표시 설정은 대시보드의 **Menu bar & widget** 섹션에서 관리합니다. **Today**를 끄면 요약이 숨겨지고 **Cost**를 끄면 요약에서 비용이 빠집니다.

사용할 수 없거나 명시적으로 측정하지 않은 사용량은 측정값 0이 아닌 `—`로 표시됩니다. 아이콘만 표시하도록 선택하면 이전 숫자가 지워집니다. 축약 표기에서는 정수 자릿수를 유지하므로 토큰 천만 개는 `1M`이 아니라 `10M`입니다.

## 업데이트

트레이 메뉴에서 **Check for Updates…**를 선택하면 즉시 확인합니다. 릴리스 빌드는 시작 후와 이후 6시간마다 자동으로도 확인합니다. 업데이트는 설치 전에 프로젝트의 서명된 업데이터 공개 키로 검증됩니다. macOS의 앱 내 업데이트는 `OpenCodex-<version>-macos.app.tar.gz`를 다운로드하며, DMG는 최초 설치용입니다. 업데이터 키 시크릿이 설정된 경우에만 릴리스 매니페스트를 만들고, 이때는 네 플랫폼 모두 서명되어야 합니다.

## 위젯

macOS 앱에는 OpenCodex WidgetKit 확장이 포함됩니다. 위젯 설정과 로컬 스냅샷에 관한 자세한 내용은 [macOS 메뉴 막대 앱 가이드](/ko/guides/macos-menu-bar/)를 참고하세요.

## 제거

macOS에서는 Applications의 `OpenCodex.app`을 휴지통으로 옮깁니다. Windows에서는 **Installed apps**에서 OpenCodex를 제거합니다. Debian 기반 Linux에서는 다음 명령을 실행합니다.

```bash
sudo apt remove opencodex
```

AppImage는 다운로드한 파일을 삭제하면 됩니다.

저장된 메뉴 막대 설정을 읽을 수 없다면 파일을 보존하기 위해 일부 항목만 수정하는 작업을 거부합니다. 다시 편집하려면 파일을 복원하거나 컴패니언 설정을 명시적으로 초기화하세요.
