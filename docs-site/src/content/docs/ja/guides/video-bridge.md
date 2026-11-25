---
title: ビデオブリッジ
description: Grok Imagine Video を使用して非 OpenAI モデルを通じてビデオを生成します。
---

## 概要

Video Bridge を使用すると、opencodex によってルーティングされる非 OpenAI モデルを通じて xAI の Grok Imagine Video 生成を使用できます。有効にすると、合成 `video_gen` ツールが会話に挿入されます。モデルはこれを他の関数ツールと同様に呼び出します。 opencodex は通話をインターセプトし、ビデオ生成ジョブを xAI に送信し、完了するまでポーリングして、結果をダウンロードします。

既定ではジョブは xAI に送信されますが、`images.videoProvider` で互換性のある別のバックエンドを指定できます。

## 前提条件

これらの前提条件は既定の xAI 宛先に適用されます。`images.videoProvider` を設定している場合は、[動画プロバイダーの選択](#動画プロバイダーの選択) を参照してください。

- **API キー**を持つ `xai` プロバイダー エントリ (`ocx login xai` だけでは十分ではありません。ビデオ ブリッジには OAuth ではなくキー認証が必要です)
- ルーティングプロバイダーとしての非 OpenAI モデル (例: Anthropic Claude、Google Gemini)
- opencodex は非 OpenAI プロバイダーを介してルーティングするように構成されています

> **⚠ プロバイダー キーが必要です:** ビデオ ブリッジは、`xai` プロバイダーが使用する場合にのみアクティブになります。
> APIキー認証。これを設定に追加します。
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> プロキシの起動環境に `XAI_API_KEY` を設定し、`${XAI_API_KEY}` と `authMode: "key"` を維持してください。他の端末での export は稼働中のプロキシに届きません。所有する Desktop、サービスまたは前景端末から再起動します。キーをコミットやログに残さないでください。

## 構成

`videoBridgeEnabled: true` を `images` 設定に追加します。

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video-1.5-lite",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

|オプション |デフォルト |説明 |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` |マスタースイッチ。明示的に有効にする必要があります。 |
| `videoBridgeModel` | `"grok-imagine-video-1.5-lite"` | xAI ビデオ モデル ID。 |
| `videoMaxRounds` | `2` |最終回答を強制するまでの最大ビデオ生成ラウンド数。 |
| `videoTimeoutMs` | `300000` (5 分) |ポーリングを含むビデオごとのタイムアウト。 |
| `videoProvider` | 未設定 (xAI) | 独自の `baseUrl` とキーで `video_gen` を処理する API キープロバイダー (任意)。[動画プロバイダーの選択](#動画プロバイダーの選択) を参照してください。 |

## 動画プロバイダーの選択

既定では、ブリッジは `xai` プロバイダーの API キーで `video_gen` ジョブを xAI に送信します。同じ非同期 API (`POST {baseUrl}/videos/generations` の後に `GET {baseUrl}/videos/{id}`) を実装する別のバックエンド (セルフホストのメディアブリッジなど) に送るには、`images.videoProvider` を設定します。

```json
{
  "providers": {
    "my-video-bridge": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "apiKey": "${VIDEO_BRIDGE_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "my-video-bridge",
    "videoBridgeModel": "grok-imagine-video-1.5-lite"
  }
}
```

- 宛先と資格情報には、指定したプロバイダー自身の `baseUrl` と API キーだけを使用します。アダプターは問いませんが、API キー認証が必要です。
- `"videoProvider": "xai"` は、`xai` 行の `baseUrl` にかかわらず固定の `https://api.x.ai/v1` を使用します。その他の組み込みプロバイダー ID は拒否されるため、カスタムプロバイダーを指定してください。
- ループバックまたはプライベートネットワークの `baseUrl` には、他のプロバイダー通信と同様に、そのプロバイダーで `allowPrivateNetwork: true` が必要です。
- OpenCodex が xAI のものと判別できるキー (`xai-` 形式のキー、`xai` 行が持つキー、xAI や Grok の名前を含む環境変数参照) は `https://api.x.ai` または `https://cli-chat-proxy.grok.com` にのみ送信され、それ以外の送信先は拒否されます。これらの特徴がないキーは判別できないため、xAI キーを別のプロバイダー行に貼り付けないでください。別プロバイダーのシークレットを指すキーチェーン参照は常に拒否され、一時停止中のアクティブキーも拒否され、`baseUrl` には認証情報、クエリ、フラグメントを含められません。
- プロバイダーが存在しない、無効、一時停止中、キーなし、または拒否された場合、すべての `video_gen` 呼び出しはそのエラーをモデルに返します。何も送信されず、xAI へのフォールバックもありません。
- xAI プロトコルでは、完成した動画は base64 の `data:` URL または公開 `https:` URL からのみダウンロードされるため、ローカルブリッジは `video.url` としてそのいずれかを返す必要があります。生成したファイルを自身のホストから配信するバックエンドは、代わりに `"videoApi": "openai"` を設定します（[英語ガイドの OpenAI Videos API の節](/guides/video-bridge/#openai-videos-api-backends)を参照）。

## 仕組み

1. opencodex は、`videoBridgeEnabled: true` を使用して非 OpenAI ルーティング モデルを検出します
2. 合成 `video_gen` 関数ツールが会話に挿入されます
3. モデルが `video_gen` を呼び出すと、opencodex が xAI の `/videos/generations` にジョブを送信します (`images.videoProvider` を設定している場合はそのプロバイダー)。
4. ブリッジは 5 ～ 15 秒ごとにジョブ ステータスをポーリングし、ストリームを維持するためにハートビート メッセージを送信します。
5. ビデオの準備ができたら、アーティファクト ディレクトリにダウンロードされます
6. ローカル ファイル パスがツールの結果としてモデルに返されます。

## サポートされているパラメータ

`video_gen` ツールは以下を受け入れます。

|パラメータ |タイプ |範囲 |説明 |
|-----------|------|-------|-------------|
| `prompt` | string | 画像またはフレームがあれば省略可能 | テキストプロンプト |
| `duration` |整数 | 1-15 |動画の長さ (秒) |
| `resolution` | string | `480p`, `720p`, `1080p` | モデルによる。`last_frame`、`keyframes`、`reference_images` 使用時は最大 720p |
| `aspect_ratio` | string | モデルによる | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:2`; `image` のみをアニメーション化する場合は拒否され、元の比率が維持される |
| `image` | string | 最初のフレーム | HTTPS URL、データ URL、または記憶された成果物 |
| `last_frame` | string | 1.5 のみ | 最後のフレーム |
| `keyframes` | array | 1.5、最大 4 | `{image, timestamp_s}`; タイムスタンプはクリップの内部に厳密に収める（`duration` 省略時は 8 s） |
| `reference_images` | array | 1.5: 14、クラシック: 7 (≤ 10 s) | 参照画像。クラシックモデルでは `image` と併用不可 |

モデルが対応できない設定は黙って破棄されず、課金される呼び出しの前に拒否されます。

### モデルと画像入力

| モデル | 解像度 | 入力 | 秒あたり (480p / 720p / 1080p) |
|-------|------------|--------|------------------|
| `grok-imagine-video-1.5` | 480p / 720p / 1080p ネイティブ | 最初と最後のフレーム, 4 キーフレーム, 14 参照画像 (720p 最大) | $0.08 / $0.14 / $0.25 |
| `grok-imagine-video-1.5-lite` (デフォルト) | 480p / 720p / 1080p アップスケール | 最初のフレーム | $0.02 / $0.03 / $0.14 |
| `grok-imagine-video` | 480p / 720p | 最初のフレーム, 7 参照画像 | $0.05 / $0.07 / — |

フレーム指定や参照には `images.videoBridgeModel` を `grok-imagine-video-1.5` に設定します。既知のモデルは9種類、未知のモデルは従来の7種類の比率と480p/720pのみをサポートし、画像入力はありません。HTTPS URLと、デコード後10 MiB以下のPNG/JPEG/WebPデータURLを使用できます。画像ブリッジがダウンロードした画像は、アーティファクトURL、絶対パス、`file:` URLで1時間参照できます。ローカルファイルは読まず、保存された元URLを使います。この参照は固定xAI宛先のみで、カスタム `images.videoProvider` では使えません。インライン結果に元URLはなく、一時URLは早く期限切れになる場合があります。


## 制限事項

- **既定は xAI**: `videoProvider` がない場合、ビデオ生成は xAI の Grok Imagine Video API を使用します。別のバックエンドは同じ非同期 API を実装する必要があります
- **非同期**: ビデオの生成には 30 ～ 120 秒かかります
- **呼び出しごとに 1 つのビデオ**: `video_gen` 呼び出しごとに 1 つのビデオが生成されます
- **イメージ ブリッジと共存**: 両方のブリッジを同時に有効にすることができます
- **Web 検索の優先度**: Web 検索サイドカーがターン中アクティブになっている場合 (`runTurn` アダプター以外)、ビデオ ブリッジはスキップされます。この 2 つは同時に実行できません。 `console.warn` が出力されるため、これをログで検出できます。
- **タイムアウトは送信 + ポーリングをカバーします**: `videoTimeoutMs` 予算はジョブの送信前に開始されるため、送信呼び出し (60 秒) とその後のポーリングは同じ期限を共有します。
