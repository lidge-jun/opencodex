---
title: Cursor Private Inference
description: 公開トンネルを使わずに、macOS、Windows、Linux の Cursor ローカルエージェント版から opencodex 経由のモデルを使います。
---

通常の Cursor は自分のマシン上のプロキシへ接続できません。「Override OpenAI
Base URL」を設定すると、Cursor のバックエンドがプロンプトを組み立て、Cursor のサーバーからその URL を呼び出します。ループバック、LAN、プライベートアドレスは拒否されます。このため Cursor とローカルモデルを組み合わせるコミュニティの手順には、ngrok、Cloudflare Tunnel、VPS のいずれかが登場します。

Cursor はもう一つ、エージェントのループをローカルで実行し、設定した OpenAI 互換ゲートウェイを呼び出す **Cursor Private Inference** というデスクトップビルドも提供しています。opencodex に向ければ、トンネル、アプリの改変、TLS なしでルーティング済みモデルを利用できます。このページはそのビルドについて説明します。

## 始める前に

見落とされがちな条件なので、まずこのセクションを読んでください。

- **opencodex はこのビルドを配布していません。** Cursor も文書化していません。cursor.com からリンクされておらず、予告なく変更されたり利用できなくなったりする可能性があります。既に持っていない場合、このガイドは適用されません。代わりに公開 HTTPS エンドポイントでコミュニティの [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) ブリッジを使ってください。
- **Cursor へのサインインは引き続き必要です。** ログイン画面がゲートウェイのダイアログより先に表示されます。
- **Cursor 自身のモデルは利用できません。** ローカルモードのピッカーにはゲートウェイが返すものだけが表示されます。Tab 補完、Cursor のカタログ（Composer、Auto）、Cloud Agents はオフです。ただし、そのプロバイダーを設定していれば、opencodex 自身の `cursor/*` 経路から Cursor プロバイダーのモデルへ接続できます。
- **各ターンには Cursor のローカルシステムプロンプトが含まれます。** 2 ターン目以降では約 23,000 トークンです。モデル選択時にこれを見込んでください。
- **通常の Cursor と同じ識別子を共有します。** バンドル ID、`~/.cursor`、macOS の `Application Support/Cursor`、Windows の `%APPDATA%\Cursor`、Linux の `~/.config/Cursor` が同じです。両者を分けるには `--user-data-dir <dir>` を付けて起動します。設定をコピーしたい場合を除き、初回起動時の「Import data from existing Cursor installation」はオフのままにしてください。

## インストール済みビルドを識別する

どちらも Dock では「Cursor」という名前で、バンドル ID も共有するため、`product.json` を確認します。

| プラットフォーム | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json` (AppImage は先に展開が必要) |

ローカルエージェント版の `nameLong` は `"Cursor Private Inference"`、通常版では `"Cursor"` です。`version` はビルド番号です（執筆時は 3.18.25）。ダッシュボードの Integrations > Cursor カードも同じ確認を行い、見つかったビルドを一覧表示します。ローカルモードは `product.json` ではなく workbench バンドル内で切り替えられているため、有効化するフラグはありません。`nameLong` が通常の Cursor を示す場合、そのインストールではループバックゲートウェイへ接続できません。

ゲートウェイと通信するエージェントループは、同じインストールルートの `extensions/cursor-agent-exec/dist/main.js` にあります。opencodex は Cursor の推論強度テーブルを把握するため、このファイルを読み取り専用かつ範囲を限定して読みます。「モデルと推論強度」を参照してください。

## ゲートウェイを設定する

opencodex を起動しておく必要があります（`ocx service status`）。次のどちらの方法でも同じ設定になります。

**アプリ内で設定する場合。** Settings → Models → Gateway → Configure gateway を開きます。

| フィールド | 値 |
|---|---|
| Base URL | `http://127.0.0.1:10100/v1` (`/v1` を含めます。ループバックの通常の `http://` が許可されます) |
| API Key | サービスで API 認証を使う場合は `OPENCODEX_API_AUTH_TOKEN` の値。それ以外は `opencodex-loopback` など任意の仮の値 |

**Refresh model list** をクリックします。ピッカーに opencodex の `/v1/models` が表示されるので、使いたい行をオンにします。

**環境変数で設定する場合。** アプリは起動時に次を読みます。

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, newline-separated "Header-Name: value" lines
```

`CURSOR_LOCAL_AGENT_HEADERS` は `User-Agent` と、解決されない `{...}` プレースホルダーを拒否します。`{gitOrgRepo}` と `{gitBranch}` は展開されます。

優先順位は高い順に、モデルごとの資格情報 → Settings に保存したゲートウェイ → `CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（互換性用の代替）です。環境変数は保存済みゲートウェイを上書きしません。環境変数で切り替える場合は先に Settings で保存値を消してください。

