---
title: クイックスタート
description: 最初のプロバイダーを構成し、3 つのコマンドで OpenAI Codex を opencodex 経由でルーティングします。
---

このガイドでは、新規インストールから非 OpenAI モデルに対して Codex を実行するまでを説明します。

## 1. セットアップウィザードを実行します

```bash
ocx init
```

`ocx init` では次の手順を説明します。

1. **プロバイダーを選択してください** — 79 個の組み込みレジストリプリセットのいずれか、または `custom` を選択してベース URL とアダプターを入力します。
2. **API キー** — キーを貼り付けるか、`${ANTHROPIC_API_KEY}` のような環境変数を参照します。
3. **デフォルト モデル** — キー、ローカル、カスタム プロバイダーの場合は、プリセットを受け入れるか、モデル ID を入力します。
4. **プロキシ ポート** — デフォルトは `10100` です。
5. **Codex に挿入しますか?** - 通常のループバック設定では、opencodex はルート `openai_base_url` を
`$CODEX_HOME/config.toml` (デフォルトは `~/.codex/config.toml`) なので、Codex の組み込み `openai` プロバイダーはプロキシをターゲットにします。リモート/LAN バインドでは、代わりに API 認証ヘッダーを持つ専用プロバイダー エントリを使用します。
6. **自動起動シムをインストールしますか?** — 有効にすると、`codex` を起動すると、最初に `ocx ensure` が実行されます。

結果は `$OPENCODEX_HOME/config.json` (デフォルトは `~/.opencodex/config.json`) に保存されます。

:::note[GPT-5.6 ロールアウト エントリ]
現在の安定版リリースでは、ChatGPT パススルー、OpenAI API キー、OpenRouter、実験用 Cursor アダプター用に GPT-5.6 Sol/Terra/Luna をシードしています。これらは、上流アカウントがアクセス権を持っている場合にのみ機能します。 OpenAI API キーと OpenRouter プリセットは、922,000 トークンの使用可能なコンテキスト ウィンドウをアドバタイズします。カーソルは独自のアダプターのメタデータを保持します。
:::

## 2.プロキシを開始します

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

開始時、opencodex:

- PID を `~/.opencodex/ocx.pid` に書き込みます (そして 2 回起動を拒否します)。
- プロバイダーがサポートするライブ モデルを検出し、**ネイティブ エントリとルーティングされたエントリを同期します
Codex のモデル カタログ**、
- `http://localhost:<port>/v1`で聴いています。

要求されたポートがビジーの場合、`ocx start` は空きポートを選択し、それを `runtime-port.json` に記録し、ライブ リスナーを使用するように Codex を更新します。

確認してください:

```bash
ocx status
ocx gui       # open the dashboard on the live port
```

## 3.Codexを使用する

Codex は透過的に opencodex と通信するようになりました。

```bash
codex "Refactor this function for readability"
```

特定のルーティングされたモデルをターゲットにするには、Codex のモデル ピッカーに表示される `provider/model` フォームを使用します。

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## サブエージェント モデルの選択 (オプション)

新しい設定には、Codex のサブエージェント ピッカーの 5 つのネイティブ モデル、`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、および `gpt-5.4-mini` が含まれています。 `ocx gui` を開いて、最大 5 つのネイティブ モデルまたはルーティング モデルを置換または並べ替えます。ダッシュボードでは、優先サブエージェント モデルと推論負荷を 1 つ設定することもできます。 v1/base/v2 を選択し、ガイダンス、ネイティブのデフォルト、およびフォールバックがいつ適用されるかを理解するには、[サブエージェントサーフェス](/guides/sub-agent-surface/) を参照してください。

## キーを貼り付ける代わりにログインする

一部のプロバイダーはリアル アカウント ログイン (OAuth、自動更新) をサポートしています。

```bash
ocx login xai          # or: anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

OpenAI 自体には **キーは必要ありません**。デフォルトのプロバイダーは既存の `codex login` 認証情報をそのまま転送します ([プロバイダー](/guides/providers/) を参照)。

## 停止と復元

```bash
ocx stop          # stop the proxy and restore native Codex
ocx restore       # restore native Codex without stopping (alias: ocx eject)
ocx restore back  # route Codex through the still-running proxy again
```

## 次

- [仕組み](/getting-started/how-it-works/) — 各リクエストに何が起こるか。
- [プロバイダー](/guides/providers/) — あらゆる認証方法。
- [構成](/reference/configuration/) — `config.json` の完全なリファレンス。
