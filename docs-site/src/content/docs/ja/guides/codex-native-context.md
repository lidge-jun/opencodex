---
title: ネイティブコンテキストの互換性
description: Codex の履歴・ノート中継の利用条件、認証付き試用設定、制限事項。
---

OpenCodex は既に Codex ネイティブの履歴とノートを中継します。これはルーティングされたプロバイダー向けの汎用メモリーサービスではありません。また、HTTP エンドポイントが公開されていても、特定の Codex ビルド、アカウント、モデルで利用できるとは限りません。中継の所有権、キャンセル、資格情報の境界については [Codex 連携](/ja/guides/codex-integration/)を参照してください。

## 独立した二つの要件

Codex が拡張を有効化し、OpenCodex が呼び出し元を識別する必要があります。バックエンド URL の変更だけでは、どちらの要件も満たせません。

確認した上流 Codex の契約では、ネイティブカタログ項目が `supports_experimental_context` を示すモデル、対象となる ChatGPT ログイン、名前が正確に `OpenAI` でベース URL が `/backend-api/codex` で終わるプロバイダーが必要です。自動有効化では `env_key`、`experimental_bearer_token`、コマンドで取得する `auth`、AWS 認証を使うプロバイダーは拒否されます。確認した適格性の判定は ChatGPT Plus、Pro、ProLite を受け入れますが、それらのプランの全アカウントでバックエンドの履歴エンドポイントが動作するという意味ではありません。

OpenCodex はさらに、成功したモデル要求と後続のコンテキスト要求の両方で、有効な**データプレーン API キー**を必要とします。既定の組み込みループバック注入はそのキーを送らないため、モデルは利用できても、コンテキスト呼び出しは `context_principal_required` (403) で失敗しえます。認証付きリモートプロバイダーテーブルの形式だけでもネイティブコンテキストは使えません。その `env_key` とプロバイダー名が上記の Codex 有効化契約を満たさないためです。どちらの問題も、プリンシパルやアカウント所有権のチェックを外して隠さないでください。

## 明示的なオプトイン構文

OpenCodex は、Codex の `FeatureToml` が受け入れるルートの機能設定形式を両方とも認識します。

```toml
[features]
context_management = true
```

同等のテーブル形式も使えます。これはブール値形式をまだ認識しなかった古い OpenCodex バージョンとの互換表記です。

```toml
[features.context_management]
experimental_mode = true
```

二つを同時に使わず、一方だけを使ってください。false、未設定、不正な値は無効のままです。プロキシは自身の Codex ホーム設定を読みます。CLI だけの上書きや、Codex プロファイル内だけのオプトインでは実行時ゲートは有効になりません。この変更ではモデルメタデータからオプトインを推定しません。

## 認証付きネイティブ試用プロファイル

これは**ソースを確認した試用設定であり、実アカウントでのエンドツーエンド認証ではありません**。試験前に Codex 設定をバックアップし、復元可能な作業チェックポイントを確保してください。新しい使い捨てのスレッドを使い、稼働中の既存スレッドのプロバイダー識別子を変更しないでください。

Codex プロセスの環境変数 `OCX_CONTEXT_API_KEY` に、既存の有効な OpenCodex データプレーンキーを設定します。管理者トークンを使ったり、キーを TOML に保存したりしないでください。サービスの環境変数が、別に起動したデスクトップアプリへ自動で引き継がれることはありません。通常の Codex ネイティブ ChatGPT ログインも維持してください。追加のヘッダーは OAuth の代わりにはなりません。

上記のルート機能オプトイン、OpenCodex で設定済みの正規 ChatGPT 転送プロバイダー、最新のネイティブモデルカタログを前提に、次の**追加の**プロバイダーとプロファイルを同じ Codex 設定へマージします。ポートを実際のローカルプロキシに合わせて変更してください。ルートの `model_provider` と既存のプロバイダーテーブルは変更しません。

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

`codex --profile ocx-native-context` で新しい CLI スレッドを開始します。この例では初回試用をモデルから中継への所有権経路に絞るため HTTP/SSE を使用します。他のプロファイルの通信方式は変更せず、WebSocket や途中ターンの操作との同等性を認証するものでもありません。アカウントのネイティブカタログがそのモデルのコンテキスト機能を実際に示す場合にのみ使用し、Devin、Gemini、その他のルーティングされた項目へフラグを強制しないでください。

カスタムプロバイダー ID には理由があります。上流の Codex は一般に `model_providers.openai` から組み込みプロバイダーを上書きしないため、そこへ追加したヘッダーが黙って無効になる可能性があります。カスタム ID は通常のプロバイダーを保ち、正確な `OpenAI` という名前でネイティブバックエンドの判定条件を満たします。このプロファイルへ `env_key` を追加しないでください。`env_http_headers` がローカルのアクセス制御を別途担い、`Authorization` は引き続きネイティブ ChatGPT ログインを運びます。OpenCodex はローカルキーを使用しますが、ChatGPT へ転送しません。

ルートのオプトインは他の対象ネイティブプロファイルにも影響します。**この試用中は、追加キーのない通常の組み込みループバックスレッドを続行しないでください。** そのスレッドへ戻る前にルート機能をオフにし、`ocx sync` を実行します。これは自動または既定の連携変更ではなく、この CLI プロファイルはデスクトップでのプロファイル選択対応を主張するものでもありません。

## コンテキストをリセットする前の検証

まず新しいスレッドでネイティブモデルから正常な応答を得ます。次にノートを書き、同じノートを読み戻し、そのスレッドの履歴を問い合わせます。それらがすべて成功してから、使い捨ての試験で `new_context` を実行し、保存状態を復元できることを確かめてください。試用が成功しても外部のチェックポイントは残してください。

- **403 `context_principal_required`:** 有効なローカルのデータプレーンキーがプロキシに届いていません。
- **409 `context_account_unavailable`:** 所有権が欠けているか整合していません。現在のアクティブアカウントを代用したり、書き込みをむやみに再試行したりしないでください。
- **404:** プロキシ側の無効化・未知のエンドポイント応答と、上流の 404 を区別してください。後者は OpenCodex のルーティング不具合やアカウント全体の障害を証明しません。

モデル呼び出しの成功や `ocx ready` は、ノート、履歴、状態復元が動作する証拠ではありません。モデルルーティング、アカウント変更、プロキシ再起動、上流エンドポイントの可用性はそれぞれ別の問題です。ローカルのフラグで不足しているバックエンド利用資格を付与することはできず、失敗したコンテキスト操作をリセット成功と報告してはいけません。終了時には試用用テーブルを削除し、試用キーの設定を解除します。検証済みの認証経路を使う場合を除き、機能は無効のままにしてください。

## 確認した上流の契約

以下のリンクは上記設定の根拠となるソース契約を固定したもので、配備時の動作保証ではありません。

- [FeatureToml のブール値・テーブル形式](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [ネイティブコンテキストの利用条件](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [プロバイダーの識別子と組み込み設定のマージ規則](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [履歴・ノートがプロバイダーのリクエストヘッダーと認証を使う処理](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
