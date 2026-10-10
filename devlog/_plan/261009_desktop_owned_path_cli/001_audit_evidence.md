# 001 — Audit evidence (2026-10-09)

Three independent read-only gpt-6.1-sol audits of origin/dev 68c9d35457, run before planning this unit. They are reproduced as returned, with absolute paths made repository-relative. Links point at that checkout; line numbers describe 68c9d35457, not later commits.

## A — Desktop app and installers (agent 01a11f2d-fa50)

감사 결론은 **Desktop 번들 CLI를 실행하는 설치기는 구현 가능하지만, 앱 실행만으로 모든 기존 터미널의 `ocx` 선택을 보장할 수는 없다**입니다. 셸 함수와 PATH 순서가 실행 파일 선택에 앞서고, Windows 프로세스는 부모의 환경을 상속합니다. 따라서 “설치 성공”과 “현재 터미널에서 Desktop CLI가 선택됨”을 별도로 검증해야 합니다. [zsh 실행 규칙](https://zsh.sourceforge.io/Doc/Release/Command-Execution.html), [Windows 환경 변수](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables)

지정 체크아웃에서 읽기와 네트워크 조회만 수행했습니다. 파일 수정·커밋·브랜치 작업·테스트 실행은 하지 않았습니다.

1. **번들 CLI 경로와 기동**

   현재 `sidecar::start()`는 `app.shell().sidecar("ocx")`를 사용하며, GUI 리소스 경로와 감독 환경 변수를 전달합니다. 터미널 PATH의 npm 런처를 선택하는 경로가 아닙니다. [sidecar.rs:190](desktop/src-tauri/src/sidecar.rs:190)

   고정된 shell 플러그인 2.2.1은 Desktop 실행 파일의 부모 디렉터리에 `ocx`를 붙이고, Windows에서는 `.exe` 확장자를 붙입니다. 설치기도 이 규칙과 같은 경로를 사용해야 하며 `resource_dir()/ocx`로 계산하면 안 됩니다. [shell 2.2.1 소스](https://docs.rs/crate/tauri-plugin-shell/2.2.1/source/src/process/mod.rs)

   | 플랫폼 | 실제 대상 |
   |---|---|
   | macOS | 현재 실행 중인 `.app/Contents/MacOS/ocx`. 번들 검증기도 이 위치를 사용합니다. [verify-macos-runtime.sh:33](desktop/scripts/verify-macos-runtime.sh:33) |
   | Windows | Desktop 실행 파일과 같은 설치 디렉터리의 `ocx.exe`. 기본 디렉터리는 `C:\Program Files\OpenCodex`이며 설치 화면에서 변경 가능합니다. [고정 WiX 템플릿](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.1/crates/tauri-bundler/src/bundle/windows/msi/main.wxs#L121) |
   | Linux deb | `/usr/bin/ocx`; 리소스는 `/usr/lib/OpenCodex`. [desktop-shell.md:402](structure/desktop-shell.md:402) |
   | AppImage | 실행 이미지의 내부 `usr/bin/ocx`; 추출 검증도 이 구조를 사용합니다. 영구 PATH 대상으로 임시 마운트 경로를 저장하면 안 됩니다. [verify-linux-sidecar.sh:19](desktop/scripts/verify-linux-sidecar.sh:19), [AppImage 구조](https://docs.appimage.org/reference/architecture.html) |

2. **저장 위치·플래그·로그**

   `app_config_dir()`는 플랫폼 설정 디렉터리에 `com.opencodex.desktop`을 붙입니다. 기본값은 macOS `~/Library/Application Support/com.opencodex.desktop`, Windows `%APPDATA%\com.opencodex.desktop`, Linux `$XDG_CONFIG_HOME/com.opencodex.desktop` 또는 `~/.config/com.opencodex.desktop`입니다. [Tauri 경로 소스](https://docs.rs/crate/tauri/2.11.6/source/src/path/desktop.rs), [tauri.conf.json:5](desktop/src-tauri/tauri.conf.json:5)

   기존 패턴은 `install-id`와 일회성 marker 파일입니다. 사용자 선택을 보존하는 marker는 작업 전에 쓰고, 재시도 가능한 마이그레이션 marker는 성공 후 씁니다. 설치기에는 단순 marker보다 **활성화 여부·소유 ID·shim 경로·번들 대상·버전·파일 지문을 담은 원자적 기록**을 권고합니다. 설정 디렉터리를 공유하는 `.app` 복사본은 같은 `install-id`를 읽을 수 있으므로 ID만으로 파일 소유권을 판정하면 부족합니다. [identity.rs:24](desktop/src-tauri/src/identity.rs:24), [first_run.rs:44](desktop/src-tauri/src/first_run.rs:44), [first_run.rs:99](desktop/src-tauri/src/first_run.rs:99)

   로그는 `logging::log_once()`가 동일 메시지를 중복 제거해 stderr에 씁니다. 설치 결과는 로컬 UI 상태로도 반환하는 것이 적합합니다. [logging.rs:6](desktop/src-tauri/src/logging.rs:6)

3. **설치기·제거 훅**

   설정은 `targets: "all"`이지만 실제 릴리스는 macOS `app,dmg`, Windows `msi`, Linux `appimage,deb`입니다. Windows NSIS는 현재 배포하지 않습니다. [tauri.conf.json:17](desktop/src-tauri/tauri.conf.json:17), [release.yml:242](.github/workflows/release.yml:242)

   현재 사용자 정의 WiX template/fragment, NSIS hook, deb maintainer script 설정은 없습니다. Windows 추가 설정도 MSI 버전만 바꿉니다. 기본 WiX는 **per-machine**이고, 템플릿의 “PATH Environment Variable”이라는 Feature 이름에도 실제 PATH를 쓰는 `<Environment>` 항목은 없습니다. [tauri.conf.json:50](desktop/src-tauri/tauri.conf.json:50), [windows-installer-config.ts:20](desktop/scripts/windows-installer-config.ts:20), [WiX 템플릿](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.1/crates/tauri-bundler/src/bundle/windows/msi/main.wxs#L28)

   **범위 확장 필요:** 외부 사용자 shim을 자동 제거하려면 MSI 구성 변경이 필요합니다. per-machine 제거에서 여러 사용자의 설치 기록을 처리하는 정책도 정해야 합니다. DMG는 앱 드래그 설치이므로 휴지통 이동에 연결된 제거 훅을 기대할 수 없습니다. macOS는 명시적 “Remove ocx command”와 잔여 shim의 오류 동작을 설계해야 합니다. deb/NSIS에는 설정 가능한 제거 훅이 있지만 현재 사용하지 않습니다. [DMG 배포](https://v2.tauri.app/distribute/dmg/), [Tauri 훅 설정](https://v2.tauri.app/reference/config/)

4. **업데이트·앱 이동·서명**

   `updater::install()`은 다운로드·서명 검증 후 런타임을 정지하고 설치합니다. Windows 설치 호출은 프로세스를 종료하므로 그 뒤의 코드에서 shim 복구를 수행하면 안 됩니다. 다음 앱 기동 또는 설치기 단계에서 복구해야 합니다. [updater.rs:388](desktop/src-tauri/src/updater.rs:388), [updater 2.9.0 소스](https://docs.rs/crate/tauri-plugin-updater/2.9.0/source/src/updater.rs)

   macOS 업데이터는 현재 `.app`을 백업하고 같은 경로에 새 번들을 넣습니다. 따라서 같은 경로의 symlink는 교체 완료 후 다시 유효하지만 교체 중에는 대상이 없을 수 있습니다. `/Applications`와 `~/Applications` 사이의 수동 이동은 절대경로 링크를 깨뜨립니다. **권고:** 매 기동에 현재 번들 경로로 소유 기록을 갱신하고, 이전 경로만 아는 shim은 오류로 종료합니다. [updater 2.9.0 교체 구현](https://docs.rs/crate/tauri-plugin-updater/2.9.0/source/src/updater.rs)

   **서명 관점의 판단:** 번들 밖에서 번들 안의 서명된 바이너리를 가리키는 링크나 스크립트는 번들 내용을 변경하지 않습니다. Apple의 “번들 밖을 가리키는 symlink 제한”은 번들 내부 링크에 관한 규칙입니다. 다만 링크·shim이 Gatekeeper나 quarantine 검사를 우회한다고 주장할 근거는 없습니다. [Apple Code Signing Tasks](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)

   다운로드 위치에서 직접 실행하면 Gatekeeper가 경로를 translocation할 수 있습니다. **권고:** DMG·translocation·임시 경로에서는 영구 명령 설치를 거부하고 안정된 설치 위치에서 재실행하게 합니다. [Apple 배포 문서](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)

5. **UI·command 등록·검증**

   loopback 대시보드에 쓰기 command를 직접 개방하기보다 로컬 `desktop/ui/cli.html`을 신설하는 것이 적합합니다. 기존 업데이트 화면은 GUI에서 로컬 페이지로 이동하고, Rust command가 창 label과 정확한 URL을 다시 검사합니다. 같은 방식으로 `cli_status`, `cli_install`, `cli_remove`를 등록하고 `require_cli_page()`를 추가할 수 있습니다. [desktop-shell.ts:36](gui/src/lib/desktop-shell.ts:36), [window.rs:113](desktop/src-tauri/src/window.rs:113), [lib.rs:287](desktop/src-tauri/src/lib.rs:287)

   Rust 테스트는 각 모듈의 `#[cfg(test)] mod tests` 관례입니다. CI job **`desktop-shell` / `desktop shell`**은 Ubuntu에서 다음 검사를 실행합니다. 별도 `widget` job은 macOS 번들을 검증하므로 Ubuntu Rust 통과를 Windows 네이티브 설치 증거로 해석하면 안 됩니다. [windows_autostart_command.rs:9](desktop/src-tauri/src/windows_autostart_command.rs:9), [ci.yml:1535](.github/workflows/ci.yml:1535), [ci.yml:1459](.github/workflows/ci.yml:1459)

   ```text
   cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
   cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
   cargo test --manifest-path desktop/src-tauri/Cargo.toml
   ```

6. **정확한 구현 위치와 shim 권고**

   새 `desktop/src-tauri/src/cli_install.rs`에 경로 해석·소유 판정·설치·제거·복구를 모으는 것을 권고합니다. command wrapper와 등록은 `lib.rs`의 기존 업데이트 command/`generate_handler!` 옆에 둡니다. 기동 복구는 **`startup::register()`의 `first_run::adopt_launch_origin_argument(app)` 직후, 현재 1473행 다음**에 넣으면 프로세스당 한 번 수행되고 프록시 기동 성공 여부와 분리됩니다. [lib.rs:236](desktop/src-tauri/src/lib.rs:236), [startup.rs:1449](desktop/src-tauri/src/startup.rs:1449)

   | 플랫폼 | 권고 형태와 이유 |
   |---|---|
   | macOS | `~/.local/bin/ocx`의 **소형 `/bin/sh` shim**. 검증된 절대경로에 `exec … "$@"`; 대상 부재 시 오류로 종료. symlink보다 이동·교체 중 실패를 명시하기 쉽습니다. 바이너리 단독 복사는 keyring 리소스와 버전을 분리하므로 피합니다. [zsh 실행 규칙](https://zsh.sourceforge.io/Doc/Release/Command-Execution.html), [desktop-shell.md:385](structure/desktop-shell.md:385) |
   | Windows | 사용자 전용 bin의 **작은 네이티브 `ocx.exe` launcher**. 기록된 번들 `ocx.exe`를 직접 실행하고 인자·표준입출력·종료 코드를 전달. `.cmd`는 셸 및 인용 규칙에 의존하므로 최종 공용 계약으로는 비권고입니다. 새 helper의 패키징은 범위 확장입니다. [Windows 프로세스 생성](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) |
   | Linux deb | `/usr/bin/ocx` 직접 사용 또는 사용자 bin의 **소형 스크립트**. 엄격한 실패 동작이 필요하면 dangling symlink보다 스크립트가 적합합니다. [desktop-shell.md:402](structure/desktop-shell.md:402), [zsh 실행 규칙](https://zsh.sourceforge.io/Doc/Release/Command-Execution.html) |
   | AppImage | **마운트 symlink 금지**. 안정된 Desktop 관리 디렉터리에 sidecar와 필수 리소스를 함께 추출하고 shim으로 호출하는 별도 설계가 필요합니다. 현재 AppImage에 CLI 인자를 넘기기만 해서는 해결되지 않습니다. `main()`은 항상 Desktop을 실행합니다. [main.rs:3](desktop/src-tauri/src/main.rs:3), [desktop-shell.md:402](structure/desktop-shell.md:402) |

   설치기는 기존 외부 파일을 덮어쓰지 않고, 제거·복구도 소유 기록과 파일 지문이 일치할 때만 수행하도록 권고합니다. npm/Bun fallback은 두지 않아야 합니다. 현재 열린 [#6802](https://github.com/lidge-jun/opencodex/pull/6802), [#6809](https://github.com/lidge-jun/opencodex/pull/6809), [#6807](https://github.com/lidge-jun/opencodex/pull/6807)은 각각 런타임 권위·명령 가드·런처 fallback 작업이며, 터미널 PATH 설치 완료의 근거로 사용할 수 없습니다.

## B — Package launchers and CLI (agent 01a11f2d-fb14)

감사 기준은 지정 체크아웃 `68c9d35457`입니다. 파일 수정·커밋·설치·테스트 실행은 하지 않았습니다.

**결론: 패키지 런처의 Desktop 위임은 유용하지만, 이것만으로 “터미널 ocx가 절대 npm 런처를 실행하지 않는다”는 목표를 충족할 수 없습니다.** 위임하려면 먼저 Node 런처가 실행되고, 구버전 런처나 별도 standalone에는 새 분기가 없습니다. Desktop 소유 PATH 명령 설치가 주된 해결책이고, 런처 위임은 호환 경로로 두는 것을 권고합니다. 근거: [package.json:14](package.json:14), [standalone 빌드:67](scripts/build-standalone.ts:67).

1. **패키지 런처의 현재 흐름**

   `bin/ocx.mjs`는 Node로 실행됩니다. 모듈 위치에서 설치 관리자를 판별하고, `../src/cli/index.ts`를 실행 대상으로 정합니다. 설치 판별은 패키지 경로·realpath·관리자 메타데이터에 기반하며 Desktop 설치나 PATH 우선순위를 판별하지 않습니다. 근거: [런처:74](bin/ocx.mjs:74), [install-detection.mjs:28](src/update/install-detection.mjs:28).

   Bun 탐색 순서는 검증된 `OPENCODEX_BUN_PATH` → 패키지의 `bun/package.json` 아래 `bin/bun.exe` 또는 `bin/bun` → Bun dependency의 `install.js` 실행 후 재검사입니다. 기준 커밋에는 PATH Bun fallback이 없습니다. 선택한 Bun으로 CLI를 비동기 실행합니다. 근거: [런처:875](bin/ocx.mjs:875), [런처:914](bin/ocx.mjs:914), [런처:1075](bin/ocx.mjs:1075).

   npm/pnpm self-update는 **Bun 탐색 전에** 분기합니다. `update --help`는 951줄, mise 거부는 964줄, npm/pnpm 호출은 977–979줄입니다. 실제 갱신 함수는 195줄부터이며 관리자 확인·무결성 검사·소유권 lease·stop 검증·교체·복구를 수행합니다. npm은 transactional 교체, pnpm은 global owner 기반 교체를 사용합니다. 근거: [런처:195](bin/ocx.mjs:195), [런처:561](bin/ocx.mjs:561), [런처:740](bin/ocx.mjs:740), [런처:947](bin/ocx.mjs:947).

   기존 Desktop 관련 판단은 **런타임 보호**입니다. `runtime-ownership.mjs`는 비CLI 소유자나 불명확한 소유권에서 교체·stop·서비스 복구를 막습니다. 기준 체크아웃에는 `desktop-supervision.mjs`가 없으며, #6802가 macOS/Linux의 PID·부모 프로세스·동일 번들 sidecar 관계를 두 번 확인하는 모듈을 추가합니다. Windows는 `unsupported`입니다. 근거: [runtime-ownership.mjs:40](src/update/runtime-ownership.mjs:40), [#6802 모듈:73](https://github.com/lidge-jun/opencodex/blob/1718fcad8ba90e6afd12a8c5a03f7fc222f69742/src/service/desktop-supervision.mjs#L73).

   **Desktop 위임용 재귀 차단 env는 현재 없습니다.** `OCX_NODE_LAUNCH_CONTEXT`는 argv의 무작위 proof와 묶인 환경 출처 증명이며, 재귀 차단 용도가 아닙니다. 근거: [launcher-context.ts:53](src/cli/launcher-context.ts:53).

   #6807은 `resolveBun` 끝에 검증된 PATH Bun fallback을 추가하고, 실패 메시지에 macOS Desktop CLI 위치를 안내합니다. `findDesktopCli`는 명시적으로 **안내용이며 실행하지 않습니다**. 새 위임 구현은 이 안내 함수를 실행 권한 판단으로 재사용하면 안 됩니다. 근거: [#6807 diff](https://github.com/lidge-jun/opencodex/pull/6807/files).

2. **설치 경로별 진입점**

   | 설치 형태 | 실행 경로·판정 |
   |---|---|
   | npm/nvm global | 패키지 `bin/ocx.mjs` → Bun → `src/cli/index.ts`. [package.json:14](package.json:14) |
   | pnpm global | 관리자 shim → 동일 Node 런처. pnpm virtual-store 및 realpath로 소유자를 판별. [install-detection.mjs:239](src/update/install-detection.mjs:239) |
   | bun link | package bin 선언상 동일 런처. 현재 머신의 `~/.bun/bin/ocx`도 소스 `bin/ocx.mjs`로 연결됨. [package.json:16](package.json:16) |
   | standalone | `dist/standalone/<target>/ocx[.exe]`; CLI를 Bun `--compile`로 포함. [빌드:29](scripts/build-standalone.ts:29), [빌드:67](scripts/build-standalone.ts:67) |
   | Desktop | 위 standalone을 Tauri sidecar로 복사·번들링. [prepare-sidecar.ts:38](desktop/scripts/prepare-sidecar.ts:38) |

   현재 머신의 `/opt/homebrew/bin/ocx`는 `.../dist/bin/ocx` → `ocx.mjs` → `../../bin/ocx.mjs`로 연결됩니다. 패키지 루트 자체도 소스 체크아웃의 링크입니다. 따라서 **이 관찰을 Homebrew formula 설치본이라고 단정할 수 없습니다**. 링크 대상: [실제 런처:1](<maintainer checkout>/bin/ocx.mjs:1).

   기준 저장소에서 `dist/bin` 생성 코드는 찾지 못했습니다. 현재 패키징은 기존 `bin/ocx.mjs` 권한을 정규화하고, standalone 빌드는 `dist/standalone`을 생성합니다. 현존 `dist/bin` 링크의 생성 주체는 미확인입니다. 근거: [prepare-package.ts:31](scripts/prepare-package.ts:31), [standalone 빌드:29](scripts/build-standalone.ts:29).

3. **위임 위치와 탐색 조건 — 설계 제안**

   삽입점은 **현재 963줄 다음**, 즉 update-help·내부 inspection 판별 뒤이면서 mise/npm update·bootRestoreProbe·resolveBun 이전을 권고합니다. 먼저 명령 정책을 결정하고, 위임 대상이 확정되면 npm 복구와 Bun 설치에 진입하지 않아야 합니다. 근거: [런처:958](bin/ocx.mjs:958).

   - **macOS:** 검증된 현재 Desktop supervision의 `proxy`를 우선하고, 없으면 `/Applications/OpenCodex.app/Contents/MacOS/ocx`, `~/Applications/...`를 후보로 사용합니다. 복수 설치는 Desktop 명령 설치 기록으로 선택하며, 파일 존재만으로 실행하지 않는 정책이 필요합니다. 후보 근거: [#6807 탐색:77](https://github.com/lidge-jun/opencodex/blob/b880f9c6b9efaf161336f0b30ec8d5fcc3cea2b4/src/lib/bun-path-runtime.mjs#L77).
   - **Windows:** MSI는 레지스트리 `InstallLocation`을 우선해야 합니다. 기존 설치 검증도 HKLM Uninstall 레코드에서 찾습니다. HKCU·레지스트리 view 지원을 보완하고 `%LOCALAPPDATA%`는 검증 대상 후보로만 취급할 것을 권고합니다. 현재 WiX 설정만으로 고정 사용자 설치 위치를 확정할 수 없습니다. 근거: [설치 검증:217](desktop/scripts/installed-gate-platforms.ts:217), [WiX 설정:54](desktop/src-tauri/tauri.conf.json:54).
   - **Linux:** 검증된 Desktop 부모 옆 `ocx` 또는 Desktop 설치 기록을 사용합니다. AppImage 임시 마운트를 영구 PATH 링크로 저장하지 않는 정책을 유지해야 합니다. 패키지 sidecar는 `usr/bin/ocx`, 리소스는 별도 `lib/OpenCodex` 배치입니다. 근거: [Linux 검증:20](desktop/scripts/verify-linux-sidecar.sh:20), [GUI 탐색:37](src/server/gui-static.ts:37).

   번들 `ocx`의 기본 진입점은 컴파일된 CLI이므로 Node 런처로 되돌아가지 않습니다. 추가 방어로 realpath 자기비교와 새 내부 위임 marker를 권고합니다. Desktop 대상이 확정됐지만 실행 불가능하면 npm fallback 대신 오류를 반환해야 목표를 유지할 수 있습니다. 근거: [빌드:71](scripts/build-standalone.ts:71), [standalone 판별:4](src/lib/standalone.ts:4).

4. **명령 예외와 프로세스 전달 — 설계 제안**

   **npm/pnpm self-update는 자동 위임하지 말고 #6809의 보호 판단을 유지**하십시오. Desktop updater와 패키지 updater는 대상이 다릅니다. `uninstall/remove`도 자동 위임하지 않는 것을 권고합니다. 현재 명령은 서비스·공유 상태를 제거한 뒤 npm 제거를 안내하므로 Desktop 제거 의미로 바꾸면 안 됩니다. 근거: [#6809 diff](https://github.com/lidge-jun/opencodex/pull/6809/files), [uninstall:1593](src/cli/index.ts:1593), [uninstall:1690](src/cli/index.ts:1690).

   사용자 `--version/-v/version`은 유효 Desktop CLI 버전을 보여주도록 위임할 수 있습니다. **내부 소유권 검사 `--version`은 원본 파일 버전을 검사해야 합니다.** 그렇지 않으면 오래된 npm 경로가 Desktop 버전으로 관측됩니다. 기존 검사에는 자기 실행 방지와 버전 probe가 있으므로 내부 bypass를 여기에 연결하십시오. 근거: [managing-cli.ts:62](src/service/managing-cli.ts:62), [managing-cli.ts:160](src/service/managing-cli.ts:160).

   전달은 `spawn(absoluteBinary, argv, {stdio:"inherit", shell:false, windowsHide:true})`, cwd 유지, exit code 전달, signal 전달·재발생 방식이 적절합니다. `spawnSync`는 JS signal handler 실행을 막았던 기존 회귀 때문에 장시간 CLI에 부적합합니다. Windows는 `.exe`를 직접 실행하고 기본 인자 quoting을 유지해야 하며, POSIX식 graceful signal 전달은 보장되지 않습니다. 근거: [런처:999](bin/ocx.mjs:999), [런처:1089](bin/ocx.mjs:1089), [Node 공식 문서](https://nodejs.org/api/child_process.html).

   환경 출처 proof는 위임에도 새로 생성해 보존해야 합니다. 없으면 Claude 호출에서 shell-exported Anthropic 설정까지 제거될 수 있습니다. 터미널 자식에 `OCX_DESKTOP_SUPERVISED=1`을 새로 붙이면 안 됩니다. 해당 marker는 실제 앱의 재시작 감독 계약입니다. 근거: [claude.ts:65](src/cli/claude.ts:65), [sidecar.rs:30](desktop/src-tauri/src/sidecar.rs:30).

5. **status/doctor/resolve와 PATH 진단 자리**

   `status.paths.runtime`은 `durableBunRuntime().path`입니다. standalone에서는 `process.execPath`, 패키지에서는 선택된 Bun 경로이며 PATH의 `ocx` 목록이 아닙니다. doctor의 “Selected runtime”은 **Codex 실행 파일**이고, resolve는 버전·포트·소유권을 보고하며 직접적인 ocx 실행 경로 필드는 없습니다. 근거: [status.ts:893](src/cli/status.ts:893), [bun-runtime.ts:168](src/lib/bun-runtime.ts:168), [doctor.ts:1388](src/cli/doctor.ts:1388), [resolve.ts:182](src/cli/resolve.ts:182).

   새 `cli-path-diagnostics.ts`에서 PATH/PATHEXT 후보 전체·realpath·관리자·위임 대상·선택 이유를 수집하고 세 진단에 얇게 연결할 것을 권고합니다. 기존 `findOcxOnPath`는 첫 후보만 반환합니다. 후보 전체를 실행하지 않고 파일 관찰로 시작하는 것이 적절합니다. 근거: [managing-cli.ts:125](src/service/managing-cli.ts:125).

6. **테스트·크기 제한**

   기존 launcher source/runtime 테스트와 managing-cli 테스트를 보존하고, 새 `ocx-launcher-desktop-delegation.test.ts`에 argv·stdin·exit·signal·자기위임·삭제된 대상·update 예외·내부 버전 검사·Windows 공백 경로를 넣을 것을 권고합니다. 근거: [source 테스트:6](tests/cli/ocx-launcher-source.test.ts:6), [runtime 테스트:314](tests/cli/ocx-launcher-runtime.test.ts:314), [managing-cli 테스트](tests/service/managing-cli.test.ts).

   새 테스트는 `tests/cli/`에 두고 `layout.json.explicit`과 `test-layout-expected.json` 양쪽에 등록해야 합니다. 감사 대상 런처·진단·기존 launcher 테스트에는 개별 baseline cap이 없습니다. 다만 일반 한계는 2,000줄이며 `src/cli/index.ts`는 현재 1,976줄이라 분리가 필요합니다. 근거: [등록 검사:249](tests/test-layout-tooling.test.ts:249), [baseline:18](tests/fixtures/file-size-baseline.json:18), [크기 검사:4](scripts/file-size-ratchet.ts:4).

**위임 설계 권고:** Desktop 소유 PATH 설치를 우선 구현하고, 패키지 런처에는 검증된 Desktop 대상으로만 위임하는 호환 경로를 추가하십시오. 내부 maintenance·버전 probe와 사용자 호출을 구분하고, Desktop 실행 실패 시 npm으로 조용히 전환하지 않는 계약이 필요합니다. 근거: 위 런처 분기·소유권·컴파일 진입점.

**L1 PR과 충돌을 피하는 파일 분할안:** 새 `src/lib/desktop-cli-discovery.mjs`·`.d.mts`, `src/cli/desktop-cli-delegation.mjs`·`.d.mts`, `src/cli/cli-path-diagnostics.ts` 및 새 테스트로 로직을 분리하십시오. `bin/ocx.mjs`에는 import와 963줄 뒤 연결만 추가합니다. #6807의 Bun resolver, #6809의 update 함수, #6802의 supervision·진단 로직을 직접 확장하지 말고 소비하는 방향이 충돌을 줄입니다. 근거: [#6802](https://github.com/lidge-jun/opencodex/pull/6802/files), [#6807](https://github.com/lidge-jun/opencodex/pull/6807/files), [#6809](https://github.com/lidge-jun/opencodex/pull/6809/files).

## C — PATH precedence per OS (agent 01a11f2d-fbe4)

**PATH 설치만으로 “Desktop이 설치·실행 중이면 모든 터미널에서 반드시 Desktop ocx가 실행된다”는 절대 보장은 불가능합니다.** 이미 실행 중인 셸의 환경, 이후 PATH 변경, alias/function, cmd의 현재 디렉터리 검색이 이를 우회합니다. 보장 계약은 **“설정이 적용된 지원 셸에서 Desktop CLI를 먼저 선택하고, 충돌을 검증한다”**로 좁혀야 합니다. [PowerShell 검색 순서](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence), [cmd 검색 순서](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/path), [환경 상속](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables)

지정 체크아웃 `68c9d35457`에서 읽기 전용으로 조사했습니다. 현재 Desktop은 `externalBin`에 `ocx`를 포함하고 `.sidecar("ocx")`로 직접 실행하지만, 확인한 번들 설정에는 PATH 등록이 없습니다. [tauri.conf.json:21](desktop/src-tauri/tauri.conf.json:21), [sidecar.rs:201](desktop/src-tauri/src/sidecar.rs:201)

**macOS: 셸 초기화의 마지막 실행 지점에서 prepend해야 합니다.**

| 방법 | 우선순위와 권고 |
|---|---|
| zsh | 사용자 파일 순서는 `.zshenv → .zprofile → .zshrc → .zlogin`. `.zprofile`만 수정하면 뒤의 `.zshrc`에 밀립니다. **대화형 셸용 `.zshrc` 마지막 실행 지점**, 로그인 셸의 후속 PATH 변경까지 지원하려면 **`.zlogin` 마지막 실행 지점에도 동일 helper**를 둡니다. `$ZDOTDIR`가 있으면 HOME 대신 실제 해당 디렉터리를 사용합니다. `zsh -f`는 보장 범위 밖입니다. [zsh 초기화 순서](https://zsh.sourceforge.io/Guide/zshguide02.html) |
| bash | 비로그인은 `.bashrc`, 로그인은 `.bash_profile`, `.bash_login`, `.profile` 중 **처음 발견되는 파일 하나**를 읽습니다. `.bashrc` 마지막과 실제 로그인 파일 마지막에 helper를 두되, 로그인 파일의 `.bashrc` source 및 다른 PATH 설정보다 뒤여야 합니다. 새 `.bash_profile`을 무심코 만들면 기존 `.profile`이 가려집니다. [Bash 초기화 규칙](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files) |
| fish | `conf.d/*.fish`는 `config.fish`보다 먼저 실행됩니다. 따라서 `99-opencodex.fish`도 마지막을 보장하지 않습니다. conf.d에 helper를 두고 **`$XDG_CONFIG_HOME/fish/config.fish` 마지막에서 호출**, `fish_add_path --path --prepend --move <Desktop-bin>`을 사용하도록 권고합니다. [설정 순서](https://fishshell.com/docs/current/language.html#configuration-files), [fish_add_path](https://fishshell.com/docs/current/cmds/fish_add_path.html) |

`/etc/paths.d`는 시스템 설정이며 이 머신에서는 root 소유입니다. `path_helper`가 기본 `/etc/paths`에 이어 읽으므로 후속 셸 prepend를 이기지 못합니다. 관리자 설치 옵션으로도 절대 우선순위 해결책은 아닙니다. [Apple path_helper 문서](https://raw.githubusercontent.com/apple-oss-distributions/shell_cmds/main/path_helper/path_helper.8)

`launchctl setenv`는 **GUI 앱만**에 한정되지 않고 호출자의 launchd 컨텍스트에서 앞으로 시작되는 프로세스에 적용됩니다. 기존 터미널에는 적용되지 않으며 새 셸도 rc에서 PATH를 다시 바꿀 수 있습니다. 셸 설정의 대체 수단으로 권고하지 않습니다. [launchctl.1:581](/usr/share/man/man1/launchctl.1:581)

경쟁 도구의 실제 관행은 다음과 같습니다.

- **nvm**은 `.zshrc`, `.bashrc`, `.bash_profile`, `.profile` 등에 초기화를 추가합니다. **Bun**은 `.zshrc`/`.bashrc`에서 `~/.bun/bin` prepend를 안내합니다. **Homebrew** 설치기는 macOS zsh에 `$ZDOTDIR/.zprofile`, bash에 `.bash_profile`의 `brew shellenv`를 안내합니다. **pnpm setup**도 셸 설정을 수정하며 현재 소스는 PATH 시작 위치를 요청합니다. npm 자체에는 고정 rc가 없고 Unix 실행 파일은 `{prefix}/bin`에 놓입니다. [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), [Bun](https://bun.sh/docs/installation), [Homebrew 설치기](https://github.com/Homebrew/install/blob/HEAD/install.sh#L1140-L1181), [pnpm setup](https://github.com/pnpm/pnpm/blob/main/pnpm11/engine/pm/commands/src/setup/setup.ts#L280-L294), [npm 위치](https://docs.npmjs.com/cli/v11/configuring-npm/folders/)
- **rustup**은 `~/.cargo/bin`을 사용하며 zsh `.zshenv`, bash 프로필들, fish `conf.d/rustup.fish`를 처리합니다. **Volta**는 기존 셸 초기화 파일들을 수정하여 `~/.volta/bin`을 앞에 둡니다. [rustup 문서](https://rust-lang.github.io/rustup/installation/index.html), [rustup 구현](https://github.com/rust-lang/rustup/blob/main/src/cli/self_update/shell.rs), [Volta](https://docs.volta.sh/reference/setup)
- **Docker Desktop**은 현재 공식 문서상 기본 `~/.docker/bin` 링크와 PATH 설정, 선택적으로 관리자 승인 후 `/usr/local/bin` 링크를 사용합니다. **VS Code**는 명시적인 Install ‘code’ 액션을 제공하고 터미널 재시작을 안내합니다. **OrbStack**은 선택적 관리자 승인으로 `/usr/local/bin`에 CLI를 설치합니다. 모두 “항상 최우선”을 보장하는 선례는 아닙니다. [Docker](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/), [VS Code](https://code.visualstudio.com/docs/setup/mac), [OrbStack](https://docs.orbstack.dev/faq#why-are-you-asking-for-admin)
- **Cursor 편집기**의 Install ‘cursor’ 액션은 개발자 답변으로 확인되지만 현재 정확한 설치 경로는 공식 문서로 검증하지 못했습니다. 별도 **Cursor Agent** 문서의 `~/.local/bin`·rc 추가 안내를 편집기 설치 방식과 동일시하면 안 됩니다. [개발자 답변](https://forum.cursor.com/t/trouble-install-cursor-command-in-path/156), [Agent 설치 문서](https://docs.cursor.com/en/cli/installation)

**추론:** 최초 파일 끝 append는 그 시점의 초기화만 이깁니다. 뒤의 `return`/`exit`로 블록이 실행되지 않거나, 다른 설치기가 나중에 블록 아래에 prepend를 추가하거나, 실행 중 도구가 PATH를 바꾸면 보장이 깨집니다. 따라서 단순 문자열 EOF보다 **실제로 실행되는 마지막 지점과 재검증**이 중요합니다. [Bash 초기화](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files), [zsh 초기화](https://zsh.sourceforge.io/Guide/zshguide02.html), [Volta prepend 관행](https://docs.volta.sh/guide/getting-started)

**열린 터미널에는 PATH 적용과 캐시 갱신을 구분해 안내해야 합니다.**

새 셸을 열거나 해당 셸에서 Desktop helper를 source하여 PATH를 먼저 변경하고, zsh는 `rehash`, bash는 `hash -r`로 캐시를 비우도록 권고합니다. **rehash만 실행해도 PATH가 바뀌는 것은 아닙니다.** 이후 `type -a ocx`와 선택된 실행 파일의 실제 대상을 확인합니다. [zsh rehash/hash](https://zsh.sourceforge.io/Doc/Release/Shell-Builtin-Commands.html), [새 터미널 안내 사례](https://code.visualstudio.com/docs/setup/mac)

**Windows: HKCU Path 앞에 넣으면 user 런처는 이기지만 시스템 런처는 못 이깁니다.**

Windows는 **시스템 Path 뒤에 user Path를 붙입니다.** 따라서 `HKCU\Environment\Path` 선두에 Desktop 전용 bin을 넣어도 시스템 Path의 `ocx`가 먼저입니다. 이 결합은 Microsoft 설명과 Windows Terminal 구현 모두에서 확인됩니다. [Microsoft 설명](https://devblogs.microsoft.com/oldnewthing/20231212-00/?p=109137), [Terminal 구현](https://github.com/microsoft/terminal/blob/main/src/inc/til/env.h)

충돌 후보는 npm 기본 `%APPDATA%\npm`, Bun `%USERPROFILE%\.bun\bin`, pnpm `%LOCALAPPDATA%\pnpm`입니다. **pnpm v10은 HOME 자체, 현재 v11 구현은 HOME의 `bin`**을 사용하므로 둘 다 조사해야 합니다. Scoop은 기본 `%USERPROFILE%\scoop\shims`, WinGet portable 링크는 user `%LOCALAPPDATA%\Microsoft\WinGet\Links`와 machine `%ProgramFiles%\WinGet\Links`입니다. `%LOCALAPPDATA%\Microsoft\WindowsApps`의 앱 실행 별칭도 별도로 조사해야 합니다. [npm](https://docs.npmjs.com/cli/v11/configuring-npm/folders/), [Bun](https://bun.sh/docs/installation), [pnpm 설치기](https://github.com/pnpm/get.pnpm.io/blob/main/install.ps1), [Scoop 구현](https://github.com/ScoopInstaller/Scoop/blob/master/lib/core.ps1), [WinGet 경로 구현](https://github.com/microsoft/winget-cli/blob/master/src/AppInstallerCommonCore/Runtime.cpp#L223-L233), [앱 실행 별칭](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-activation)

레지스트리는 **원래 형식과 미확장 문자열을 보존**하여 수정해야 합니다. `REG_EXPAND_SZ`의 `%변수%`를 풀어 저장하거나 현재 프로세스의 결합된 PATH를 HKCU에 복사하면 안 됩니다. `setx`는 변수 참조를 확장하고 1,024자에서 잘라낼 수 있어 피해야 합니다. Win32 변수 한계 32,767자와 cmd의 8,191자 한계도 구분하고, 초과 시 잘라 쓰지 말고 실패시켜야 합니다. [레지스트리 형식](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-value-types), [setx](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/setx), [Win32 한계](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables), [cmd 한계](https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation)

저장 후 `SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, …, "Environment")`를 보내되 기존 PowerShell/cmd 환경이 갱신됐다고 표시하면 안 됩니다. Windows Terminal 새 탭도 상속 모드에서는 오래된 환경을 사용할 수 있습니다. 재시작 또는 새 환경으로 시작한 셸에서 `Get-Command ocx -All`/`where.exe ocx`로 검증해야 합니다. [브로드캐스트](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-settingchange), [Terminal 상속 옵션](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)

**Linux: `/usr/bin/ocx` 설치와 PATH 우선순위는 별개입니다.**

Tauri deb 번들러는 외부 바이너리를 `usr/bin`으로 복사하지만, nvm·사용자 npm prefix·`~/.local/bin` 등이 앞에 있으면 그 런처가 선택됩니다. 권고는 Desktop 소유 launcher 디렉터리를 macOS와 같은 셸별 마지막 지점에서 prepend하는 것입니다. `~/.npm-global/bin`은 사용자 지정 prefix 예이며 실제 prefix를 확인해야 합니다. [Tauri deb 구현](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/debian.rs#L118-L131), [npm prefix](https://docs.npmjs.com/cli/v11/configuring-npm/folders/), [사용자 prefix 설정](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/)

AppImage의 `$APPDIR`는 마운트 지점이므로 거기로 영구 링크를 만들면 안 됩니다. **설계 권고:** 영속 AppImage 경로와 명시적 CLI 진입점을 사용하거나, Desktop이 관리하는 영속 추출본에서 sidecar와 필요한 리소스를 함께 업데이트해야 합니다. 현재 GUI AppImage에 임의 CLI 인자를 전달하면 동작한다고 가정할 수 없습니다. [AppImage 변수](https://docs.appimage.org/packaging-guide/environment-variables.html), [마운트·추출](https://docs.appimage.org/user-guide/run-appimages.html)

**사용자 환경 변경 규칙은 다음을 권고합니다.** 초기화 파일 편집 선례와 파일 API의 동작을 바탕으로 한 설계 판단입니다. [Volta 편집 범위](https://docs.volta.sh/reference/setup), [Apple open](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html), [Apple rename](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html)

- `# >>> OpenCodex Desktop ocx PATH v1 >>>` / 대응 종료 마커로 정확히 한 블록을 관리합니다. 중첩·불완전·사용자 수정 블록은 자동 덮어쓰지 않습니다.
- 변경 전 백업, 같은 디렉터리 임시 파일, 권한·줄바꿈 보존, flush 후 atomic rename을 사용합니다. 교체 직전 원본 변경 여부를 확인합니다.
- rc 심볼릭 링크는 기본 거부하고 안내합니다. 명시적 선택으로 지원할 때만 실제 dotfiles 대상의 소유권·쓰기 가능 여부를 확인하여 **대상을 편집하고 링크는 유지**합니다.
- 읽기 전용·타 소유자·특수 파일과 미소유 기존 `ocx`를 거부합니다. 제거는 정확한 관리 블록과 소유가 확인된 launcher/PATH 항목만 삭제합니다. Windows는 전체 Path 백업 복원으로 이후 타 도구 변경을 덮지 않습니다.

**최종 권고는 옵트인 `Install ocx command`입니다.** 아래는 구현 제안이며, 자동 적용보다 변경 대상·충돌·보장 범위를 사용자가 확인하게 하는 편이 적절합니다. VS Code와 OrbStack의 명시적 설치 선택도 이를 뒷받침합니다. [VS Code](https://code.visualstudio.com/docs/setup/mac), [OrbStack](https://docs.orbstack.dev/faq#why-are-you-asking-for-admin)

| OS | 무엇을 어디에 쓰는가 |
|---|---|
| macOS | Desktop 전용 bin에 번들 CLI의 **절대 경로**를 실행하는 launcher를 두고, 실제 ZDOTDIR의 `.zshrc`/필요한 `.zlogin`, bash의 rc·활성 로그인 파일, fish `config.fish` 마지막에서 prepend합니다. `~/.local/bin/ocx`만 추가하는 것으로는 부족합니다. |
| Windows | `%LOCALAPPDATA%\OpenCodex\bin\ocx.exe` 같은 전용 native launcher를 HKCU Path 선두에 등록합니다. 시스템 충돌은 별도 조치가 필요합니다. 관리자 선택 시에는 관리자 소유 설치 경로를 machine Path 선두에 두거나, 지원 셸의 **프로세스 PATH**를 초기화 마지막에 prepend합니다. |
| Linux | deb의 `/usr/bin/ocx`를 절대 경로로 실행하는 Desktop 소유 launcher를 사용자 전용 bin에 두고 셸 초기화 마지막에서 prepend합니다. AppImage는 영속 경로·CLI 진입점 또는 관리 추출본이 선행 조건입니다. |

위 배치의 근거는 각 셸의 초기화 순서와 Windows의 machine/user 결합 순서입니다. 설치된 launcher가 번들 CLI를 찾지 못할 때는 **npm을 재검색하지 않고 실패하도록** 권고합니다. 파일 수정·커밋·설정 변경은 하지 않았으며, Windows/Linux 네이티브 실행 검증은 수행하지 않았습니다.

