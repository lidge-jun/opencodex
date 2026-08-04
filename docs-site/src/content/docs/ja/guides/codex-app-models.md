---
title: Codex App モデル ピッカー
description: opencodex モデルが、共有 Codex カタログを通じて Codex App、Codex CLI、Codex TUI にどのように表示されるか。
---

opencodex は Codex アプリにパッチを適用しません。 Codex CLI/TUI が既に使用しているのと同じ Codex 設定とモデル カタログを書き込みます。 Codex アプリはその共有状態を読み取るため、ルーティングされたモデルは通常の Codex カタログ エントリとしてアプリのモデル ピッカーに表示されます。

OpenAI エントリには、ネイティブ Codex ログインと、名前空間付きの `openai-apikey/<model>` API キーという 2 つの資格情報ルートがあります。`codexAccountMode` だけを Pool と Direct の間で変更しても、ピッカー ID は変わりません。`codexAccountPickerEnabled` が `false` ではなく、`codexAccountNamespaces` に対象アカウントが存在する selector がある場合、opencodex は対応するアカウントごとに `<selector>/<native-openai-model>` 行を追加し、ピッカーでは bare native 行を非表示にします。`false` は生成 row だけを非表示にし、設定済みの exact selector route は引き続き利用でき、対象が利用できなければ別のアカウントへ切り替えず失敗します。Selector 名はユーザーが決める公開ラベルであり、組み込みのアカウント role の意味はありません。`selector` 付きの行を選択すると、対応付けられたアカウントだけが使用され、アクティブな Pool アカウントは変更されません。詳しくは [Codex アカウントの明示的な selector](/reference/configuration/routing/#exact-codex-account-selectors) を参照してください。API GPT-5.6 エントリは 1,050,000 コンテキスト / 922,000 最大入力を使用し、`*-pro` ピッカー ID は `reasoning.mode: "pro"` のベース ワイヤ モデルに解決されますが、ログ、使用状況、およびピッカー状態は仮想 ID を保持します。 API カタログは、`gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna、およびそれらの 3 つの Pro 仮想 ID の 8 つの ID に固定されています。汎用の `gpt-5.6-pro` エイリアスはありません。コンパクト リクエストは、選択された層を保持しますが、推論オブジェクトなしで基本モデルを送信します。

ピッカー ID で資格情報ルートを明示的に選択します。Pool/Direct は Providers ページで変更します。以下の `<selector>` は、`codexAccountNamespaces` で対応付けたユーザー定義の公開ラベルです。

```text
gpt-5.6-sol                         # Pool または Direct による bare Codex ログイン ルート
<selector>/gpt-5.6-sol              # その selector に対応付けられた保存済み Codex アカウント
openai-apikey/gpt-5.6-sol           # API key
```

新規インストールと保存モードのない設定は、デフォルトでプールになります。現在の設定はマーカー 2 を使用し、出荷された v1 ソースを `~/.opencodex/config.json.pre-openai-tiers-v2.bak` に保持します。次のようにして復元します。

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

以前の v1 の 3 プロバイダー設定は、単一のオプション対応行に自動的に移行されます。

## 統合パス

`ocx init`、`ocx start`、および `ocx sync` は、共有 Codex 設定とカタログをプロキシに接続します。設定の挿入、カタログの同期、シム、WebSocket フォールバック、および復元の仕組みについては、[Codexの統合](/guides/codex-integration/) を参照してください。

## 配線されたモデルが表示される理由

Codex のモデル ピッカーは、Codex の形をしたカタログ エントリを想定しています。 opencodex は、ネイティブ Codex モデル テンプレートを複製し、ルーティングされたモデル ID を置き換えることによって、ルーティングされたエントリを構築します。

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

クローンは、推論レベル、シェル タイプ、API サポート フラグ、基本命令などの厳密なパーサー フィールドを保持します。次に、opencodex は、OpenAI サービス層メタデータなど、ルートが尊重できないネイティブのみの機能を削除します。

## 現在の安定したモデルの範囲

ネイティブ フォールバック セットには、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex-spark`、および GPT-5.6 Sol/Terra/Luna が含まれます。 GPT-5.5/5.4 ファミリの場合、opencodex は、インストールされている Codex カタログの豊富なライブ エントリを保存し、欠落しているエントリのみを合成します。バンドルされたアップストリーム スナップショットは GPT-5.6 でのみ使用され、古いテンプレートの近似値の代わりに実際のモデルごとの ID とメタデータが提供されます。

|ルート |ピッカー ID とカタログのメタデータ |
| --- | --- |
| Codex ログイン (picker 非表示または有効な account selector なし) | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` などの bare native id を表示し、`codexAccountMode` に従って Pool または Direct を使用します。GPT-5.6 行のカタログ ウィンドウは 372,000 トークンです。非表示中も設定済み exact selector route は呼び出せます。 |
| Codex ログイン (picker 表示が有効で account selector あり) | 有効な selector とサポート対象 native model の各組み合わせに `<selector>/<native-openai-model>` 行を表示します。各行は対応付けられたアカウントだけを使用し、bare native 行はピッカーで非表示になります。Native metadata と context window は保持されます。 |
| OpenAI (API キー) |正確に 8 つの名前空間行: `gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna、および 3 つの `*-pro` 仮想 ID (コンテキスト 1,050,000、8 つすべての最大入力 922,000) |
|オープンルーター | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna` (1,050,000) |
|カーソル |静的フォールバックには、`cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、および `cursor/gpt-5.6-luna` (1,000,000)、さらに `cursor/grok-4.5` および `cursor/grok-4.5-fast` (500,000) が含まれます。ライブアカウントの検出により、どれが表示されたままになるかが決まります。 |
|かおるライブディスカバリーには信頼性があります。フォールバック カタログのデフォルトは、500,000 トークン ウィンドウと `low` / `medium` / `high` 推論制御を備えた `xai/grok-4.5` です。 |

固定された GPT-5.6 エントリは、正確な上流ラダーを保存します。 Sol と Terra は `low` から `ultra` を公開します。ルナは`max`で止まります。 Sol のデフォルトは `low`、Terra と Luna のデフォルトは `medium` です。 `ultra` は、最大限の推論とプロアクティブな委任を目的としたクライアント向けの選択肢であり、`max` としてバックエンドに到達します。ピッカーのエントリは、カタログの準備ができていることを意味するだけです。接続されたアカウントまたは API キーには、そのモデルを使用する資格がまだある必要があります。

## ネイティブモデルとルーティングモデルの切り替え

ダッシュボードの Models ページでは、bare native id と routed `provider/model` id の
`disabledModels` を切り替えられます。Account-qualified
`<selector>/<native-openai-model>` id も `disabledModels` でサポートされますが、ダッシュボードには
exact selector 行が表示されず、切り替えることもできません。この id は設定に直接追加してください。

- Routed provider id は名前空間付き (`provider/model`) です。無効にすると、同期済みカタログと
  `/v1/models` から除外されます。
- Account-qualified native id は `<selector>/<native-openai-model>` 形式です。この id を
  `disabledModels` に設定すると、その selector 行だけが非表示になります。
- Bare native GPT id は bare slug です。無効にすると、後で再び有効化できるようカタログ
  エントリを保持したまま、bare 行とそのモデルの全 account-selector 複製行を非表示にします。
- ネイティブ行はサポートされている静的セットから取得されるため、無効になったネイティブ モデルは引き続き表示されます。
ダッシュボードに戻り、再びオンにすることができます。

可視性パスはスナップショットのアップグレード後に実行され、管理 API はカタログを更新し、切り替え後に Codex のモデル キャッシュを強制的に無効にします。

## マルチエージェントサーフェスモード

モデル ページ v1/base/v2 コントロールは、各ピッカー エントリが使用する Codex コラボレーション サーフェスを変更します。正規モード、委任、継承、フォールバック、および暗号化されたタスクの動作については、[サブエージェントサーフェス](/guides/sub-agent-surface/) を参照してください。

## 上位層の推論

推論層の可視性は、v1/base/v2 サーフェス モードから独立しています。生成された推論可能なエントリは `max` をアドバタイズするため、サブエージェントの直接の作業が検証をオーバーライドします。現在生成されているルーテッド エントリと古いネイティブ GPT エントリも `ultra` をアドバタイズします。上流の GPT-5.6 ラダーは正確に保存されているため、Luna には `max` がありますが、`ultra` はありません。

回線上では、ルーティングされたアダプターがサポートされていない層をマップまたはクランプします。実際のラダーが `xhigh` で停止する古いネイティブ モデルの場合、`nativeEffortClamp` は直接 `max` または `ultra` 選択を `xhigh` にマップします (GPT-5.5 など)。ソル、テラ、ルナは本物の `max` ラングを持っています。

## 高速層のルール

Codex は高速モードを次のように保存します。

```toml
service_tier = "fast"

[features]
fast_mode = true
```

ただし、モデル カタログとランタイム リクエスト層 ID は `priority` を使用します。opencodex はその分割を保持します。ネイティブ OpenAI パススルー モデルは高速サポートを維持します。ルーティングされたプロバイダーはケイパビリティでゲートされ、`supportsServiceTier: false` と宣言された場合のみ `service_tier` が削除されます (レジストリは正規 OpenAI を `true`、DeepSeek と Volcengine Ark を `false` に分類します)。未分類のカスタム ゲートウェイは呼び出し元の値をそのまま保持し、注入もされません。そのため、受け入れられない場所で高速オプションがアドバタイズされることはなく、カスタム ゲートウェイは `true` で明示的にオプトインできます。

## サブエージェントの選択

Codex は、ピッカーに表示されるカタログ エントリを `priority` の昇順で並べ替え、最初の 5 つを `spawn_agent` モデル オーバーライドとしてアドバタイズします。ダッシュボードの Subagents ページでは、bare native id または routed `provider/model` id を最大 5 つ選択して保存できます。手動で設定した `subagentModels` は account-qualified `<selector>/<native-openai-model>` id も受け付けますが、ダッシュボードにはこれらの exact id が表示されません。ページを保存すると、リストはダッシュボードに表示される選択肢で置き換えられます。opencodex は選択順に低いカタログ priority を割り当てます。account selector が有効な場合、bare native の選択は selector-qualified グループに展開されます。他のモデルは引き続き正確な ID で呼び出すことができます。

注目モデルのリストは、ダッシュボードの **サブエージェント委任** の選択とは別のものです。 Codex が提供するものを最初にオーバーライドするものを制御します。モデルを選択したり、委任をトリガーしたりすることはありません。

## モデルの状態を更新しています

ピッカーに古いエントリがまだ表示されている場合は、カタログを更新し、ターゲットの Codex サーフェスを再起動します。

```bash
ocx sync
```

opencodex は、カタログの可視性、優先度、またはメタデータが変更されるたびに、意図的に古いキャッシュ ラッパーで `models_cache.json` を書き換えるため、次回の Codex モデルの更新で新しいカタログが読み取られます。
