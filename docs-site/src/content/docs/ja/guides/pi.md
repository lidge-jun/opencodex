---
title: 円周率
description: Pi からルーティングされたモデルを使用します。ocx エクスポートは、実行中のプロキシに接続された Pi の models.json のカスタム プロバイダー ブロックを書き込みます。
---

Pi は環境変数ではなく単一のグローバル JSON ファイルからプロバイダーを読み取るため、opencodex はそれを起動しません。代わりに、`ocx export` は `opencodex` プロバイダー ブロック (ベース URL、モデル リスト、Pi が補間する環境参照) をシリアル化し、それを独自の設定にマージします。

## クイックスタート

プロキシを開始し、設定を出力します。

```bash
ocx start
ocx export --client pi
```

出力は JSON で始まり、宛先パス、マージ警告、env エクスポート行、および権威コンテキスト制限を持つモデルの数を出力します。

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

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

ここでは 2 つの異なるキーが混同されやすいため、このファイルには最初のキーのみが表示されます。

|キー |それは何ですか |それが住んでいる場所 |
| --- | --- | --- |
|プロキシ アドミッション キー | opencodex 自身の認証情報。ダッシュボードの **API** タブで生成されます。 `apiKey` では `$OPENCODEX_API_KEY` として参照されます。値は環境内に残ります。
|プロバイダーキー | Anthropic / OpenAI / OpenRouter キー | opencodex 独自の設定、[プロバイダー](/guides/providers/) ごと |

エクスポートされた設定には参照のみが含まれ、シークレットは含まれません。 Pi は裸の `$NAME` を補間するため、変数は次のようになります。

```bash
export OPENCODEX_API_KEY=<your key>
```

その名前はパイだけです。 opencode は別の変数 (`OPENCODEX_OPENCODE_API_KEY`、`{env:…}` 形式) を使用します。[オープンコードガイド](/guides/opencode/) を参照してください。

**ループバック プロキシにはキーはまったく必要ありません。** opencodex はデフォルトで `127.0.0.1` をバインドし、そこでは何も認証しないため、`$OPENCODEX_API_KEY` 参照は不活性であり、変数を設定しないままにすることができます。これは、`hostname` がループバックを超えて設定されている場合にのみ問題になります。これは、プロキシがトークンなしでの開始を拒否する場合でもあります。[リモートアクセス](/reference/configuration/#remote-access) を参照してください。

## モデルのメタデータ

`contextWindow` および `maxTokens` は、カタログが権限のあるコンテキスト ウィンドウを報告する場合にのみ発行されます。そうでない場合、そのモデルでは両方のフィールドが省略され、Pi は独自のデフォルトを適用します。 `ocx export` は、そのケースに該当する行数を出力します。

`maxTokens` は、`32000` のスキーマを満たすバジェットであり、コンテキスト ウィンドウに固定されているため、小さなコンテキスト モデルにはコンテキストを超える出力が与えられません。これは、特定のモデルの真の最大値について主張するものではありません。

2 つのフィールドは意図的に省略されています。 `cost` には 4 つの価格フィールドがすべて必要ですが、opencodex にはルーティング モデルの価格データがありません。ゼロを出力すると、すべてのモデルが無料であると主張されます。 `reasoning` は Pi のブール値ですが、カタログにはエフォート ラダーが記載されており、一方をもう一方にマッピングするのは推測になります。

## スキーマのステータス

:::note[実際のインストールに対して未検証]
上の形状は、Pi が公開しているカスタム プロバイダーのドキュメントに従っています。 Pi がインストールされたマシン上の実際の `~/.pi/agent/models.json` に対して検証されていません**。 Pi がエクスポートされたブロックを拒否した場合、不一致は私たちの側にあります。Pi が報告した内容を [問題を開く](https://github.com/lidge-jun/opencodex/issues) してください。
:::

## 要件

実行中の opencodex プロキシ (`ocx start`) と Pi がインストールされている。 `ocx export` はプロキシの管理 API を通じてライブ カタログを読み取るため、空のモデル リストで設定を出力することはできません。
