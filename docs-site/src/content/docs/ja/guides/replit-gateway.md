---
title: Replit ゲートウェイコンパニオン
description: Replit AI Integrations 経由で OpenAI Chat と Anthropic Messages を中継する独自の Replit デプロイと opencodex をペアリングします。オプトインのカスタムワークフローであり、正規レジストリプリセットではありません。
---

**Replit ゲートウェイコンパニオン**は
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway)
のユーザー所有 Bun サービスで、**Replit デプロイ内**で動作します。Repl 環境の Replit AI Integrations
資格情報を読み取り、opencodex に 2 つのネイティブワイヤーエンドポイントを公開します:

```text
opencodex（ローカル）
  -> HTTPS + ゲートウェイキー
  -> Replit デプロイ（integrations/replit-gateway）
  -> Replit AI Integrations アップストリーム（OpenAI Chat / Anthropic Messages）
```

opencodex は `AI_INTEGRATIONS_*` シークレットを受け取りません。別の **ゲートウェイキー**
（`REPLIT_GATEWAY_KEY`）を opencodex がローカルに保存し、各リクエストで
`Authorization: Bearer …` として送信します。

> **カスタムワークフローのみ。** `replit` と `replit-anthropic` は**正規レジストリプリセットではありません。**
> opencodex は公式 Replit プロバイダーを主張せず、Replit の書面承認があるまでレジストリ昇格は
> ブロックされます（[エビデンスゲート](#エビデンスゲート)参照）。

> **実験的 — デプロイ未検証。** コードと v1 契約は `experimental-pending-canary`。**Replit 実注入環境に対する live デプロイは未検証。**

## 必要なもの

- [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)が
  利用可能な**有料 Replit プラン**。
- Replit Agent が OpenAI・Anthropic 管理統合の追加を求めたときの**手動承認**。opencodex は Replit の
  ログイン、課金、統合ダイアログを自動化しません。
- 公開 **HTTPS** オリジン（通常 `https://<repl>.replit.app`）で到達可能なゲートウェイパッケージ。
- ダッシュボードウィザードまたは CLI インストール用の実行中 opencodex プロキシ（`ocx start`）。

デプロイと設定は
[パッケージ README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)を
参照してください。

## ゲートウェイのデプロイ（概要）

1. `integrations/replit-gateway/` を Bun Repl にコピーします。
2. `loadGatewayConfigFromEnv()` と `createGatewayServer()` を呼び、
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })` する `server.ts` を追加します。
3. Replit UI で **OpenAI** と **Anthropic** の管理統合を承認します。
4. **値を表示せず観察された `AI_INTEGRATIONS_*` 名を確認**（下記）。
5. `REPLIT_GATEWAY_KEY`（**32–512** 印字可能 ASCII）、`REPLIT_GATEWAY_PUBLIC_ORIGIN`、モデル許可リスト、4 つの正確な統合変数名を設定。
6. `GET /healthz` と認証付き `GET /v1/models` の成功を確認。

### Replit 環境名（未検証の観察慣行）

必須名：`AI_INTEGRATIONS_OPENAI_BASE_URL`、`AI_INTEGRATIONS_OPENAI_API_KEY`、`AI_INTEGRATIONS_ANTHROPIC_BASE_URL`、`AI_INTEGRATIONS_ANTHROPIC_API_KEY`。**Replit 公式のプラットフォーム外契約ではない**。**canary 検証待ち**。

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

ゲートウェイキー **32–512** 印字可能 ASCII：

```bash
openssl rand -base64 48 | tr -d '\n'
```

Replit Secrets と opencodex ペアリングにのみ保存し、git には入れないでください。

## opencodex とのペアリング

インストール時にデプロイオリジンから派生した**2 つ**のカスタムプロバイダーが書き込まれます:

| プロバイダー id | アダプター | base URL | 備考 |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | `GET /v1/models` でライブモデル探索 |
| `replit-anthropic` | `anthropic` | `<origin>` | Bearer トランスポート; `liveModels: false` |

同じゲートウェイキーを共有します。ペア置換時、非派生フィールド（選択モデル、pacing、資格情報以外の
カスタムヘッダー）は保持されます。

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

キー源（いずれか 1 つ）: `REPLIT_GATEWAY_KEY`、`--stdin`、`--gateway-key-file <path>`。キーは**コマンド
ラインに書かない**でください。

便利なフラグ: `--allow-custom-domain`、`--replace`、`--set-default`、`--json`。

設定書き込み前、opencodex は**課金対象外**エンドポイントのみプローブします:
`GET <origin>/healthz`、`GET <origin>/v1/models`（Bearer）。

### ダッシュボードウィザード

**Providers** で **Replit gateway…** をクリック:

1. **HTTPS オリジン**と**ゲートウェイキー**を入力。
2. `.replit.app` でない場合は **Allow custom domain** を有効化。
3. 必要ならインストール後 **replit** をデフォルトプロバイダーに。
4. 成功時に health / models プローブの所要時間を表示。

既存ペアがある場合、**Replace pair** の前に明示確認が必要です。正規レジストリプリセット**ではない**
旨が表示されます。

## カスタムドメインのオプトイン

既定は `.replit.app` の HTTPS のみ。opt-in は**所有権を証明せず**、DNS リバインディング/TLS **運用責任を免除しません**。opencodex は HTTPS 構文・インストール前 destination/DNS 評価・HTTPS プローブを**実施**しますが**一時点**の確認です。

## コールドスタート

アイドル後の Repl はスリープする場合があります。最初のリクエストは遅いか
`upstream_error`/`upstream_timeout` になることがあります。インストールプローブのタイムアウトは 8 秒。
課金リレーの自動再試行はありません。

## ゲートウェイ制限（v1）

| 制限 | 既定値 |
| --- | --- |
| 最大リクエスト本文 | 32 MiB |
| 最大ヘッダー | 32 KiB |
| 最大同時リクエスト | 10 |
| アップストリームタイムアウト | 300 秒 |
| クライアントタイムアウト | 310 秒 |

アップストリーム HTTP リダイレクトは拒否。許容範囲はパッケージ README 参照。

## エラー区分

ゲートウェイは安定した JSON エラー区分を返します（シークレットや本文は一切返しません）:

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`.

