---
title: Codex にサインインできない、または読み込めない場合
description: opencodex 適用後に Codex のサインインや全リクエストが失敗する場合の対処と、プロキシを起動せずに Codex を元のアカウントに戻す方法を説明します。
---

opencodex の設定後、Codex がサインイン画面で止まる、サインイン要件を読み込めない、またはすべてのモデルリクエストが失敗する場合、Codex が停止中の opencodex プロキシを参照したままになっている可能性が高いです。この問題は [#5261](https://github.com/lidge-jun/opencodex/issues/5261) で報告されました。

## 発生する理由

デフォルトのループバック設定では、opencodex は Codex に別のプロバイダーを追加しません。`$CODEX_HOME/config.toml`（Windows では `%USERPROFILE%\.codex`）にルート設定を書き込み、Codex 組み込みの `openai` プロバイダーをプロキシへ向けます。

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

これらの行はディスクに残るため、再起動後も有効です。Codex の起動時にプロキシが動いていなければ、そのアドレスは応答せず、Codex に切り替え先のエンドポイントもありません。画面には opencodex への言及がないため、Codex 自体の問題と誤解しやすい状態です。

プロキシが動いていない理由は普通の運用上のものかもしれません。Codex 統合を適用してもバックグラウンドサービスはインストールされず、別途 `ocx service install` が必要です。そのため再起動後にプロキシを立ち上げるものがない場合があります。登録済みの Windows スケジュールタスクは起動時ではなくログオン時に開始し、無効化、起動失敗、他のプロセスによるポート占有も起こり得ます。

## Codex を再び使えるようにする

目的に応じて選んでください。どちらもプロキシ停止中に実行できます。

**Codex を元のアカウントとエンドポイントに戻す場合:**

```bash
ocx restore
```

注入されたルーティング、リアルタイム接続の上書き、opencodex カタログへの参照を削除します。実行中のプロキシ、ダッシュボードセッション、ネットワークは不要です。その後、Codex は通常どおりサインインして動作します。opencodex を再び使うときは、`ocx restore back` で Codex をプロキシに向け直せます。

**代わりにプロキシを再起動する場合:**

```bash
ocx start
ocx service install   # keep it running across restarts
```

`ocx status` は、プロキシが応答しているか、Codex が現在そこを経由しているかを報告します。`ocx doctor` は同じ状態をさらに詳しく説明し、推奨する修復方法を示します。

## ocx が使えない場合

ルーティングを手動で元に戻せます。`$CODEX_HOME/config.toml` を開き、`openai_base_url` の行、`experimental_realtime_ws_base_url` の行、そして末尾が `opencodex-catalog.json` の `model_catalog_json` の行を削除してください。最初の 2 行の直上にある `# Auto-injected by opencodex` コメントも一緒に削除します。

コメントではなく、キー名で判断してください。opencodex は、注入した `developer_instructions` など、ほかの管理対象キーにも同じ所有権コメントを使います。それらを消してもサインインは直らず、残しておきたい設定を失う可能性があります。

`model_catalog_json` はルーティングと**一緒に**削除し、単独では削除しないでください。存在しないファイルを指す `model_catalog_json` が残ると、Codex が設定自体を読み込めず、別の原因で同じような利用不能状態になります。

## 追加または表示できないアカウント

プールへのアカウント追加の失敗や、追加済みアカウントが表示されない問題は、同じセッションで起きても、上記の利用不能状態とは別です。アカウントプールはプロキシの管理 API が提供するため、`ocx account login openai` とダッシュボードの一覧は、まずプロキシが動いていなければ機能しません。ブラウザーでのサインインは固定アドレス `http://localhost:1455/auth/callback` に戻るため、別のポートには移せません。ポート 1455 をほかのものが使っている場合やブラウザーを起動できない場合は、代わりにデバイスフローを使います。

```bash
ocx account login openai --device
```

注入される内容とルートの選択方法は、[Codex 統合](/ja/guides/codex-integration/)を参照してください。
