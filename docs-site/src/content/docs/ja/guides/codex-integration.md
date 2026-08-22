---
title: Codexの統合
description: opencodex が自身を Codex に挿入し、モデル カタログを同期し、shim をインストールし、クリーンに復元する方法。
---

opencodex は、Codex が読み取る 2 つの内容 (構成 (`$CODEX_HOME/config.toml`、デフォルト `~/.codex/config.toml`) とそのモデル カタログ) を編集することで、プロキシを経由する Codex ルートを作成します。すべての編集は冪等であり、元に戻すことができます。

プロキシは、プール (デフォルト) およびダイレクト アカウント モードで 1 つのベア `openai` Codex ログイン ルートと、構成された API キーの `openai-apikey/<model>` を公開します。プールにはメインアカウントと追加アカウントが含まれます。直接は、発信者/メインベアラーのみを使用します。ルートは相互にフォールバックしません。出荷された v1 設定はマーカー 2 に移行され、手動復元用に `config.json.pre-openai-tiers-v2.bak` が保存されます。

## 設定の注入

`ocx init`、`ocx start`、および `ocx sync` はインジェクターを呼び出します。デフォルトのループバック バインドでは、Codex の組み込み `openai` プロバイダー ID を保持し、そのプロバイダーを opencodex にポイントします。

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

