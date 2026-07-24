---
title: コントリビュート
description: opencodex の開発環境、構成、規約、プロバイダーとアダプターの追加方法。
---

## セットアップ

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # 開発モードのプロキシ API
bun run dev:gui      # ダッシュボード dev サーバー(別ターミナル)
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` は引き続き `bun run dev:proxy` のエイリアスとして動作します。ダッシュボード dev サーバーは
`bun run dev:gui` で、`GET /` で提供するパッケージダッシュボードは `bun run build:gui` でビルドして
`gui/dist` に作成します。

## ビルドとテストコマンド

ルートパッケージは Bun ネイティブの TypeScript で、サーバーを別途 compile するステップはありません。リポジトリに
定義されたスクリプトを使えば、ローカル実行と CI を一致させられます。

```bash
bun run typecheck                 # 厳密な TypeScript 検査
bun run test                      # tests/ の全体スイート
bun test tests/router.test.ts     # 特定テストファイル
bun run build:gui                 # Vite GUI ビルド + パッケージ準備
bun run privacy:scan              # CI で使う資格情報/個人情報検査
bun run prepare:package           # パッケージランチャー/asset 更新
```

ほとんどのテストは `tests/*.test.ts` に並んで配置された Bun テストです。共有 fixture は
`tests/helpers/`、範囲の広いネイティブ等価性シナリオは `tests/e2e-style/` にあります。変更した
サブシステムの既存テストの近くに集中した回帰テストを追加してください。共有ルーティング、アダプター、設定、サーバー
動作を触った場合は全体スイートも実行します。

いま読んでいるドキュメントサイトは `docs-site/` にあります(Astro + Starlight)。

```bash
cd docs-site && bun install && bun dev
```

## ドキュメントのデプロイ

公開ドキュメントは GitHub Pages の <https://opencodex.me/ja/> に公開されます。
`.github/workflows/deploy-docs.yml` は `main` push で `docs-site/**` またはワークフロー自体が変わると
実行されます。`docs-site` をビルドした後、生成されたサイトをデプロイします。ドキュメント変更を push する前に以下を
実行してください。

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI とリリース

GitHub Actions は必要な作業のみを行います。

- **Cross-platform CI**(`.github/workflows/ci.yml`)はランタイム、テスト、パッケージ、スクリプト、
  TypeScript、ワークフローファイルが変更された pull request と `main` push で実行されます。Bun matrix は Linux、
  Windows、macOS で install、typecheck、tests、privacy scan、release helper build smoke、GUI build、
  `ocx help` を検査します。別途 3 OS レーンはバンドルランタイムを使い、Bun を別途インストールしなくても
  npm global install が動作するか確認します。
- **Release**(`.github/workflows/release.yml`)は手動で実行します。2 つ目の完全 CI パイプラインではなく、
  dry-run や publish 前に正確なリリースコミット(`GITHUB_SHA`)で Cross-platform CI が
  成功したか確認します。

リリースには helper を使ってください。

```bash
bun run release <version>           # バージョン bump を commit/push、publish ワークフローはデフォルト dry-run
bun run release <version> --publish # CI-gated dry-run を確認した後、実際の publish
bun run release:watch               # 直近の Release ワークフロー run を監視
```

## 規約

- **ES Modules のみ**(`import`/`export`)、TypeScript、`strict` モード。`bun x tsc --noEmit` をクリーンに
  保ってください。
- **ファイルあたり最大約 500 行** — 責任ごとに分割してください。単一の `index.ts` の後に小さく集中したモジュールを置いた
  `web-search/` と `vision/` サイドカーが良い例です。
- **非同期エラーは境界で処理** — サイドカーはリクエストパスにエラーを投げず、適切な marker で
  低下します。
- **Structure SOT** — 現在のメンテナンス不変条件は `structure/` に置きます。公開ユーザーワークフローは
  `docs-site/`、過去の調査/診断記録は `docs/` に置きます。
- **export の保存** — 他のモジュールが依存している可能性があります。

## カタログにプロバイダーを追加

すべてのプロバイダー選択肢と seed は canonical レジストリ(`src/providers/registry.ts`)から派生します。

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` はこのエントリを `ocx init`、`ocx provider`、ダッシュボード preset、API キーログイン、
OAuth 設定 seed に供給します。`enrichProviderFromCatalog()` はモデルメタデータと capability 分類を
保存するプロバイダー設定にコピーします。OAuth プロトコル実装は引き続き `src/oauth/` にあります。
レジストリメタデータを追加するだけでは OAuth flow は生まれません。

## アダプターを追加

`src/adapters/` に `ProviderAdapter`([アダプター](/ja/reference/adapters/)参照)を実装し、
`src/server/adapter-resolve.ts` に名前を登録した後、出力を内部 `AdapterEvent` にブリッジしてください。画像
処理には `image.ts` を再利用し、一般的なストリーミング/ツール呼び出しは `openai-chat.ts` を参考にしてください。
アダプターが送信再試行を自ら担う場合のみ `fetchResponse` を使い、Cursor のような実際の双方向転送には
`runTurn` を使ってください。`tests/` の下に集中したテストを追加し、公開パッケージ API に含まれる
factory の場合は `src/index.ts` からも export してください。

## 完了を主張する前に検証

変更を証明する最も狭いコマンドから実行してください。型は `bun run typecheck`、動作は集中した
`bun test tests/<name>.test.ts` またはランタイム probe で確認した後、影響範囲に応じた広い gate を
実行します。opencodex は大きな batch より小さく検証可能な commit を好みます。
