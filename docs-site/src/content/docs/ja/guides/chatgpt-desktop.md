---
title: ChatGPT デスクトップの送信ロック解除
description: アカウントの使用量上限に達しても ChatGPT デスクトップアプリの入力欄を使えるようにします（macOS、オプトイン）。
---

ログイン中の ChatGPT アカウントが使用量の上限に達すると、ChatGPT デスクトップアプリは送信ボタンを
グレーアウトします。その会話のモデル呼び出しを opencodex が別のプロバイダーにルーティングしている
場合でも同様です。このオプトインの macOS 連携は入力欄を使える状態に保ちます。既定ではオフです。

## 変更される内容

opencodex は `chatgpt.com` 用のローカル TLS リスナーを動かします。アプリは `chatgpt.com` を
このリスナーに向ける Chromium スイッチ付きで起動され、それ以外のホスト（サブドメインを含む）は
通常の経路のままです。リクエストはアプリ自身の認証情報で本物の `chatgpt.com` に中継され、
WebSocket（音声入力など）も中継されます。ログや保存は一切行いません。

レスポンスは次の 2 つのエンドポイントを除き、そのまま通過します。

- 会話メタデータ（`/backend-api/conversation/init` と会話ストリーム）: 使用量上限による送信ロックを取り除きます。
- 使用量スナップショット（`/backend-api/wham/usage`）: 「上限到達」のゲートを開きます。

サブスクリプションが必要な場合など、それ以外の理由による送信ロックは残され、
`ocx chatgpt status` に表示されます。表示される使用量（割合、リセット時刻、バナー）は変更されず、
OpenAI のサーバーは自身へのリクエストに対してすべての制限を引き続き適用します。

## セットアップ

1. `~/.opencodex/config.json` で機能を有効にし、opencodex を再起動します。

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   リスナーはプロキシのポートに 200 を足したポート（既定は `10300`）を使います。
   別のポートを使うには `chatgptDesktop.port` を設定します。

2. ローカル認証局を一度だけ信頼します。このコマンドはログインパスワードを求めるので、ご自身で実行してください。

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   この信頼がないと、アプリはアカウント、使用量、設定のページを読み込めません。opencodex の
   ホームを変更している場合は、`ocx chatgpt status` が環境に合った正確なコマンドを表示します。

3. opencodex 経由でアプリを起動します。

   ```bash
   ocx chatgpt launch
   ```

4. 任意: Dock や Spotlight からの通常の起動でも経路を使うようにします。

   ```bash
   ocx chatgpt install-watcher
   ```

   ウォッチャーはアプリの起動ごとに動きます。opencodex の実行中にアプリが通常の方法で開かれた場合、
   起動直後にアプリを終了し、経路付きで開き直します。使用中のアプリには何もせず、opencodex が
   動いていないときも何もしません。このコマンドは確認を求めます。`--yes` で非対話的に確認できます。

## ネットワーク構成

VPN やプロキシのルール設定は不要です。既定のモードでは、起動引数はアプリの起動のたびにシステムプロキシから選ばれます。

| 構成 | アプリの起動引数 |
|---|---|
| プロキシなし | `chatgpt.com` の経路のみ。 |
| システムプロキシモードの VPN | 経路、直接接続へのフォールバック付きのシステムプロキシ、`chatgpt.com` のみのバイパス。 |
| TUN モードの VPN | 経路のみ。ループバック通信はトンネルに入りません。 |
| PAC ファイル | 経路のみ。PAC ファイルが `chatgpt.com` をプロキシに残す場合、入力欄はロックされたままになることがありますが、ほかの機能は壊れません。 |

opencodex は、ほかの外向き通信と同じく自身の `proxy` 設定で本物の `chatgpt.com` に接続します。

## opencodex を止めてもアプリを使い続ける

既定のモードでは、経路付きのアプリはリスナーに依存します。opencodex が止まっている間、`chatgpt.com`
へのリクエストは失敗します。PAC フォールバックでは、代わりに生成した PAC ファイルでアプリを起動する
ため、アプリが自動的にフォールバックします。

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` は `unblockSend` と一緒のときだけ有効です。このとき opencodex はリスナーのポート + 1
（既定では `10301`）でも待ち受け、起動のたびにホームディレクトリの `chatgpt-unblock.pac` を書き直します。
PAC は `chatgpt.com` をまず opencodex に送り、それ以外のホストはシステムの経路どおりに送ります。

| 構成 | ほかのホスト、および opencodex 停止中の `chatgpt.com` |
|---|---|
| プロキシなし、または TUN モードの VPN | 直接接続。 |
| システムプロキシモードの VPN | システムプロキシ、次に直接接続。 |
| PAC ファイル | システムの PAC（生成したファイルに埋め込み）。 |

opencodex が止まっても、アプリは再起動なしにこの経路で動き続けます。送信ロックの解除だけが、opencodex
が戻るまで止まります。経路は opencodex の起動時に取得されます。VPN のモードを変えたら、opencodex を
再起動して `ocx chatgpt launch` を実行してください。その時点でシステムの PAC が設定されているのに
読み取れない場合、ほかのホストは直接接続になり、opencodex が警告を表示します。

`pacFallback` を切り替えたあとは、opencodex を再起動して `ocx chatgpt launch` を実行し、ウォッチャーを
使っている場合は `ocx chatgpt install-watcher` も実行し直してください。

## 状態の確認

```bash
ocx chatgpt status
```

機能が有効か、ポートのリスナーが opencodex のものか、証明書が信頼されているか、ウォッチャーの状態、
実行中のアプリが経路を持っているか、意図的に残された送信ロックを表示します。

## 無効にする

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` は経路付きのアプリをネイティブのネットワークで開き直します。そのあと
`chatgptDesktop.unblockSend` を `false` にして opencodex を再起動します。認証局は opencodex の
Claude 連携と共用です。どちらも使わない場合にのみ信頼を削除してください。

## トラブルシューティング

- **アカウント、使用量、設定のページが読み込めない:** 証明書が信頼されていません。手順 2 をもう一度
  実行してください。`ocx chatgpt status` に信頼の状態が表示されます。
- **送信ボタンがグレーのまま:** `ocx chatgpt status` を確認してください。アプリが経路なしで動いている
  （`ocx chatgpt launch` を実行）か、ロックの理由が使用量上限ではなく「send blocks kept」に表示されて
  いる可能性があります。
- **opencodex を止めるとアプリが何も読み込めない:** 既定のモードでは、経路付きのアプリはリスナーに
  依存します。opencodex を再び起動するか `ocx chatgpt restore` を実行してください。PAC フォールバックを
  有効にすると、アプリが自動的にフォールバックします。
