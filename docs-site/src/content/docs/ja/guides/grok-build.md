---
title: グロクビルド
description: xAI の Grok Build CLI から opencodex でルーティングされたモデルを使用します。モデルはプロキシの実行中に ~/.grok/config.toml に自動登録されます。
---

opencodex はローカル ポート上で OpenAI 互換の `POST /v1/chat/completions` (および `/v1/responses`) を提供し、Grok Build は OpenAI 互換サーバーに対するカスタム モデルをサポートします。この統合により、opencodex は表示されているカタログ全体を Grok Build に自動的に登録します。手動による構成編集は必要ありません。

## 自動登録

`~/.grok` が存在する場合、`ocx start` (および `ocx ensure` / `ocx restart`) はマネージド ブロックを `~/.grok/config.toml` に書き込みます。

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
# <<< opencodex managed block <<<
```

- **追加:** フェンスの外側にある独自の設定には決して触れません。最初の前に
既存のファイルに注入すると、1 回限りのバックアップが `~/.grok/config.toml.bak-opencodex` に書き込まれます。
- **べき等:** すべての `ocx start` (および自動起動が有効な場合は `ocx ensure`) が置き換えられます。
現在のカタログを含むフェンスで囲まれたブロック。
- **分解時に削除:** `ocx stop`、`ocx eject`、`ocx uninstall`、およびグレースフル
非サービスデーモンをシャットダウンすると、フェンスで囲まれたブロックが削除され、ファイルがバイト単位で復元されます。サービス マネージャーの下では、ティアダウンは `ocx stop`/`ocx uninstall` を経由します (サービス モード プロセスは、再生成後も意図的にブロックを保持します)。
- **競合安全:** 独自の `[model.*]` テーブルですでに定義されているエイリアスが尊重されます
(opencodex は独自のエントリに接尾辞を付けます);損傷したフェンス (終了マーカーのない開始マーカー) は自動変更を拒否し、手動での修復を要求します。

次に、Grok Build 内のモデルを選択します。

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

## 推論 effort

Grok Build の `/effort`（および `--effort`）は、カタログ項目がラダーを公開している
モデルで動作します。モデル一覧は生の `GET /v1/models` 応答を読み、その項目には
`supports_reasoning_effort` と `reasoning_efforts` のメニュー選択肢が必要です。ラダーを
Grok 互換に投影した内容が、管理対象の各 `[model.*]` テーブルにも
`supports_reasoning_effort`、既定の
`reasoning_effort`、`[[model.<alias>.reasoning_efforts]]` の各行として書き込まれます。
ルーティングされたモデルでは、opencodex が設定済みのプロバイダー階層
（`reasoningEfforts` / `modelReasoningEfforts` と
`modelDefaultReasoningEfforts` の既定値）を反映します。このメタデータはプロキシで
設定されたラダーを表し、アダプターは推論をエミュレートしたり、レベルを
プロバイダー固有のフィールドへ変換したりできます。空の階層リストでは effort
コントロールを表示しません。ネイティブ GPT-5.6 項目は、固定された上流の推論
ラダーを保持します。モデルが公開する有効な Grok 段階（`none` と `minimal` を含む）は
保持されます。Codex 固有の `ultra` を含む、未対応または重複する段階はファイルから
除外され、出力された選択肢はすべて実行できます。

Grok Build は Responses API 経由で opencodex と通信します。ルートが推論ラダーを
公開している場合、Responses パススルーは設定どおりに `reasoning.summary` を転送するため、
推論トレースは Responses の reasoning 項目としてそのまま Grok に届きます。トレースを
返さずにモデルに推論させるクライアントは、`reasoning.summary: "none"` を設定できます。
明示的な `reasoning.summary` はルートの既定値より優先されます。

## 認証メモ

Grok Build では、ループバックでもカスタム モデルに対して空ではない API キーが必要です。挿入されたエントリにはプレースホルダー (`opencodex-loopback`) が含まれます。opencodex はループバック接続のアドミッション キーを無視するため、実際の秘密は関係しません。

**自動登録はループバックのみです。** opencodex が非ループバック ホスト (すべてのインターフェイスを公開するワイルドカード `0.0.0.0` および `::` を含む) をバインドする場合、リクエストには実際のアドミッション トークンが必要であり、マネージド ブロックはそれを安全に運ぶことができません。リテラルトークンを書き込むと、シークレットが `~/.grok/config.toml` に設定され、そこで設定した内容が次の `ocx start`/`ensure`/`restart` に上書きされます。したがって、その場合、opencodex は何も書き込みません (そして、以前のループバック バインドで残ったブロックはすべて削除します)。また、管理対象マーカーの外側でモデルを自分で設定します。opencodex が何をしてもモデルを破壊することはありません。正確なテーブルについては [マニュアルレシピ](#manual-recipe-without-auto-registration) を参照し、`base_url` (`grok` を実行する場所から実際に到達可能なホスト) と `api_key` (`OPENCODEX_API_AUTH_TOKEN`) の両方を設定します。

ここで `api_key` を `env_key` に置き換えないでください。解決に失敗した `env_key` はリクエストを停止しません。Grok は xAI セッション トークンに到達し、それをエントリ名が `base_url` に送信します。LAN デプロイメントの場合、これは xAI ではないプレーンテキスト HTTP エンドポイントです。

プロバイダー エントリに注入された `api_key` は、これらのモデルの Grok 資格情報チェーンの最初に位置するため、opencodex に対抗する場合は追加の Grok ログインは必要ありません。ネイティブ grok モデルおよび xAI に直接接続するハーネス機能については、通常の `grok login` / `XAI_API_KEY` セットアップを維持します。

## 手動レシピ（自動登録なし）

`~/.grok/config.toml` を自分で管理する場合、または opencodex が非ループバック バインド上にある場合は、`[model_providers.opencodex]` ブロックとそれを参照するモデルごとのテーブルを `# >>> opencodex managed block` マーカーの外側に追加します。

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