Cursor Private Inference は GUI アプリなので、対話シェルのプロファイルだけでは足りません。アプリを起動するプロセスの環境に変数を設定する必要があります。

| OS | 設定する場所 |
|---|---|
| macOS | 現在のログインセッションでは `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`。永続化には `EnvironmentVariables` を設定した LaunchAgent。ターミナルからアプリを起動する方法もあります。 |
| Windows | `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`（ユーザー範囲。新しいプロセスに適用）、または System Properties → Environment Variables。設定後にアプリを再起動します。 |
| Linux | ディスプレイマネージャーのセッションでは `~/.profile` または `~/.pam_environment`。デスクトップがユーザーの systemd セッションで動く場合は `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1`。ターミナルから起動した AppImage はそのシェルの環境を引き継ぎます。 |

このビルドは macOS（arm64、x64、universal）、Windows（x64、arm64）、Linux（x64、arm64）向けに存在します。設定方法は共通です。

## ダッシュボードから確認する

opencodex のダッシュボードには Integrations の下に **Cursor** タブ（`/#integrations/cursor`）があります。Cursor に対しては読み取り専用で、Cursor の設定データベース、キーチェーン項目、アプリバンドルを書き換えません。そのため切り替えるスイッチはありません。代わりに必要な値を示し、接続できたかを表示します。

- **インストール済みビルド。** Cursor Private Inference（パスとバージョン）と通常の Cursor（パスのみ）が存在するかを表示します。通常版だけが見つかった場合、タブは Cursor 自身のアップデートチャネル（`api2.cursor.sh` の `cursor-local` チャネル）に、このプラットフォームと CPU 向けに案内されている local-mode インストーラーを問い合わせ、そのバージョンと `downloads.cursor.com/local-mode/` のインストーラーへのリンクを表示したうえで、このページへリンクします。opencodex はリンクを表示するだけで、ダウンロード・起動・インストールは一切行いません。応答は 30 分間（失敗時は 5 分間）キャッシュされます。チャネルに接続できない場合、使えない応答が返った場合、またはこのコンピューター向けのビルドを Cursor が提供していない場合（Windows・macOS・Linux の x64 と arm64 のみ提供）は、インストーラーを特定できなかったと表示します。下のゲートウェイ値はどちらの場合も有効です。通常版の Cursor 自体は引き続きカスタムエンドポイントを Cursor のサーバー経由で呼び出すため、ループバックプロキシには届きません。
- **ゲートウェイの値。** プロキシ自身の待ち受けポートを使った Base URL を Copy ボタンと共に表示します。値は実行時の記録から取得するため、リバースプロキシ越しのダッシュボードでも、このマシン上の Cursor が接続できるポートが示されます。API Key の行はバインド設定によって変わります。資格情報が不要なら `opencodex-loopback` と Copy が表示され、API 認証が有効、または opencodex API キーが一つでも設定されていれば、自分のキーを使うよう案内して API Keys タブへリンクします。`OPENCODEX_API_AUTH_TOKEN` に限らず、設定済みのキーなら使用できます。
- **接続状態。** User-Agent が正確に `Cursor/<version>` である最後の `/v1/models` リクエストの時刻とバージョンを表示します。これは Cursor のローカルエージェント実行環境が送るヘッダーです。Cursor がプロキシを呼び出すまでは「never seen」と表示されます。Cursor で **Refresh model list** を押すと状態が変わります。タブを開いている間、カードは 15 秒ごとに更新されます。
- **Cursor に表示される内容。** opencodex が公開するモデルの Model / Reasoning / Context 表を表示します。無効なモデルとプロバイダーの許可リストが適用され、生の一覧と同じ条件です。次節の規則に沿った予測であり、Reasoning の段階は Cursor 自身のテーブルから選ばれます。

## モデルと推論強度

ピッカーは opencodex の生の `/v1/models` 一覧です。モデル行に **Reasoning** コントロールが付くかは二つの条件で決まります。

1. opencodex がその行で機能を公開する必要があります（`api_types` と `capabilities` オブジェクト）。v2.41 以降では公開します。古いプロキシではモデルは表示されても強度コントロールは出ません。
2. モデル ID の最後の `/` より前と `@…` 接尾辞を取り除いた部分が、Cursor 自身の強度テーブルと一致する必要があります。このテーブルはアプリの `extensions/cursor-agent-exec/dist/main.js` に組み込まれています。opencodex は検出したインストールから読み取り、Cursor の更新に合わせてダッシュボードの予測を変えます。カードには読み取ったビルド、または検出されなかった場合は「static mirror」と表示されます。段階を決めるのは Cursor であり、`/v1/models` のフィールドでテーブルにモデルを追加することはできません。次は静的ミラーが保持する 3.18.25 時点の一覧です。