一般的な HTTP 対応: `401` 認証、`400` 許可されていないモデル、`413` 本文超過、`415` エンコード本文、`429` 同時実行制限、`408` クライアントタイムアウト、`504` アップストリームタイムアウト、`502` アップストリーム/リダイレクト失敗。

## ネイティブ機能（v1）

**対応** — OpenAI Chat・Anthropic Messages のバイトストリーム。SSE `: heartbeat\n\n` は**完全な行境界**のみ。

**遅延 LF 方針：** CRLF が chunk 分割され `\n` が遅延した場合、`\r` を行境界として heartbeat タイミングに使うことがあります。**ペイロードバイトは変更されません**；稀な split-CRLF では**タイミング**が異なる場合があります。

## v1 非対応

- 正規 Replit レジストリプリセット・ピッカータイル
- このゲートウェイ経由の Google Gemini、OpenRouter など
- OpenAI Responses、画像、音声、文字起こし
- OpenAI ↔ Anthropic プロトコル変換
- 自動アップストリーム再試行、キャッシュ、正規化
- ブラウザ CORS
- identity 以外の `Content-Encoding`
- `replit-anthropic` のライブモデル探索
- Replit アカウント・承認・デプロイの自動化

## プライバシー、クレジット、利用規約

- **資格情報の境界:** ゲートウェイキーのみ `~/.opencodex/config.json` に保存。
- **課金:** Replit AI Integrations の利用は公開 API 価格で Replit クレジットに課金。
- **規約:** プランに応じた **Replit 規約**。[利用規約](https://replit.com/terms-of-service)（**Replit, Inc.**）；**Pro/Enterprise** は [Commercial Agreement](https://replit.com/commercial-agreement)。**プラットフォーム外ルーティング承認は未取得。**
- **ログ:** ゲートウェイはメタデータのみ。管理 API 応答にキーは含めません。

## エビデンスゲート

opencodex は一次ソースのエビデンスがある場合のみプロバイダープリセットを維持します
（[コントリビュート — 正規プリセットに必要なエビデンス](/contributing/#evidence-required-for-a-canonical-preset)）。
Replit コンパニオンは**現時点で基準を満たしません**。

| 項目 | 状態（2026-08-22 検証） |
| --- | --- |
| **プラットフォーム外** OpenAI Chat + Anthropic Messages | **未確立** |
| `AI_INTEGRATIONS_*` 名 | **未検証の観察慣行**；canary 待ち |
| 規約・法人 | 利用規約 — **Replit, Inc.**；Pro/Enterprise: Commercial Agreement |
| プラットフォーム外ルーティング | **未取得** |
| 指名されたメンテナンス担当 | **opencodex:** [@lidge-jun](https://github.com/lidge-jun)、[@Ingwannu](https://github.com/Ingwannu)（[`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)）。**Replit:** 本ワークフローのパートナーではない。 |
| 引用可能な検証日 | **2026-08-22** |

**レジストリ昇格はブロック。** `replit`/`replit-anthropic` は `src/providers/registry.ts` にありません。

## 関連

- [パッケージ README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- [設計仕様](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [プロバイダー](/guides/providers/)
- [Web ダッシュボード](/guides/web-dashboard/)