ネットワーク経由で到達可能なプロキシの場合は、`grok` が実際にダイヤルしてアドミッション トークンを使用できるアドレスに `base_url` を指定します。

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

管理ブロックは `[model_providers.<id>]` 継承を使用するようになり、Grok Build 0.2.109 以降（2026-07-21 リリース）が必要です。旧バージョンでは継承された `base_url` は推論ルーティングに適用されません——アップグレードするか、各 `[model.*]` テーブルでモデルごとの直接フィールド（`base_url`/`api_backend`/`api_key`）を使用してください。

ドットを含むエイリアスを引用符で囲みます。裸の `[model.grok-4.5]` は 3 セグメントのキー パスであり、ID `grok-4.5` ではありません。この理由により、生成されたエイリアスではドットが完全に回避されます。

## 既知の制限事項

- **サービスでインストールされた `ocx restart`:** 実行中のプロキシが再起動の認可とドレインの調整を担当し、古いプロセスの終了後はインストール済みのサービス マネージャーが置換プロセスを起動します。サービス監視は維持されます。ループバックの自動登録を使用している場合に限り、マネージド ブロックもハンドオフ中に維持されます。非ループバック構成では Grok 設定を手動管理します。同じポートで、別の ID 検証済みプロセスが正常になったことを確認した場合にのみ成功します。
- **構成読み取りタイミング:** 最初に opencodex を起動し、その後 `grok` を起動します。
予測可能な結果。 Grok Build は `~/.grok/config.toml` を監視し、`[model]` テーブルが実際に変更されると (内容で比較すると約 1 秒のデバウンス) 再ロードするため、更新されたブロックは再起動せずに開いているセッションに到達します。 Grok が解析した内容を確認するには、`grok inspect` を実行します。ロードされた設定ソースがリストされ、拒否されたフィールドについて警告が表示されます。解決されたモデルのリストは出力されません。現在の Grok Build は無効なモデルフィールドを警告してスキップし、残りのモデル項目を保持します。TOML 構文エラーがあるとファイルは読み込まれません。opencodex はファイルをアトミックに書き込むため、Grok は再読み込みのたびに完全な文書を認識します。
- **カタログの更新:** フェンスで囲まれたブロックには、射出時のカタログが反映されます。後
プロバイダーまたはモデルを追加するには、`ocx ensure` を実行して (またはプロキシを再起動して) 更新します。
