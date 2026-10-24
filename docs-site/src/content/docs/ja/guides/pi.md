---
title: 円周率
description: Pi からルーティングされたモデルを使用します。ocx エクスポートは、実行中のプロキシに接続された Pi の models.json のカスタム プロバイダー ブロックを書き込みます。
---

Pi は単一のグローバル JSON ファイルからプロバイダーを読み込みます。opencodex は Pi を起動せず、`ocx export` でベース URL、モデル一覧、秘密ではないローカルキーのプレースホルダーを含む `opencodex` プロバイダーブロックを出力します。そのブロックを既存の設定にマージしてください。

## クイックスタート

プロキシを開始し、設定を出力します。

```bash
ocx start
```

このプロセスを実行したまま、別のターミナルで設定を表示します。

```bash
ocx export --client pi
```

JSON に続いて、保存先、マージに関する警告、ループバックでの使用方法、確定したコンテキスト上限を持つモデル数が表示されます。このエクスポートは認証不要のループバックプロキシ専用で、リモートアクセスの認証は設定しません。

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

生成される Pi プロバイダーでは `compat.sendSessionAffinityHeaders` が有効です。設定をマージしたり手動で編集したりする際も、このフラグを保持してください。Pi が送る安定したセッション識別子から、OpenCodex が正規の OpenCode Go 接続先用の affinity を生成します。`cacheRetention` が `none` の場合、Pi は識別子を送信しないことがあります。

生成される Pi プロバイダーでは `compat.supportsDeveloperRole` も `false` に設定され、Pi はシステムプロンプトを `developer` ではなく `system` ロールで送ります。OpenCodex は Chat Completions のロールを受け取ったまま転送しますが、OpenAI 互換のアップストリームの中には `developer` を 400 で拒否するものがあります。`system` はすべてのアップストリームが受け付けます。

モデル ID はプロキシの正規セレクターであるため、ルーティングされたモデルは `provider/model` (`anthropic/claude-opus-5`) として表示され、ネイティブ OpenAI スラグはプレフィックスなし (`gpt-5.6-sol`) のままになります。 `name` サフィックス (`(anthropic)`、`(native)`、`(routed)`) により、異なるアップストリームの 2 つの同じ名前のモデルが Pi のピッカーで区別できるようになります。

## どこへ行くのか

Pi のグローバル モデル設定は次のとおりです。

```text
~/.pi/agent/models.json
```

:::caution[マージし、決して置き換えないでください]
`ocx export` はそのファイルを書き込むことはありません。 `providers.opencodex` ブロックをそれにマージします。ファイルを置き換えると、そこで構成した他のプロバイダーはすべて破棄されます。 `--out` はスクラッチ パスに存在し、`--force` なしで既存のファイルを上書きすることを拒否します。

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

エクスポートされたブロックは静的なスナップショットであり、ライブ ビューではありません。プロバイダーを追加するかモデルの可視性を変更した後、`ocx export` を再実行し、新しいブロックを古いブロックにマージします。

## アドミッションキー

出力される `apiKey` は秘密ではないプレースホルダー `opencodex-loopback` です。キー用の環境変数をエクスポートする必要はありません。エクスポーターは認証不要のループバックプロキシだけを許可し、リモートまたはトークンで保護されたプロキシを拒否します。プロバイダーの認証情報は [プロバイダー](/ja/guides/providers/) に示す opencodex の設定内に保持されます。Pi のこのブロックに上流プロバイダーのキーを入れないでください。リモート接続にはプロキシへのアクセス認証に対応した別の連携を使ってください。プレースホルダーを変えても Pi のリモートエクスポートは有効になりません。

## モデルのメタデータ

`contextWindow` および `maxTokens` は、カタログが権限のあるコンテキスト ウィンドウを報告する場合にのみ発行されます。そうでない場合、そのモデルでは両方のフィールドが省略され、Pi は独自のデフォルトを適用します。 `ocx export` は、そのケースに該当する行数を出力します。

出力上限にはカタログまたは生成メタデータの既知のモデル上限を使用します。不明な場合のみ `32000` を使用します。出力上限は常にコンテキストウィンドウ以下に制限され、`32000` 未満の既知の上限も維持されます。

2 つのフィールドは意図的に省略されています。 `cost` には 4 つの価格フィールドがすべて必要ですが、opencodex にはルーティング モデルの価格データがありません。ゼロを出力すると、すべてのモデルが無料であると主張されます。 `reasoning` は Pi のブール値ですが、カタログにはエフォート ラダーが記載されており、一方をもう一方にマッピングするのは推測になります。

## スキーマのステータス

:::note[実際のインストールに対して未検証]
上の形状は、Pi が公開しているカスタム プロバイダーのドキュメントに従っています。 Pi がインストールされたマシン上の実際の `~/.pi/agent/models.json` に対して検証されていません**。 Pi がエクスポートされたブロックを拒否した場合、不一致は私たちの側にあります。Pi が報告した内容を [問題を開く](https://github.com/lidge-jun/opencodex/issues) してください。
:::

## 要件

実行中の opencodex プロキシ (`ocx start`) と Pi がインストールされている。 `ocx export` はプロキシの管理 API を通じてライブ カタログを読み取るため、空のモデル リストで設定を出力することはできません。
