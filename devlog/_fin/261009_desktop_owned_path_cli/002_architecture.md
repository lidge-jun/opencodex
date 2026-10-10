# 002 — Architect consultation and dispositions

Architect: gpt-6.1-sol, agent handle `01a11f35-9817-7fe2-a22a-27fb83025d32` ("Hegel"), read-only, origin/dev 68c9d35457. The proposal is reproduced in full at the end with decision IDs A0–A11. Main's dispositions are recorded first; 010 and 020 implement the accepted forms.

## Dispositions

| ID | Topic | Disposition | Reason |
|---|---|---|---|
| A0 | Contract: automatic by default, explicit off, verify real selection, no "absolutely never" claim | ACCEPT | Matches the owner instruction while stating what PATH configuration cannot enforce (aliases, open shells, absolute paths, Windows system `Path`). |
| A1 | POSIX `/bin/sh` shim in a Desktop-owned bin directory, fail-closed, no binary copy, refuse temporary/translocated/unpackaged launches | ACCEPT | Copying the binary splits it from its keyring addon and resources; a symlink cannot explain a missing target. |
| A2 | zsh `.zshrc` + `.zlogin`; bash `.bashrc` + the active login file (never create one, report `login-file-absent`); fish block at the end of `config.fish`; keep the block as the last non-blank content; source a shared `path.sh`; refuse symlinked/foreign/read-only rc and broken markers | ACCEPT, with one amendment: `ZDOTDIR` is honored only when Desktop's own environment carries an absolute value; otherwise `$HOME`. | A Finder-launched app cannot observe a `ZDOTDIR` set inside `.zshenv`; claiming otherwise would write to the wrong file. |
| A3 | Windows: prepend the Desktop install directory to `HKCU\Environment\Path`, preserve value type and unexpanded text, broadcast `WM_SETTINGCHANGE`, report system-`Path` conflicts as partial | ACCEPT | No helper binary to package or sign; user `Path` order beats `%APPDATA%\npm`, which is also a user entry. A conflict in the machine `Path` is reported, never shown as success. |
| A4 | One authoritative record `~/.opencodex-desktop/cli.json` (dir 0700, file 0600) with ownerId, generation, enabled, bundle, posix/windows sections and a pending journal; `enabled:false` survives removal; an invalid record never auto-installs | ACCEPT | Two copies of the same truth drift. The record is ownership evidence for generated files only, never runtime or service authority. |
| A5 | Schedule one reconcile right after `first_run::adopt_launch_origin_argument`, on a blocking worker, under a user-level lock, independent of proxy startup | ACCEPT | The startup async executor must not block on file and registry IO; failures log once and never stop the app. |
| A6 | Local `desktop/ui/cli.html` + four commands (`cli_status`, `cli_set_enabled`, `cli_install`, `cli_remove`) behind `require_cli_page()`; tray entry "Terminal command…" | ACCEPT | Mirrors the existing update page boundary (window.rs:113); `cli_remove` stores the disabled intent first so the next launch does not reinstall. |
| A7 | Package-launcher handoff after the internal-inspection branch and before mise/npm update and `resolveBun`; exceptions for update, uninstall/remove and internal probes; regenerate the launch proof; only ENOENT of the recorded target resumes the package path | ACCEPT | Silent fallback after a chosen target fails would defeat the goal; a removed Desktop must not break npm users. |
| A8 | `src/cli/cli-path-diagnostics.ts`, observe-only, `pathFirst` naming, separate `cliCommand` field in status and an "ocx command selection" doctor check | ACCEPT | A child process cannot see the parent shell's aliases, so the result is named for what it observes. |
| A9 | Linux deb gets the same shim + rc; `/usr/bin/ocx` stays; AppImage (mounted or extracted) is excluded and refused | ACCEPT | A user npm prefix ahead of `/usr/bin` wins today; AppImage has no stable path. |
| A10 | Rust tests in-module; TS tests in `tests/cli/` and `tests/clients/`; register in both layout files; update owning structure docs and desktop guide en/ko | ACCEPT | Repository conventions (AGENTS.md, test-layout guards). |
| A11 | Direct shim → compiled CLI has no launch-provenance proof, so `ocx claude` drops shell-exported Anthropic variables | ACCEPT AS SCOPE, amended: the POSIX shim generates the same proof and context the Node launcher creates (it runs before Bun loads any `.env`), so behavior matches the npm path. Mandatory independent security review. Windows has no shim and keeps today's stripping; documented. | Leaving it would make the default PATH `ocx` behave differently from the npm `ocx` it replaces. The proof stays bound to argv, which a project `.env` cannot set. |

Scope additions accepted from the architect: the owned `path.sh` helper, the single-record journal and lock, the internal version-probe bypass (`OCX_NO_DESKTOP_HANDOFF=1` set by `managing-cli` probes), and the tray entry. Rejected as out of scope: a Windows native helper, MSI/deb uninstall hooks, AppImage persistent extraction.

