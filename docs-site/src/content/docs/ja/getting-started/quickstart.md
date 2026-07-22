---
title: クイックスタート
description: 最初のプロバイダーを設定し、3 つのコマンドで OpenAI Codex を opencodex 経由にルーティングします。
---

このガイドは新規インストール状態から非 OpenAI モデルで Codex を実行するまでを案内します。

## 1. セットアップウィザードの実行

```bash
ocx init
```

`ocx init` は次の手順を案内します:

1. **プロバイダー選択** — 組み込みレジストリのプリセット 50 個から一つを選ぶか、`custom` を選んで
   base URL とアダプターを直接入力します。
2. **API キー** — キーを貼り付けるか、`${ANTHROPIC_API_KEY}` のような環境変数を参照します。
3. **デフォルトモデル** — API キー、ローカル、custom プロバイダーではプリセット値を使うかモデル ID を直接入力します。
4. **プロキシポート** — デフォルトは `10100` です。
5. **Codex に注入しますか?** — 一般的なローカル専用構成では
   `$CODEX_HOME/config.toml`(デフォルト `~/.codex/config.toml`)のルートに `openai_base_url` を追加し、
   Codex の組み込み `openai` プロバイダーがプロキシを見るようにします。LAN などの外部アドレスにバインドした
   構成では API 認証ヘッダーを含む専用プロバイダーエントリを代わりに使います。
6. **自動起動 shim をインストールしますか?** — オンにすると `codex` 実行時にまず `ocx ensure` が実行されます。

結果は `$OPENCODEX_HOME/config.json`(デフォルト `~/.opencodex/config.json`)に保存されます。

:::note[GPT-5.6 ロールアウト準備項目]
安定版 v2.7.1 は ChatGPT パススルー、OpenAI API キー、OpenRouter、実験段階の Cursor アダプターに
GPT-5.6 Sol/Terra/Luna 項目をデフォルトで提供します。実際に呼び出すには該当 upstream アカウントに利用権が必要です。
OpenAI API キーと OpenRouter プリセットは 372,000 トークンの利用可能コンテキスト情報を
Codex に提供し、Cursor はアダプターが提供する別のメタデータを使います。
:::

## 2. プロキシの起動

```bash
ocx start            # デフォルトポート 10100
ocx start --port 8080
```

起動時に opencodex は:

- PID を `~/.opencodex/ocx.pid` に記録し(二重起動を拒否)、
- 対応プロバイダーではライブモデルを照会し、ネイティブおよびルーティング項目を **Codex モデル
  カタログに同期**し、
- `http://localhost:<port>/v1` で待機します。

要求したポートが既に使用中の場合は空きポートを探して `runtime-port.json` に記録し、Codex が実際の
リスナーを使うように設定を更新します。

確認:

```bash
ocx status
ocx gui       # 現在のポートでダッシュボードを開く
```

## 3. Codex の使用

これで Codex は opencodex と透過的に通信します:

```bash
codex "Refactor this function for readability"
```

特定のルーティングモデルを指定するには、Codex のモデルピッカーに表示される `provider/model` 形式を使ってください:

```bash
codex -m "anthropic/claude-opus-4-8" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

GPT-5.6 の利用権がある場合、ネイティブ ChatGPT 経路は bare モデル名、API キーと OpenRouter 経路は明示的
`provider/model` 形式を使ってください:

```bash
codex -m "gpt-5.6-sol"                    "Plan a risky refactor"
codex -m "openai-apikey/gpt-5.6-terra"    "Review this architecture"
codex -m "openrouter/openai/gpt-5.6-luna" "Summarize this trace"
```

## サブエージェントモデルの選択(任意)

新規構成では `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.4-mini` が
Codex のサブエージェントピッカーにデフォルトで表示されます。`ocx gui` でネイティブモデルとルーティングモデルを
合わせて最大 5 つまで変更や並び替えができます。推奨サブエージェントモデルと推論負荷も指定でき、
opencodex はこの値を v1 コラボリクエストのガイダンスメッセージに反映します。

## キーを貼り付ける代わりにログイン

一部のプロバイダーは実際のアカウントログインをサポートします(OAuth、自動更新):

```bash
ocx login xai          # または anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

デフォルトの OpenAI 経路は**キー不要**です — 既存の `codex login` 認証情報をそのまま転送します。
OpenAI API キーを別に使うには `openai-apikey` プロバイダーを追加してください。このプリセットには
`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` が含まれますが、API キーに実際の利用権が必要です
([プロバイダー](/opencodex/ja/guides/providers/)参照)。

## 停止と復元

```bash
ocx stop          # プロキシを停止しネイティブ Codex を復元
ocx restore       # プロキシは残したままネイティブ Codex を復元(エイリアス: ocx eject)
ocx restore back  # 実行中のプロキシに Codex を再接続
```

## 次へ

- [仕組み](/opencodex/ja/getting-started/how-it-works/) — 各リクエストで何が起きるか。
- [プロバイダー](/opencodex/ja/guides/providers/) — 認証のすべての方法。
- [設定](/opencodex/ja/reference/configuration/) — 完全な `config.json` リファレンス。