# fastMode を設定した場合のみ。未設定なら [features] は作られません
[features]
fast_mode = true
```

注入される `fast_mode` は三値の `fastMode` 設定に従います。`true` は `fast_mode = true` を書き込み、
`false` は `fast_mode = false` を書き込み、未設定の場合は既存の `fast_mode` を変更せずに
`[features]` テーブルも追加しません。

プロキシはデフォルトでポート `10100` をリッスンし、`POST /v1/responses`、`POST /v1/responses/compact`、`POST /v1/images/generations`、`POST /v1/images/edits`、`GET /v1/models`、`GET /healthz`、および `/api/*` 管理サーフェスを提供します。

### 組み込みの画像生成 (`image_gen`)

Codex の組み込み `image_gen` ツールは、`/v1/responses` を経由しません。codex-rs 拡張機能は、チャットに使用するものと同じ ChatGPT ベアラー認証を使用して、`{base_url}/images/generations` (または参照画像が添付されている場合は `/images/edits`) を直接 POST します。挿入された `base_url` は opencodex を指しているため、プロキシはそれらの呼び出しを OpenAI アップストリームに中継します。

これは [イメージブリッジ](/guides/image-bridge/) とは別のもので、非 OpenAI モデルが選択されているときに **Responses** ターンでホストされた `image_generation` ツールがリストされた場合にのみアクティブになります。スタンドアロン `/images/generations` コールがそのブリッジに入ることはありません。

- **1 つのモード対応フォワード候補:** プールは適格なメイン/追加アカウントを選択します。直接使用するのは、
呼び出し元の OAuth ベアラー。構成されたモードは、イメージ要求に一貫して適用されます。
- **OpenAI API キー プロバイダー:** 前方候補が認証を所有していない場合にのみ使用されます。
失敗。壊れた/期限切れのプール認証情報が、別途請求される API 使用量の背後に隠れることはありません。
- **明示的なカスタム プロバイダー:** `images.provider` をカスタム API キーの ID に設定します。
`openai-responses` プロバイダー。そのエンドポイントは OpenAI Images API を実装します。明示的な選択はクローズに失敗し、別の有料アップストリームにフォールバックすることはありません。レジストリで管理されているプロバイダー ID はここでは受け入れられません。組み込みの OpenAI 層を使用するには、`images.provider` を省略します。
- **Google Antigravity (CCA) フォールバック:** OpenAI 前方候補でもキー付きでもない場合
プロバイダーが構成されている場合、`/v1/images/generations` (`/images/edits` ではありません) は、`gemini-3.1-flash-image` モデルを使用して Antigravity **Cloud Code Assist** エンドポイントにフォールバックします。フォールバックは、OpenAI 候補が構成されていない場合だけでなく、OpenAI 認証の解決が失敗した後 (ChatGPT 資格情報の期限切れまたは欠落など) にも起動されます。これには `ocx login google-antigravity` が必要です。 OAuth トークンは、固定された CCA レジストリ ホストにのみ送信され、構成レベルの `baseUrl` オーバーライドには送信されません。応答は、Codex が期待するのと同じ `{created, data:[{b64_json}]}` 形状で返されます。
- **どちらでもない:** プロキシは一般的な 404 ではなく明確なエラーを返します。 ルーティングされたプロバイダー
(Cursor、Gemini、Kiro など) は `image_generation` ツール リレーとして機能できません。このツールをまったく提供したくない場合は、Codex で `codex features disable image_generation` (`config.toml` では `[features] image_generation = false`) を使用してツールを無効にします。

ツール宣言は引き続きモデルの応答リクエストとともに送信されます。 API キー応答プロバイダーの場合、opencodex は Codex のプライベート `image_gen` 名前空間をアップストリームで安全な `image_gen__<inner-name>` エイリアス (`image_gen__imagegen` など) に下げます。使用可能なエイリアスがクライアント宣言を置き換えると、opencodex は重複したホストされた `image_generation` 宣言を削除します。 Codex が関数呼び出しを認識する前に、関数呼び出しを明示的な `image_gen` 名前空間にマップし、後の履歴がアップストリームで再生されるときにネイティブ呼び出しを再度エンコードします。これにより、名前空間を予約したり、ドット付き関数名を拒否したりするパブリック互換のアップストリームで、クライアント側のイメージ生成を呼び出すことができるようになります。 ChatGPT 転送モードは変更されず、ネイティブの Responses Lite の形状が維持されます。

OpenAI 互換のカスタム ゲートウェイの場合は、専用プロバイダーを構成し、スタンドアロン イメージ リクエストに対してのみ選択します。

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

カスタム エンドポイントは、`POST /v1/images/generations` および `/v1/images/edits` を受け入れ、Codex が期待する OpenAI Images 応答形状を返す必要があります。プロバイダーの構成されたキーは、アップストリーム要求の前に呼び出し元ベアラーを置き換えます。

> **注:** これは、Codex `image_generation` ツール (`/images/generations` リレー) のみを指します。
> イメージ対応の Gemini モデルは、`google` アダプターを通じてネイティブにインライン イメージを生成します
> (`responseModalities: ["TEXT", "IMAGE"]` 経由)、このリレーとは独立して — を参照してください。
> [アダプター](/reference/adapters/#google)。

非ループバック `hostname` の場合、Codex は生成された API 認証ヘッダーを送信する必要があります。したがって、インジェクターは代わりに専用のプロバイダーを使用します。

```toml
# root keys
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at the end of the file
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
# supports_websockets = true   # only when config.websockets is true
```

OpenCodex がルーティングを所有している場合、どちらのモードも参照/フォールバック設定として `$CODEX_HOME/opencodex.config.toml` を書き込みます。ループバックでは、自動挿入が削除された場合に手動でマージできるルート キーが含まれています。非ループバックでは、専用のプロバイダー フォームが含まれます。外部プロバイダー モードでは、このプロファイルは変更されません。

:::caution
`openai_base_url`、`model_provider`、`model_catalog_json` などのルート キーは、最初の `[table]` ヘッダーの前に**なければなりません**。インジェクターはその配置を保証し、それ自身の古い/重複したコピーを削除し、ユーザー所有のルート `openai_base_url` を決して上書きしません。存在する場合、sync はカタログを更新しますが、ルーティングが挿入されなかったことを報告します。
:::

## 共有モデルカタログ

Codex CLI、TUI、App、SDK はすべて同じ Codex ホームを読み取ります。 opencodex は、そのディレクトリを `CODEX_HOME` から解決して `~/.codex` にフォールバックし、以下を管理します。

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

WSL では、`CODEX_HOME` が設定されておらず、Linux `~/.codex/config.toml` が存在しない場合、opencodex は `/mnt/c/Users/*/.codex/config.toml` にある単一の Windows Codex デスクトップ ホームもチェックします。候補が 1 つだけ存在する場合は、そのディレクトリが使用されるため、WSL アプリサーバー モードと Windows Codex デスクトップは同じ設定ファイルと認証ファイルを共有します。この検出をオーバーライドするには、`CODEX_HOME` を明示的に設定します。

Windows では、ChatGPT/Codex アプリが `%USERPROFILE%\\.codex` を読み取りながら、Orca シェルは `CODEX_HOME` と `ORCA_CODEX_HOME` の両方を Orca のバンドルされたランタイム ホームに設定できます。 `ocx status` および `ocx doctor` は、この正確な不一致について警告し、編集されたターゲット パスを出力します。バックグラウンド サービスが Orca シェルからインストールされている場合は、最初に元のシェルからアンインストールし、次に `CODEX_HOME` をアプリ ホームに設定し、`ORCA_CODEX_HOME` の設定を解除し、同期/復元を再実行して、サービスを再度インストールします。

専用プロバイダー モードでは、`requires_openai_auth = true` は Codex App/TUI アカウント ゲート サーフェスをネイティブ Codex と一致させます。 opencodex は WebSocket 経由で `/v1/responses` も提供します。専用プロバイダーは、`"websockets": true` の場合にのみ `supports_websockets = true` をアドバタイズします。ループバック時 Codex の組み込みプロバイダーは最初に WebSocket を試行し、無効になったプロキシが `426` を返すため、Codex は HTTP/SSE にフォールバックします。

## スレッドのアイデンティティと履歴

デフォルトのループバック形式では、Codex のネイティブ `openai` プロバイダーでタグ付けされた新しいスレッドが維持されるため、通常の再開履歴には再マッピングが必要ありません。最初の同期時に、古い opencodex ビルドでタグ付けされたスレッドも `openai` に移行されます。非ループバック専用プロバイダー モードでは、アクティブな間は `opencodex` プロバイダーの下で履歴がミラーリングされ、終了時にバックアップされたメタデータが復元されます。履歴を残さないように `syncResumeHistory: false` を設定します。

## モデルカタログの同期

Codex には、ディスク上のカタログ (デフォルトでは `$CODEX_HOME/opencodex-catalog.json`) からのモデルが表示されます。起動時および `ocx sync`、opencodex:

1. **元のカタログを `~/.opencodex/catalog-backup.json` に一度バックアップ**します (したがって、フィーチャリングは
可逆）。
2. **対象プロバイダーのライブ モデル カタログを取得** (最大 5 分間キャッシュされ、最後の正常なカタログにフォールバックします)
リストを作成し、`models[]` を設定します)。前方認証にはモデル エンドポイントがなく、Cursor は `/models` ではなく `GetUsableModels` RPC を使用します。
3. **マージ** ルーティングされたモデルを、ネイティブ Codex から複製された名前空間エントリ (`provider/model`) として結合します。
カタログ テンプレートなので、Codex の厳密なパーサーがそれらを受け入れます。
4. **フィルター** `config.disabledModels` および各プロバイダーの空でない `selectedModels` ホワイトリスト。
5. **再ランク** により、注目のモデルが最初に並べ替えられ (下記を参照)、その後、統合されたカタログが書き戻されます。

プロバイダーとモデルメタデータに応じて Codex の `low | medium | high | xhigh | max | ultra` 段階を使い、
上流がサポートしない値はリクエスト送信前にマッピングまたはサポート範囲に下げます。

### ルーティングされたローカルツール

ネイティブではないルーティング済みカタログ項目は `tool_mode: "code_mode_only"` を使用します。これにより、
Codex は公式の `exec` エントリポイントと、Browser や Computer Use を含むネストされた MCP ツールを公開できます。
opencodex がルーティングするのはモデルの通常の function call だけです。ツールの実行、権限、確認は Codex 内に
残り、opencodex が別のブラウザーやデスクトップ操作 executor を実装することはありません。

Codex の `exec` custom-tool grammar を受け付けない key-auth Responses provider に対しては、opencodex が宣言と
履歴を上流向けの function tool にエンコードし、ストリーミングされた function-call lifecycle を Codex に返す前に
`custom_tool_call` へ復元します。ネイティブ OpenAI の forward routing と、対応済みの `apply_patch` custom tool は
変更されません。

選択した provider は function/tool calling をサポートしている必要があります。tool call に対応しない text-only
provider では `exec`、Browser、Computer Use は使用できません。ネイティブ OpenAI の項目は上流の tool mode を
そのまま維持します。

`ocx sync` でこの metadata を変更した後は Codex App を再起動し、新しいタスクを開いてください。既存の
app-server process とタスクは、起動時に読み込んだ catalog と tool plan を保持している場合があります。

### カスタムモデルの表示名

カスタム モデルは、モデルのルーティング方法を何も変更することなく、Codex がモデル ピッカーに表示するラベルをオーバーライドする人間が判読できる **表示名** を付けることができます。表示名はカタログ エントリの `display_name` フィールドのみにマップされます。ルーティング スラグ (`<provider>/<model>`)、エイリアスの衝突順序、プロバイダー、およびネイティブ OpenAI マーケティング名はすべて変更されません。

CLI から表示名を追加します (プロキシは、ライブ時にカタログをすぐに同期します)。

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

リモート Codex クライアントは、管理 API 経由で同じ生成されたカタログをフェッチできます (他の `/api/*` ルートと同じアドミッション トークン)。

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_ADMIN_AUTH_TOKEN" \
  "https://proxy.example.com/api/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

応答は生の `opencodex-catalog.json` ドキュメント (プロバイダーの資格情報なし) です。利用可能な場合、`x-opencodex-codex-version` ヘッダーはサーバー上の Codex ランタイム バージョンを報告するため、クライアントはバージョンの偏りを特定できます。

管理 API (`POST /api/custom-models`、`PUT /api/custom-models/<id>` と `displayName` 文字列) および Web ダッシュボードを通じて設定または編集することもできます。 `/` は、配線済みスラグ セパレータと衝突する可能性があるため拒否されます。

表示名は **表示専用であり、再生成しても安定しています**。 `ocx sync` およびカタログが更新されるたびに、`config.json` (`customModels` を含む) からルーティングされたエントリが再取得されるため、設定された名前はルーティングされたスラッグに戻るのではなく、再適用されます。管理対象サービスの再起動でも、プロキシのバインド直後にこの同期が試行されます。オフライン ログイン中など、ベストエフォート型ブート同期が失敗した場合、以前に永続化されたカタログが保持され、次に成功した `ocx sync` が構成された名前を再適用します。本物のアップストリーム ネイティブ名 (例: `gpt-5.6-sol` → "GPT-5.6-Sol") は、固定されたアップストリーム スナップショットから取得され、カスタム表示名によって上書きされることはありません。

### 外部プロバイダーマネージャー

`config.toml` がすでに `openai` または `opencodex` 以外のプロバイダーを選択している場合、OpenCodex はファイルを変更しないままにし、プロファイルの書き込み、カタログ/キャッシュの更新、および即時およびバックグラウンドの両方の Codex 履歴の移行をスキップします。カスタム プロバイダーを管理するツールは、多くの場合、既存のセッションにそのプロバイダー ID をタグ付けします。アクティブな ID を置き換えると、それらの無傷のセッションが Codex の履歴ビューから消える可能性があります。同じ保護が、レガシー ルート プロファイルによって選択された外部プロバイダーにも適用されます。

1 つのツールを Codex プロバイダー設定の所有者として保持します。既存のプロバイダー マネージャーの背後で OpenCodex を使用するには、チャット完了変換ではなく、応答パススルー (Codex TOML では `wire_api = "responses"`) を使用して、そのプロバイダーを `http://127.0.0.1:10100/v1` に指定します。プロキシ API 認証が有効な場合は、上記の非ループバック プロバイダー フォームと一致して、`OPENCODEX_API_AUTH_TOKEN` から `x-opencodex-api-key` も渡します。 OpenCodex にルーティングを直接挿入させるには、まず Codex を組み込みの `openai` プロバイダーに戻し、ユーザー所有のルート `openai_base_url` を削除してから、`ocx start` を再実行します。

### カタログのトラブルシューティング

モデルが Codex にない場合、またはカタログの順序/表示が間違っている場合は、次の順序で確認してください。

1. プロバイダーの **`selectedModels`** — 空でない許可リストは、それらの ID のみを Codex に公開します。
空または省略すると、検出されたすべてのモデルが公開されます。ホワイトリストにない ID はカタログに到達しません。
2. **`disabledModels`** (トップレベル) — カタログと `/v1/models` の両方からモデルを非表示にし、反転します
裸のネイティブ GPT スラッグを `visibility: "hide"` にします。
3. **`liveModels: false` と空の `models`** — ライブ検出がオフで、`models` が空の場合、または
省略すると、opencodex はそのプロバイダーのルーティング モデルを公開しません。
4. **Cursor `GetUsableModels`** — Cursor アダプターはその protobuf を通じてモデルを検出します。
`/models` ではなく `GetUsableModels` RPC であるため、カーソル側の変更により、他のプロバイダーとは独立して表示される ID が変更される可能性があります。
5. **キャッシュと `ocx sync`** - ライブ カタログは約 5 分間キャッシュされます (`modelCacheTtlMs`、
デフォルト `300000`）。 `ocx sync` を実行して新しいフェッチを強制し、カタログをすぐに再書き込みします。
6. **Codex `app-server` の実行** - 有効期間が長い間、ディスク上のカタログを書き換えるだけでは十分ではありません
Codex `app-server` (デスクトップ/CLI バックグラウンド ホスト) は、以前のリストをメモリに保持します。 `ocx sync` および `ocx sync-cache` は、これらのプロセスが検出されると警告します。 `ocx sync --restart-codex` でそれらを再起動し (または、一致する `app-server` プロセスを自分で停止し)、Codex でそれらを再作成すると、新しいリストが表示されます。

:::caution[その他の地元作家]
カタログ書き込み (`opencodex-catalog.json`、`config.toml`) はアトミック **内部** opencodex であり、opencodex が所有する 2 つのライターが競合する場合にのみ、ファイルの書きかけが防止されます。これは、opencodex が書き込まれた後に、別のローカル プロセス、ファイル ウォッチャー、または同期エージェントがカタログの可視性や順序を書き換えることを**阻止するものではありません。 Codex は個別の `models_cache.json` を保持しており、それを個別に更新して、`opencodex-catalog.json` を書き換えることなく表示リストを変更できます。プロキシの実行中にモデルが予期せず反転した場合は、競合するライターを停止または再構成してから、`ocx sync` を実行します。これは外部ライターの危険であり、確認された opencodex の欠陥ではありません。
:::

## プロキシ接続エラー

Codex が再試行して `stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)` のようなエラーで失敗した場合、または Claude Code が同様の接続エラーを報告した場合、opencodex プロキシは実行されていません。設定されたポートで何もリッスンしていないため、クライアントはその生の接続エラー自体を表示します。プロキシを再起動します。

```bash
ocx start              # foreground
ocx service install    # persistent: auto-starts on login and respawns on crash
```

`ocx status` は、プロキシが実行されているかどうかを示し、実行されていない場合は同じ再起動ヒントを出力します。 `ocx doctor` は再起動の安全性 (サービス/シム カバレッジ) を報告します。

## サブエージェントピッカー

カタログ同期により、選択したサブエージェント モデルが Codex で利用できるようになります。ピッカーの順序付けについては [Codex App モデル ピッカー](/guides/codex-app-models/#subagent-selection) を、v1/base/v2 の委任とフォールバック動作については [サブエージェントサーフェス](/guides/sub-agent-surface/) を参照してください。

## Codex アカウントのウォームアップ

ChatGPT アカウントが Codex アカウント プールに追加されると、opencodex は、Codex Response バックエンドへの小さなストリーミング リクエストで永続化する前にそれを検証します。リクエストは実際の応答項目配列 (`input: [{ type: "message", ... }]`) を使用し、`response.completed` を待機し、デフォルトは `gpt-5.4-mini` になります。そのモデルが HTTP 400 を返した場合、`gpt-5.5` で再試行します。構造化されたアップストリーム エラーの詳細は、生の応答本体を公開することなく表示されます。バックグラウンドの再検証は個別に行われ、デフォルトではオフになっています。これは、トークン ガーディアンが有効で、`chatgpt` 更新ポリシーが `proactive` で、`tokenGuardian.codexWarmupEnabled` が true の場合にのみ実行されます。

## ネイティブ Codexの復元

opencodex は決してあなたを罠にはめることはありません。 **`ocx stop` は、ネイティブ Codex に完全に戻す単一のコマンドです**。プロキシを停止し、バックグラウンド サービスがインストールされている場合はそれを停止し、挿入されたすべての行とルーティングされたカタログ エントリを削除するため、プレーンな `codex` は、opencodex が存在しなかったかのように正確に動作します。

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

opencodex が管理対象 [バックグラウンドサービス](/reference/cli/#ocx-service) として実行される場合、`OCX_SERVICE=1` が設定されるため、サービス主導の再起動によって Codex 設定がスラッシングされなくなります。明示的な `ocx stop` / `ocx service stop` のみがネイティブ Codex を復元します。