PR shape: manual two-PR stack (PR 1 = wp1 Rust/UI, PR 2 = wp2 launcher/diagnostics), as proposed.

## Reflection

Recorded in [003_reflection.md](003_reflection.md) after the same architect reviews 010/020/030.

## Architect proposal (verbatim, paths made repository-relative)

**자동 적용 기본값에 동의합니다.** 오너 지시를 옵트인 권고로 바꿀 이유는 없습니다. 다만 완료 조건은 “설정 적용”과 “새 터미널에서 Desktop CLI 선택”을 구분해야 합니다. 특히 Windows 시스템 PATH 충돌을 doctor에 표시하기만 하고 전체 목표를 달성했다고 보고하면 안 됩니다.

지정 체크아웃 `68c9d354574ed240c17805493409f8c589682b91`에서 읽기만 수행했습니다. 파일 수정·테스트·설치·브랜치 작업·하위 위임은 하지 않았습니다. 마지막 조회에서는 부모 작업으로 보이는 `devlog/_fin/261009_desktop_owned_path_cli/`가 나타났으며, 건드리지 않았습니다.

**A0 — 제품 계약: 자동 적용, 명시적 비활성화, 실제 선택 검증**

다음 계약을 권고합니다.

> 안정된 설치 위치의 Desktop을 기동하면 지원 셸의 새 세션에서 Desktop 번들 CLI를 우선 선택하도록 자동 구성한다. 비활성화·제거 선택은 다음 기동에도 보존한다. POSIX 관리 shim은 번들 대상이 없어지면 오류로 종료한다. 설치 충돌이나 관찰하지 못한 셸 환경은 성공으로 표시하지 않는다.

앱 종료 시 PATH를 되돌리지 않습니다. PATH는 설치 설정이므로 앱이 닫힌 뒤에도 번들 CLI를 사용할 수 있게 유지합니다. 앱이 뜰 때마다 전역 환경을 뒤집는 정책은 기존 셸을 갱신하지 못하고 제거 의미도 불안정해집니다. 현재 Desktop도 Start at Login의 사용자 변경을 영속적으로 보존하는 선례가 있습니다. [first_run.rs:44](desktop/src-tauri/src/first_run.rs:44)

별도로, PATH 조작은 alias/function·절대경로 실행·셸 시작 후 PATH 변경을 막는 강제 계층이 아닙니다. Windows cmd는 현재 디렉터리도 PATH보다 먼저 검색합니다. 따라서 “어떤 환경에서도 절대 npm을 실행하지 못한다”는 표현에는 반대합니다. 자동 적용 결정에는 반대하지 않습니다. [명령 후보 관찰의 현재 범위: managing-cli.ts:125](src/service/managing-cli.ts:125), [Microsoft cmd 검색 규칙](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/path)

**각 D의 처분**

