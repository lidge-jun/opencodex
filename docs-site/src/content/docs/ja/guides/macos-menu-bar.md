---
title: macOS メニューバー
description: プロキシの状態確認とライフサイクル操作を行うネイティブ opencodex メニューバーアプリ。
---

macOS 12 以降のメニューバーアプリでは、プロキシの稼働状態、バージョン、稼働時間、PID、ポート、
Bun ランタイム、launchd の状態を確認し、ターミナルなしで起動・再起動・終了できます。

## ビルドと起動

先に `ocx` CLI をインストールして初期化し、リポジトリで次を実行します。

```bash
bun run build:macos
open "dist/macos/OpenCodex.app"
```

完全な Xcode toolchain を選択すると、Universal バイナリを `UNIVERSAL=1 bun run build:macos` で
作成できます。Command Line Tools だけの場合は現在のアーキテクチャのみです。出力はローカル実行用に
ad-hoc 署名され、配布には Developer ID 署名と notarization が別途必要です。

## リリースパッケージ

Release ワークフローは arm64 と x86_64 をまとめてビルドし、`OpenCodex.app` を
`OpenCodex-<version>-macOS-universal.zip` に圧縮して対応する `.sha256` を生成します。
ドライランでも両ファイルをワークフロー artifact として転送・検証し、実際のリリースでは npm 公開の
成功後に GitHub Release へ添付します。自動生成アーカイブは ad-hoc 署名で notarization されていないため、
初回起動時に macOS で手動承認が必要になる場合があります。Gatekeeper でブロックされた場合は、`OpenCodex.app`
を Control-クリックして **開く** を選ぶか、**システム設定 → プライバシーとセキュリティ** で
**このまま開く** を押してください。

アプリは `ocx status --json` を読み、既存 CLI に起動・再起動・終了を委譲します。終了と再起動は
進行中のリクエストを中断する可能性があるため確認ダイアログを表示します。メニューバーアプリだけを
終了してもプロキシは停止しません。

プロキシ状態の行は常に明瞭に表示され、サブメニューでバージョン、PID、ポート、稼働時間、ランタイム、
サービス、CLI の詳細を確認できます。

`ocx` は PATH、Homebrew、Bun、Volta、pnpm、nvm、fnm から自動検出します。見つからない場合は
**ocx CLI を選択…** で実行ファイルを指定してください。自動起動するには、ビルドしたアプリを
**システム設定 → 一般 → ログイン項目**に追加します。