| モデル ID（最後の `/` より後） | Cursor が表示する段階 | 通信フィールド |
|---|---|---|
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Low, Medium, High, Extra High（推論強度） | `reasoning.effort` |
| `gpt-5`, `gpt-5.x` | Low, Medium, High, Extra High（推論強度） | `reasoning.effort` |
| `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7`, `claude-opus-4.8` | Low, Medium, High, Extra High, Max（推論強度） | `output_config.effort` |
| `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` | Low, Medium, High, Max（推論強度） | `output_config.effort` |
| `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-latest` | Minimal, Low, Medium, High, Extra High（推論強度） | `reasoning_effort` |
| `gemini-*` (`supports_reasoning` が必要) | Minimal, Low, Medium, High（推論強度） | `reasoning_effort` |
| その他（`claude-fable-5-1`、`kimi-k3` など） | コントロールなし | — |

したがって `anthropic/claude-opus-5` は動作しますが、opencodex の GPT-5.6 用 `max` / `ultra` 段階はこのピッカーから選べません。

### コントロールがないモデル

`anthropic/claude-fable-5-1`、`cursor/kimi-k3` などテーブル外のモデルには Reasoning コントロールが付きません。ゲートウェイが `supports_reasoning` を公開すると、Cursor はその ID ごとに「Local provider advertises reasoning support for a model with no hardcoded Bottlerocket effort family」というログを 1 行出します。それでも強度を選ぶ方法は二つあります。

- **強度別の行**（opencodex 設定の `cursorEffortRows: true`、既定ではオフ）: ゲートウェイがテーブル外のモデルについて、`anthropic/claude-fable-5-1--high` や `cursor/kimi-k3--max` のように強度ごとのピッカー項目を公開し、それぞれを指定強度でベースモデルへルーティングします。Cursor が既に強度を表示するモデルに追加行は作られず、既知の正確なモデル ID は常に `--<effort>` 接尾辞より優先されます。有効化後に Refresh model list を押してください。ダッシュボードのカードにはモデルごとの公開行数が表示されます。行の選択は明示的な指定なので、リクエスト内の `ocx-effort` 指示より優先されます。
- **固定の既定値**（プロバイダーの `modelDefaultReasoningEfforts`）: Cursor が強度を送らない場合に適用されます。

### 「Max」の二つの意味

通常の Cursor は一部モデルの横に **Max** トグルを表示します。これは推論強度ではなく、コンテキストウィンドウを広げる Max Mode です。ローカルエージェント版では同じ考え方がモデルメニューの **Context** 項目に現れます。opencodex はネイティブ GPT-5.6 系列で **272K**（既定）または **922K**（1M のオプトインで、コスト増を示す表示付き）を有効にします。選んだ値がそのターンのコンテキスト上限になります。ルーティングされたモデルは一つのウィンドウだけを表示し、Context 項目はありません。プロバイダーのコンテキスト上限が 922K 未満なら、ネイティブモデルの項目も消えます。

推論強度の **Max**（opencodex の `max` / `ultra`）は別の意味で、このピッカーからは選べません。Cursor はゲートウェイではなく自身のテーブルから強度段階を取得し、GPT-5.6 の項目は Extra High で止まるためです。

opencodex が `api_types` で `responses` を公開するため、このビルドはエージェントのターンを `/v1/chat/completions` ではなく、`reasoning.effort` 付きの `/v1/responses` に送ります。

この通信方式の選択は Claude の行にも影響します。Cursor が Claude の強度を送るのは Anthropic Messages 通信の `output_config.effort` だけです。このため `/v1` Base URL では、コントロールが表示される Claude の行もプロバイダーの既定強度で実行されます。Base URL を `/messages` で終わらせると逆になり、Claude の強度は送られますが OpenAI 系列の強度は落ちます。一つのゲートウェイ設定で両系列を扱うことはできません。上記の強度別の行では opencodex 自身が強度を適用するため、この制約を回避できます。

## 検証

`ocx observe logs` では、ターンが `inboundProtocol: responses` および `admissionKind: loopback` と表示されます。

| 症状 | 確認事項 |
|---|---|
| ゲートウェイから 401 | API Key が `OPENCODEX_API_AUTH_TOKEN` と一致していません。API 認証なしのループバックバインドなら任意の値を使えます |
| ピッカーが空 | opencodex が動いていないか、Base URL に `/v1` がありません。修正後に Refresh model list を押します |
| モデルはあるが Reasoning コントロールがない | opencodex が v2.41 より古いか、ID が Cursor のテーブルにありません（ダッシュボードでは — と表示）。`cursorEffortRows` をオンにするかプロバイダーの既定値を設定します |
| スキーマ変更が反映されない | Cursor は Base URL の文字列ごとに `/models` を期限なしでキャッシュします。Refresh model list で再読込するか、アプリを再起動するか、URL の別表記（`localhost` と `127.0.0.1`）を一時保存します |
| 初回ターンで 23,000 トークン | 予想どおりです。Cursor のローカルシステムプロンプトによるものです |