| Decision | 처분 | 확정·수정 제안과 이유 |
|---|---|---|
| **A1 / D1** | **ACCEPT, 조건 명시** | POSIX 전용 bin의 `/bin/sh` shim을 채택합니다. 대상은 현재 Desktop 실행 파일의 형제 `ocx`를 정규화한 절대경로입니다. 바이너리를 복사하지 않습니다. 번들 CLI의 keyring 리소스는 실제 실행 파일 배치와 결합되어 있습니다. 임시 실행 위치와 개발용 미패키지 실행에서는 자동 설치를 거부합니다. [sidecar.rs:201](desktop/src-tauri/src/sidecar.rs:201), [desktop-shell.md:385](structure/desktop-shell.md:385) |
| **A2 / D2** | **AMEND** | zsh는 `.zshrc`와 `.zlogin`을 함께 처리합니다. fish는 `config.fish` 끝 블록을 선택합니다. bash는 `.bashrc`와 활성 로그인 파일을 처리하되, 로그인 파일이 모두 없으면 `login-file-absent`를 보고합니다. “마지막 PATH 변경을 해석”하는 대신 소유 블록을 마지막 비공백 내용으로 유지합니다. 복잡한 사용자 셸 코드를 문자열 분석으로 이해했다고 주장하지 않습니다. [GUI와 로컬 환경의 분리: startup.rs:808](desktop/src-tauri/src/startup.rs:808), [zsh 시작 파일 순서](https://zsh.sourceforge.io/Doc/Release/Files.html), [fish 구성 순서](https://fishshell.com/docs/current/language.html#configuration-files) |
| **A3 / D3** | **AMEND** | helper 없이 설치 디렉터리를 HKCU Path 앞에 넣는 최소안은 채택할 수 있습니다. 다만 시스템 PATH 충돌·오래된 부모 환경·번들 바이너리 부재에서는 목표가 충족되지 않습니다. 결과는 `partial/blocked`이며 성공으로 처리하지 않습니다. 기존 `winreg` 의존성을 활용하고 레지스트리 형식·원문을 보존합니다. [Cargo.toml:41](desktop/src-tauri/Cargo.toml:41), [Windows 환경 상속](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables) |
| **A4 / D4** | **AMEND** | **`~/.opencodex-desktop/cli.json` 하나를 권위 있는 기록으로 사용**합니다. 앱 설정 디렉터리의 기록과 공개 기록을 이중 관리하지 않습니다. 여기서 “공개”는 같은 사용자의 런처가 발견할 수 있다는 의미입니다. POSIX에서는 디렉터리 `0700`, 기록 `0600`을 권고합니다. 기존 app config의 `install-id`는 참조하되 소유권 증명으로 간주하지 않습니다. [identity.rs:24](desktop/src-tauri/src/identity.rs:24) |
| **A5 / D5** | **AMEND** | 제안된 위치에서 **한 번 작업을 예약**합니다. 파일·레지스트리 작업을 startup async 실행기에 직접 동기 실행하지 않습니다. 별도 blocking worker와 상태 저장소를 사용하고 프록시 시작 성공 여부와 분리합니다. [startup.rs:1473](desktop/src-tauri/src/startup.rs:1473), [startup.rs:800](desktop/src-tauri/src/startup.rs:800) |
| **A6 / D6** | **AMEND** | 로컬 `cli.html`을 채택합니다. 최소 UI는 기본 사용 토글·상태·복구·제거·새 터미널 안내입니다. **페이지 진입 경로도 포함**해야 합니다. tray에 “터미널 명령 설정” 항목을 추가하면 GUI 변경을 최소화할 수 있습니다. 모든 command는 main label과 로컬 페이지 URL을 검사합니다. [window.rs:113](desktop/src-tauri/src/window.rs:113), [tray.rs:219](desktop/src-tauri/src/tray.rs:219) |
| **A7 / D7** | **AMEND** | 의미상 삽입점은 채택합니다. 내부 inspection·update·uninstall/remove·내부 버전 probe는 우회합니다. 환경 출처 proof를 먼저 생성해 전달해야 합니다. **실제 대상 부재만** 기존 런처 진행을 허용하고, 실행 권한 오류·손상·spawn 실패는 오류로 끝냅니다. [bin/ocx.mjs:958](bin/ocx.mjs:958), [bin/ocx.mjs:1018](bin/ocx.mjs:1018) |
| **A8 / D8** | **AMEND** | 새 진단 모듈을 채택하되 결과 이름은 `pathFirst`로 합니다. 외부 프로세스에서 부모 셸의 alias/function까지 관찰할 수 없으므로 `resolvedCommand`라고 부르면 과장입니다. Windows는 shim이 아닌 번들 `.exe`가 기대 대상입니다. [managing-cli.ts:130](src/service/managing-cli.ts:130), [status.ts:893](src/cli/status.ts:893) |
| **A9 / D9** | **ACCEPT** | deb에도 사용자 shim·rc 적용을 합니다. `/usr/bin/ocx`는 유지합니다. AppImage는 **추출 실행까지 포함하여 이번 영구 PATH 자동 적용에서 제외**합니다. `$APPDIR` 유무만 검사하면 추출본을 놓칠 수 있으므로 지원 설치 형태를 확인해야 합니다. [desktop-shell.md:402](structure/desktop-shell.md:402) |
| **A10 / D10** | **AMEND** | Rust 테스트는 모듈 내부, 런처·진단 TS 테스트는 `tests/cli/`, Desktop UI 계약 테스트는 기존 관례대로 `tests/clients/`를 권고합니다. 새 `tests/desktop/` 도메인은 만들지 않습니다. 등록 두 곳과 소유 문서를 함께 갱신합니다. [layout.json:858](scripts/test-layout/layout.json:858), [test-layout-tooling.test.ts:249](tests/test-layout-tooling.test.ts:249) |

A2에는 두 가지 명시적 제한이 필요합니다. Finder 등에서 시작한 Desktop이 `.zshenv` 안에서만 설정되는 ZDOTDIR를 알아낼 수 있다고 가정하면 안 됩니다. 앱이 관찰한 절대 ZDOTDIR 또는 별도 저장된 사용자 지정 위치만 처리합니다. 또한 `.zlogin`의 후속 변경, 조기 `return/exit`, 컴파일된 `.zwc`가 영향을 줄 수 있으므로 rc 파일 저장 성공만으로 새 셸 선택을 확정하지 않습니다. [기존 Desktop의 프로세스 환경과 셸 실행 경로: sidecar.rs:201](desktop/src-tauri/src/sidecar.rs:201), [zsh Files §5.1](https://zsh.sourceforge.io/Doc/Release/Files.html)

**모듈 책임과 인터페이스**

다음은 모두 제안 경로입니다.

| 모듈 | 책임 |
|---|---|
| `desktop/src-tauri/src/cli_command.rs` | 사용 의도, 작업 직렬화, 기동 reconcile, 상태 집계 |
| `desktop/src-tauri/src/cli_command_record.rs` | JSON 경계 검증, 영속 기록, 작업 journal, 소유 증거 |
| `desktop/src-tauri/src/cli_command_posix.rs` | 안정된 번들 판정, shim/helper 생성, rc 설치·복구·제거 |
| `desktop/src-tauri/src/cli_command_windows.rs` | raw HKCU Path 처리·소유 항목 교체·제거·환경 변경 알림 |
| `src/lib/desktop-cli-record.mjs` + `.d.mts` | 같은 고정 기록의 읽기·검증. spawn이나 서비스 소유권 판단은 하지 않음 |
| `src/lib/desktop-cli-handoff.mjs` + `.d.mts` | 명령 예외, 대상 검증, 비동기 spawn·종료·signal 전달 |
| `src/cli/cli-path-diagnostics.ts` | 실행하지 않는 후보 census와 출력용 결과 |
| `desktop/ui/cli.html`, `cli.js` | 설치 상태와 사용자 동작 |

현재는 Desktop가 번들 sidecar를 실행하고, 패키지 런처는 별도로 Bun CLI를 실행합니다. 제안 구조에서는 **Desktop만 기록을 쓰고, 런처와 진단은 기록을 읽습니다.** 명령 선택 기록을 서비스 owner 기록이나 supervision evidence로 승격하지 않습니다. [sidecar.rs:201](desktop/src-tauri/src/sidecar.rs:201), [bin/ocx.mjs:1075](bin/ocx.mjs:1075), [#6802 desktop-supervision.mjs:72](https://github.com/lidge-jun/opencodex/blob/1718fcad8ba90e6afd12a8c5a03f7fc222f69742/src/service/desktop-supervision.mjs#L72)

Rust 인터페이스 제안:

```rust
pub fn reconcile_on_launch(app: &tauri::AppHandle);
pub fn status(app: &tauri::AppHandle) -> CliCommandStatus;

pub async fn install(
    app: tauri::AppHandle,
) -> Result<CliCommandStatus, CliCommandError>;

pub async fn remove(
    app: tauri::AppHandle,
) -> Result<CliCommandStatus, CliCommandError>;
```

Tauri command는 아래 네 개를 권고합니다. 세 개만으로는 토글 저장과 설치 실행의 의미가 섞입니다.

```rust
cli_status(window, app) -> Result<CliCommandStatus, String>
cli_set_enabled(window, app, enabled: bool) -> Result<CliCommandStatus, String>
cli_install(window, app) -> Result<CliCommandStatus, String>
cli_remove(window, app) -> Result<CliCommandStatus, String>
```

`cli_install`은 현재 사용 의도를 유지한 복구이고, `cli_set_enabled(true)`는 사용 의도를 저장한 뒤 설치합니다. `cli_remove`는 **먼저 비활성 의도를 저장한 뒤** 소유 산출물을 제거합니다. 사용자가 제거했는데 다음 기동이 다시 설치하는 동작을 막습니다. 모든 wrapper는 `require_cli_page()`를 호출하며 임의 파일 경로나 실행 명령을 UI에서 받지 않습니다. [기존 command 경계: lib.rs:216](desktop/src-tauri/src/lib.rs:216), [window.rs:113](desktop/src-tauri/src/window.rs:113)

TS/JS 인터페이스 제안:

```ts
readDesktopCliRecord(options): DesktopCliRecordRead
planDesktopCliHandoff(input): DesktopCliHandoffPlan
runDesktopCliHandoff(plan, launchContext): Promise<ChildExit>
collectCliPathDiagnostics(options): CliPathDiagnostics
```

파일 읽기에서 JSON을 한 번 검증하고 typed 결과를 소비합니다. 런처·doctor가 각각 별도 parser를 갖지 않도록 합니다.

**A4의 기록 스키마**

예시 값이며, 경로와 UUID는 실제 설치 때 생성합니다.

```json
{
  "version": 1,
  "ownerId": "UUID",
  "installId": "EXISTING-DESKTOP-INSTALL-ID",
  "generation": 1,
  "enabled": true,
  "bundle": {
    "platform": "darwin",
    "appExecutable": "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop",
    "cliExecutable": "/Applications/OpenCodex.app/Contents/MacOS/ocx",
    "version": "RELEASE-VERSION",
    "kind": "macos-app"
  },
  "posix": {
    "binDirectory": "/Users/user/.opencodex-desktop/bin",
    "files": [
      {
        "kind": "shim",
        "path": "/Users/user/.opencodex-desktop/bin/ocx",
        "sha256": "HEX",
        "created": true
      },
      {
        "kind": "path-helper",
        "path": "/Users/user/.opencodex-desktop/path.sh",
        "sha256": "HEX",
        "created": true
      }
    ],
    "rcFiles": [
      {
        "shell": "zsh",
        "path": "/Users/user/.zshrc",
        "blockSha256": "HEX",
        "created": false,
        "backupPath": "/Users/user/.opencodex-desktop/backups/ID",
        "result": "installed"
      }
    ]
  },
  "windows": null,
  "pending": null
}
```

Windows側は次の形です。

```ts
windows: {
  key: "HKCU\\Environment";
  value: "Path";
  entry: string;                     // 未展開の追加文字列
  valueType: "REG_SZ" | "REG_EXPAND_SZ";
  action: "inserted" | "moved-existing";
  previousBefore: string | null;
  previousAfter: string | null;
} | null
```

- `ownerId`と指紋は、**どの生成物を安全に編集・除去できるか**を判定するためのものです。実行ファイルの真正性やサービス制御権限を証明しません。既存 `install-id`も設定ディレクトリに保存された値です。 [identity.rs:35](desktop/src-tauri/src/identity.rs:35)
- `enabled=false`の小さな記録は除去後も残します。JSONが壊れている場合は「初回」と解釈して自動適用せず、`record-invalid`にします。
- `pending`には、変更前に操作種別・対象・変更前後の指紋・バックアップ参照を保存します。複数ファイルは一括 atomic renameできないため、**途中停止からの回復**を契約に含めます。
- rc全体の指紋は同時編集の検出に、管理ブロックの指紋は所有判定に使います。ユーザーが管理ブロック外を編集しても除去できます。
- Windowsの元Path全体を復元しません。追加した一意の項目だけを除去します。元からあった項目を移動した場合は削除せず、残存する隣接項目で位置を戻せるときだけ戻します。曖昧なら残して報告します。
- 別コピーのDesktopが同じinstall-idを共有し得るため、ID一致だけでshimを上書きしません。記録・生成内容・指紋の一致が必要です。

**A1・A2の生成テキスト**

shimの正確な構造は次を推奨します。絶対パスは生成時に単一引用符を正しくエスケープします。NUL・改行など生成契約に収まらないパスは拒否します。

```sh
#!/bin/sh
# OpenCodex Desktop ocx shim v1
# owner-id: UUID
_ocx_cli='/Applications/OpenCodex.app/Contents/MacOS/ocx'
if [ ! -f "$_ocx_cli" ] || [ ! -x "$_ocx_cli" ]; then
  printf '%s\n' 'OpenCodex Desktop CLI is unavailable. Repair or remove the terminal command in Desktop.' >&2
  exit 127
fi
exec "$_ocx_cli" "$@"
```

shimを実行できた後にnpmを検索する分岐はありません。`exec`自体が失敗してもそのまま終了します。対象バイナリを単独コピーすると、現在のバンドル資源探索契約から外れるため採用しません。 [desktop-shell.md:385](structure/desktop-shell.md:385)

zsh/bashのrcブロックは、共通のDesktop所有helperをsourceする形を推奨します。これならPATH処理の実装を複数rcへ複製せずに済みます。

```sh
# >>> OpenCodex Desktop ocx PATH v1 >>>
if [ -r '/Users/user/.opencodex-desktop/path.sh' ]; then
  . '/Users/user/.opencodex-desktop/path.sh'
fi
# <<< OpenCodex Desktop ocx PATH v1 <<<
```

`path.sh`の構造:

```sh
# OpenCodex Desktop ocx PATH helper v1
_ocx_desktop_path_v1() (
  _ocx_bin='/Users/user/.opencodex-desktop/bin'
  _ocx_new=$_ocx_bin
  _ocx_rest=${PATH-}
  if [ "${PATH+x}" = x ]; then
    while :; do
      case "$_ocx_rest" in
        *:*)
          _ocx_part=${_ocx_rest%%:*}
          _ocx_rest=${_ocx_rest#*:}
          _ocx_last=0
          ;;
        *)
          _ocx_part=$_ocx_rest
          _ocx_last=1
          ;;
      esac
      if [ "$_ocx_part" != "$_ocx_bin" ]; then
        _ocx_new=$_ocx_new:$_ocx_part
      fi
      [ "$_ocx_last" = 1 ] && break
    done
  fi
  printf '%s' "$_ocx_new"
)
PATH=$(_ocx_desktop_path_v1)
export PATH
unset -f _ocx_desktop_path_v1
```

既存PATHの空要素と順序を保ち、Desktop項目だけを取り除いて先頭へ置きます。POSIX PATHに表現できない `:` を含む管理binパスは拒否します。既存シェルに手動sourceする案内では、続けてzshの `rehash`、bashの `hash -r` を実行します。

fishは `config.fish` 末尾へ直接置きます。conf.d単独案は採用しません。

```fish
# >>> OpenCodex Desktop ocx PATH v1 >>>
if status is-interactive
    fish_add_path --path --prepend --move '/Users/user/.opencodex-desktop/bin'
end
# <<< OpenCodex Desktop ocx PATH v1 <<<
```

`--path`を使い、除去しにくいuniversalな `fish_user_paths` を作らない契約です。 [fish_add_path公式文書](https://fishshell.com/docs/current/cmds/fish_add_path.html)

rc編集は次の順序です。

1. symlink・特殊ファイル・他所有者・書込不可・不完全/重複/入れ子/改変マーカーを拒否。
2. 元バイト列、権限、改行形式を記録し、バックアップとjournalを先に保存。
3. 同じディレクトリに一時ファイルを作成し、flush。
4. 置換直前に元ファイルの同一性・内容を再確認してrename。
5. ブロック以外のバイト列を保存。以後は内容が同じなら書かない。

管理ブロックの位置はEOF基準で修復できますが、そのブロックが実際に実行される証明は別です。ユーザーrcを「確認のため」にsourceして実行する設計は避けます。 [既存のファイル変更前の意思保存パターン: first_run.rs:44](desktop/src-tauri/src/first_run.rs:44)

**A5・A7の実行順序**

Desktop側:

```text
first_run::adopt_launch_origin_argument
  → reconcileを一度だけ予約
  → 記録を検証、enabledを確認
  → 安定した現在bundleを確認
  → journal回復・所有確認
  → shim/helper → rc、またはHKCU Pathを更新
  → 記録を確定、UI状態を公開
```

startup・復구・제거는 같은 실행 직렬화 경계를 사용합니다. 여러 앱 프로세스에도 대비해 사용자 기록 디렉터리에 작업 lock을 둡니다. 실패는 `logging::log_once()`로 짧은 사유 코드만 남기고 앱을 계속 띄웁니다. updater 설치 뒤 복구를 기대하지 않고 다음 앱 기동에 복구합니다. [logging.rs:6](desktop/src-tauri/src/logging.rs:6), [updater.rs:397](desktop/src-tauri/src/updater.rs:397)

런처側:

```text
update --help / 内部inspectionの既存判定
  → handoffの命令例外判定
  → 新しいNode launch proof/contextを生成
  → 固定記録を検証
  → Desktop対象を検証
  → spawnして待機・終了状態を伝達
  → 対象なし/無効化なら既存update・復旧・Bun経路へ
```

특히 다음 네 가지를 확정해야 합니다.

- **proof 재생성은 필요합니다.** 기존 코드가 handoff보다 뒤에서 생성하므로 앞당기거나 작은 모듈로 추출합니다. 기존 `OCX_NODE_LAUNCH_CONTEXT`를 그대로 신뢰해 복사하지 않습니다. proof argv는 정확히 하나만 전달합니다. [bin/ocx.mjs:1043](bin/ocx.mjs:1043), [launcher-context.ts:73](src/cli/launcher-context.ts:73)
- `OCX_NO_DESKTOP_HANDOFF=1`은 사용자 우회 및 내부 파일 버전 검사에 사용합니다. 내부 probe를 호출하는 `managing-cli`의 spawn env에 넣어야 합니다. 모든 사용자 `--version`을 제외하면 안 됩니다. [managing-cli.ts:78](src/service/managing-cli.ts:78)
- `OCX_DESKTOP_SUPERVISED=1`을 붙이지 않습니다. 터미널 자식은 Desktop가 재시작을 감독하는 프록시가 아닙니다. [sidecar.rs:205](desktop/src-tauri/src/sidecar.rs:205)
- 유효 대상으로 선택한 뒤의 `EACCES`, 형식 오류, spawn 실패는 npm fallback이 아닙니다. Desktop 제거에 따른 실제 `ENOENT`만 일반 패키지 경로 재개를 허용합니다. 기록이 없거나 `enabled=false`인 경우도 기존 경로입니다. 현재 비동기 종료·signal 전달 패턴을 유지합니다. [bin/ocx.mjs:1089](bin/ocx.mjs:1089), [Node spawn 문서](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)

**A11 — 별도 확인이 필요한 직접 shim 경로**

패키지 handoff에 proof를 넣어도 **직접 shim → 컴파일 CLI**에는 Node proof 생성 단계가 없습니다. 현재 Claude 실행 코드는 trusted context에 없는 Anthropic 환경 변수를 제거합니다. 기본 실행 경로가 npm에서 Desktop로 바뀌면 기존 shell export 취급이 달라질 가능성이 있으므로, 새 shim으로 `ocx claude`를 실행하는 packaged 회귀 검증을 필수로 넣어야 합니다. 단순히 “Desktop marker가 있으니 환경을 신뢰”하는 수정은 권고하지 않습니다. [claude.ts:65](src/cli/claude.ts:65), [컴파일 진입점: build-standalone.ts:67](scripts/build-standalone.ts:67)

이는 이번 읽기 조사에서 확인한 **코드상 위험과 검증 필요성**이며, 실제 packaged 실패를 재현했다고 주장하지 않습니다. 실패한다면 provenance 수정은 보안 검토를 포함한 별도 범위로 부모에게 확장 보고해야 합니다.

**진단 데이터와 남는 위험**

진단 결과는 다음처럼 나누는 편이 명확합니다.

```ts
type CliPathDiagnostics = {
  configured: boolean;
  expectedExecutable: string | null;
  candidates: CliPathCandidate[];
  pathFirst: CliPathCandidate | null;
  desktopFirstOnPath: boolean | null;
  handoffTarget: string | null;
  shellResolution: "unobserved";
  issues: string[];
};
```

후보는 실행하지 않고 regular file·실행 가능 여부·realpath·PATH index·확장자를 관찰합니다. POSIX 빈 PATH 요소와 상대 항목도 cwd 기준 후보로 다룹니다. Windows에서는 PATH/PATHEXT 관찰과 cmd 현재 디렉터리 후보를 구분하고, 셸별 실제 검색 순서를 하나로 단정하지 않습니다. `status.paths.runtime`이나 doctor의 “Codex runtime selection”을 재사용하지 않고 별도 `cliCommand`/“ocx command selection”을 추가합니다. [status.ts:893](src/cli/status.ts:893), [doctor.ts:1388](src/cli/doctor.ts:1388)

| 대안·우회 경로 | 판단과 잔여 위험 |
|---|---|
| symlink | 구현은 작지만 대상 부재 시 명확한 오류 안내가 어렵습니다. shim 채택. |
| 번들 CLI 단독 복사 | 버전·keyring 리소스가 분리됩니다. 거부. [desktop-shell.md:385](structure/desktop-shell.md:385) |
| 패키지 handoff만 구현 | npm의 Node 런처가 먼저 실행되므로 오너의 PATH 목표를 충족하지 못합니다. 보조 경로로만 채택. [package.json:14](package.json:14) |
| rc symlink 대상 자동 편집 | dotfiles 저장소까지 변경할 수 있습니다. 이번 자동 경로에서는 거부하고 사용자 조치로 남김. |
| Windows native helper | 전용 이름과 fail-closed 동작을 제공하지만 바이너리 패키징·서명 범위가 증가합니다. 시스템 PATH 우선 문제 자체는 해결하지 못합니다. |
| alias/function, 절대 npm 경로, `zsh -f`, 이후 `nvm use` | 알려진 우회입니다. 사용자 셸을 지속 감시하거나 가로채지 않습니다. |
| 관리 기록·shim의 같은 사용자 수정 | 해시는 우발적 변경 검출용입니다. 같은 사용자 권한의 악성 프로세스에 대한 보안 경계로 설명하지 않습니다. |
| 앱을 휴지통으로 이동·MSI/deb 직접 제거 | 사용자 rc 자동 cleanup을 보장할 수 없습니다. 먼저 Desktop에서 명령 제거하도록 안내하고 잔여 상태를 명시합니다. 현재 uninstall 문서도 이 흐름으로 수정해야 합니다. [desktop-app.md:198](docs-site/src/content/docs/guides/desktop-app.md:198) |

보장 계층은 **Desktop 설치기·셸 초기화·패키지 런처**입니다. OS 전역의 우회 불가능한 최종 강제 계층은 없습니다. 문서와 UI는 “구성됨”, “현재 PATH에서 우선”, “부모 셸 선택은 미관찰”을 구분해야 합니다.

**PHASE-SPLIT-01 순서와 PR 권고**

| 단계 | 범위 | 독립적으로 확인할 완료 조건 |
|---|---|---|
| **기반** | JSON 계약, 위치, 사용 의도, 오류 enum, 소유 판정, journal/lock, 플랫폼별 안정된 설치 판정 | 손상·알 수 없는 버전·동시 작업·중단된 기록이 자동 재활성화나 외부 파일 덮어쓰기를 일으키지 않음 |
| **핵심** | POSIX shim/helper/rc와 Windows raw Path 설치·제거 | 앞/뒤 npm 충돌 fixture, 중복 블록, symlink, 사용자 수정, 공백/인용부호 경로, 재실행 idempotence 검증 |
| **통합** | 기동 예약, 로컬 UI/command/진입점, package handoff/proof/probe bypass, status/doctor | 번들 직접 선택, Bun 탐색 생략, update 예외, 종료·signal·stdin 전달, 잘못된 webview 호출 거부 |
| **마감** | 이동·업데이트·제거·충돌 native 검증, 문서·테스트 등록·구조 계약 | 각 지원 OS의 실제 새 터미널에서 선택 확인. AppImage 제외와 미완료 cleanup을 정확히 표시 |

**두 PR의 수동 스택**을 권고합니다.

1. **Rust 설치기 PR**: 기록 계약, 플랫폼 설치·제거, 기동 훅, 최소 로컬 UI, 해당 테스트·문서. 이것만으로 지원 POSIX 새 셸에서 Desktop 명령을 선택하는 독립 기능이 완성되어야 합니다.
2. **런처·진단 PR**: 첫 PR의 기록 계약을 소비하는 reader/handoff, provenance 재배치, 내부 probe bypass, status/doctor, 회귀 테스트.

두 번째를 첫 PR head 대상으로 열고, 부모가 dev에 들어간 뒤 dev로 retarget/rebase합니다. GitHub native stack은 필요하지 않습니다. 첫 PR의 스키마가 바뀌면 두 번째를 재검증합니다.

후속 구현자가 사용할 검증 후보는 Rust fmt/clippy/test, 관련 Bun 회귀 파일, typecheck, test-layout, structure/privacy 검사와 packaged native smoke입니다. **이번 조사에서는 실행하지 않았습니다.** 특히 현재 Rust CI는 Ubuntu이므로 Windows 레지스트리·새 터미널 선택의 증거가 아닙니다. [ci.yml:1535](.github/workflows/ci.yml:1535), [ci.yml:1575](.github/workflows/ci.yml:1575)

테스트 파일은 다음 배치를 권고합니다.

- `tests/cli/ocx-launcher-desktop-handoff.test.ts`
- `tests/cli/cli-path-diagnostics.test.ts`
- `tests/clients/desktop-cli-command-surface.test.ts`
- Rust 각 모듈의 `#[cfg(test)]`

TS 파일은 `layout.json.explicit`과 `test-layout-expected.json` 양쪽에 등록합니다. 문서는 `structure/desktop-shell.md`, `structure/runtime.md`, 필요 시 `structure/cli-management.md`, desktop guide의 en/ko를 수정하고 다른 로케일의 설치·제거 설명과 모순을 확인합니다. [test-layout-tooling.test.ts:249](tests/test-layout-tooling.test.ts:249), [structure/INDEX.md:3](structure/INDEX.md:3)

**열린 PR과의 충돌**

조회 당시 세 PR 모두 OPEN이었습니다.

| PR·확인한 head | 실제 충돌 지점 | 통합 권고 |
|---|---|---|
| [#6802](https://github.com/lidge-jun/opencodex/pull/6802), `1718fcad8b` | `status.ts`, `doctor.ts`, desktop guide, `desktop-shell.md`, `runtime.md` | 기존 supervision은 runtime authority입니다. 새 `cliCommand`를 별도 필드로 추가하고, 공개 CLI 기록을 runtime ownership 증거로 사용하지 않습니다. Windows supervision의 `unsupported`도 PATH 설치 성공으로 치환하지 않습니다. [desktop-supervision.mjs:73](https://github.com/lidge-jun/opencodex/blob/1718fcad8ba90e6afd12a8c5a03f7fc222f69742/src/service/desktop-supervision.mjs#L73) |
| [#6809](https://github.com/lidge-jun/opencodex/pull/6809), `b3b7218907` | `bin/ocx.mjs`, update·service guard, 공유 문서. base는 #6802 head branch | update/uninstall 예외를 유지하여 guard를 우회하지 않습니다. 설치 기록은 “서비스 stop/replace 허가”가 아닙니다. 감사 기준 963행의 의미상 삽입점은 이 head에서 **999행 뒤**입니다. 숫자 대신 inspection 뒤·update 분기 앞을 기준으로 적용합니다. [해당 런처:994](https://github.com/lidge-jun/opencodex/blob/b3b72189078137a00b32571de861d3b963582f44/bin/ocx.mjs#L994) |
| [#6807](https://github.com/lidge-jun/opencodex/pull/6807), `b880f9c6b9` | launcher imports, `resolveBun`, 기존 launcher source/runtime 테스트, `runtime.md` | handoff는 Bun resolver 전에 종료합니다. 새 파일로 로직을 분리하고 기존 `findDesktopCli`는 안내 전용으로 유지합니다. 그 함수를 실행 대상 검증기로 재사용하지 않습니다. [bun-path-runtime.mjs:79](https://github.com/lidge-jun/opencodex/blob/b880f9c6b9efaf161336f0b30ec8d5fcc3cea2b4/src/lib/bun-path-runtime.mjs#L79) |

범위 추가 제안은 **소유 `path.sh` helper, 단일 기록의 journal/lock, 내부 버전 probe bypass, tray 진입점**입니다. 새 Windows helper·MSI/deb 제거 훅·AppImage 영속 추출·직접 compiled CLI의 provenance 변경은 확정 범위에 넣지 않았습니다. Windows 충돌 환경까지 오너 목표의 필수 성공 조건이라면, A3의 제한을 받아들이는 것으로 끝내지 말고 그 플랫폼의 후속 설계를 확장해야 합니다.

