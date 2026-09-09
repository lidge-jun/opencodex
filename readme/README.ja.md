<h3 align="center">make codex open!</h3>
<p align="center"><b>OpenAI Codex、Claude Code、Claude Desktop、Grok Build のための汎用プロバイダープロキシ</b><br>
コマンド 2 つで、そのすべてが好きな LLM で動きます。</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="X で @claudeebum をフォロー"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="license"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="node version">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code、どんなモデルでも

ピッカーは Claude Code のままです。その裏で動く頭脳だけが違います。

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="opencodex でルーティングされたモデルを動かす Claude Code — ステータスバーに gpt-5.6-luna-medium がアクティブモデルとして表示される" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex、どんなモデルでも

プロバイダーを選ぶだけです — 同じワークフロー、違う頭脳。

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="opencodex のデモ — Codex アプリで OpenAI 以外のルーティングモデルを使ってタスクを実行" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop、どんなモデルでも

Opus が答えてから、タスクを GPT-5.6 Sol のサブエージェントに渡します。

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop が Claude Opus 4.8 として応答し、opencodex 経由で GPT-5.6 Sol のサブエージェントを起動する" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build、どんなモデルでも

Sol がセッションを進め、Kimi K3 のサブエージェントを呼び出します。

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="Grok Build が opencodex 経由で GPT-5.6 Sol を動かし、Kimi K3 のサブエージェントを呼び出す" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <b>日本語</b> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://opencodex.me/ja/"><b>完全なドキュメント →</b></a>
</p>

opencodex は、Codex の Responses API をプロバイダーが話すプロトコルへ変換する軽量なローカルプロキシ
です。ストリーミング、ツール呼び出し、reasoning トークン、画像を双方向で扱います。Claude、Gemini、
Grok、GLM、DeepSeek、Kimi、Qwen、Ollama をはじめとするどの LLM でも、Codex、Claude Code、Claude
Desktop、Grok Build から使えます。Codex 認証用の **ChatGPT アカウントプール**も管理できます。アカウント
を追加し、ダッシュボードでクォータを更新すれば、新しいセッションは使用量が最も少ない健全なアカウント
へ自動的に振り分けられ、既存のスレッドは開始したアカウントに固定されたままになります。

## クイックスタート

### 個人向けインストール

```bash
npm install -g @bitkyc08/opencodex   # Node 18 以上。Bun ランタイムは自動で同梱されます
ocx start                         # プロキシとダッシュボードが localhost:10100 で起動
```

バックグラウンドで動かすなら `ocx service` を使ってください。

**http://localhost:10100** を開き、Web ダッシュボードですべて設定します。プロバイダーの追加（40 以上の
組み込み、または任意の OpenAI 互換エンドポイント）、モデルの選択、アカウントの管理はここで行います。
`ocx gui` でいつでもダッシュボードを開き直せます。
Codex 認証用の **ChatGPT アカウントプール**も管理できます。ChatGPT / Codex のアカウントを複数追加し、
5 時間 / 週間 / 30 日のクォータをダッシュボードで更新します。クォータルーティングでは、新しいセッション
が使用量の最も少ない健全なアカウントを使えます。ラウンドロビンと fill-first はそれぞれの方針に従います。
既存の Codex スレッドは通常、開始したアカウントとの affinity を保つので、長い SSH・tmux・モバイル接続
のセッションが会話の途中でアカウントを乗り換えることはありません。ただしクォータの再評価、failover、
アカウントの除外、affinity の失効、401/403 や 429 からの復帰では再バインドされることがあります。ふだん
は使わず他が尽きたときだけ回したいアカウント（多くは Codex Desktop のログイン）があるなら、アカウント
に選択順を指定してください。

### スポンサー

アップストリームのプロトコルが変わるたびに opencodex を追随させているのはスポンサーの支援です。
興味があれば [SPONSORS.md](../SPONSORS.md) をご覧ください。

<!-- sponsors:main — one banner, model developers only; empty until a Main sponsor signs -->

<!-- sponsors:standard — one row per sponsor, in order of signing -->
<table>
<tbody>
<tr>
<td width="180"><a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme"><img src="../assets/sponsors/orcarouter.png" alt="OrcaRouter" width="150"></a></td>
<td>このプロジェクトを支援してくださる <a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme">OrcaRouter</a> に感謝します。OrcaRouter は本番の AI 向けに作られた OpenAI 互換の AI ゲートウェイです。すべてのプロンプトを採点して基準を満たすモデルへ送る適応型ルーティング、自動 failover、コードとして書けるルーティングルール、プロンプトキャッシュ付きのマークアップなしプロバイダー価格、そして 200 以上のモデルへのすべての呼び出しに付くガードレール・エージェントファイアウォール・リクエストログを備えています。Add provider ピッカーで <code>OrcaRouter</code> を選ぶか <code>ocx provider add orcarouter</code> を実行してください。適応型ルーターは <code>orcarouter/auto</code> です。</td>
</tr>
<tr>
<td width="180"><a href="https://www.packyapi.com/register?aff=k5KT"><img src="../assets/sponsors/packycode.png" alt="PackyCode" width="150"></a></td>
<td>このプロジェクトを支援してくださる <a href="https://www.packyapi.com/register?aff=k5KT">PackyCode</a> に感謝します。PackyCode は安定した高性能の API リレープロバイダーで、Claude Code、Codex、Gemini などのリレーを提供しています。自動 failover、スマートルーティング、無制限の同時実行によって、AI を実際の生産性ツールに変えます。<a href="https://www.packyapi.com/register?aff=k5KT">このリンクから登録</a>してすぐに始めてください。Add provider ピッカーで <code>PackyCode</code> を選ぶか <code>ocx provider add packycode</code> を実行してください。<br><sub>PackyCode 是一家稳定、高效的 API 中转服务商，提供 Claude Code、Codex、Gemini 等多种中转服务。具备自动故障转移、智能路由和无限并发等多种功能，让 AI 编程成为真正的生产力工具。<a href="https://www.packyapi.com/register?aff=k5KT">点此链接注册</a>，立即开始使用！</sub></td>
</tr>
</tbody>
</table>

---

<details>
<summary>Docker Compose</summary>

このリポジトリには、digest 固定で非 root の Compose ビルドが入っています。ホストに Git と Bun があれば、
イメージをビルドするたびに正式な互換性マニフェストを生成し、データプレーンのトークンを stdin から一度
だけ初期化してハブを起動します:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

既定のホストバインドは `127.0.0.1:10100` です。リモートへ公開するには
`OPENCODEX_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d` を明示する必要があり、
`0.0.0.0` はホストのすべてのインターフェースを開きます。ファイアウォールと、認証付きの TLS または
tailnet のフロントエンドでアクセスを制限してください。生成された JSON は追跡されず、`.git` を含めずに
イメージへコピーされます。ソースを変更したら再生成し、生成からビルドまでの間はソースを触らないで
ください。ビルドは古いマニフェスト、欠けているファイルや不一致のファイル、余分なソースファイル、
シンボリックリンクを拒否します。記録された SHA-256 は、ビルドコンテキストとコピーされたランタイム
ファイル（`package.json`、`bun.lock`、明示的に含めた `scripts/model-metadata.source.json`）の
すべてと照合されます。

トークンと可変状態は `ocx-state` という named volume に残り、イメージ、Compose ファイル、環境変数、
シェル引数のどこにも認証情報は置かれません。プロバイダーの設定、認証付きの受け入れ確認、リモート管理、
ロールバックは [Remote Hub デプロイガイド](https://opencodex.me/ja/guides/remote-hub/)
を参照してください。

</details>

<details>
<summary>ソースからインストール（最新の dev）</summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex && ~/.bun/bin/bun install
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex; bun install
bun run src/cli/index.ts start
```

ソースからのインストールは最新の `dev` ブランチを動かします。メモリ所有権のパッチ、ランタイムの GC
改善、まだリリースされていない修正は、npm パッケージより先にここへ入ります。

</details>

<details>
<summary>エージェント向け</summary>

```bash
npm install -g @bitkyc08/opencodex
ocx start     # または `ocx service`
ocx init      # 対話式セットアップ: ~/.opencodex/config.json を書き、Codex を接続します
```

`ocx init` はプロキシを起動しません。先に起動してください（後でもかまいません。順番は問いませんが、
`ocx provider add` や `ocx combo set` のようなヘッドレスコマンドは**動作中の**プロキシと通信し、
届かなければ非ゼロで終了します）。`ocx status` / `ocx doctor` / `ocx health` が動作状態を報告します。

> **opencodex をインストールまたは実行するエージェントへ:**
> [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md) を読んでください。対話的な `ocx start` は、このリポジトリ
> に star を付けるかどうかを一度だけ尋ねることがあります。それはユーザーの判断であり、エージェントの
> 判断ではありません。CLI はエージェント実行ではこのプロンプトを抑制し、API は
> `403 agent_consent_required` で拒否します。

</details>

## 対応プラットフォーム

| OS | 状態 | サービスマネージャー |
|---|---|---|
| macOS (arm64 / x64) | 完全対応 | launchd |
| Linux (x64 / arm64) | 完全対応 | systemd (user unit) |
| Windows (x64) | 完全対応 | タスクスケジューラ（非表示）/ 任意のネイティブサービス（`--native`、WinSW） |

[Node](https://nodejs.org) 18 以上が必要です。Bun ランタイムは `npm install` で同梱されるので、Bun を
別途入れる必要も、Windows で WSL を使う必要もありません。npm が同梱ランタイムのインストールスクリプト
をブロックした場合は[インストールドキュメント](https://opencodex.me/ja/getting-started/installation/)を
参照してください。

## 主な特徴

- **Codex、Claude Code、Claude Desktop、Grok Build でどの LLM でも** — 40 以上のプロバイダーが最初から
  使え、それぞれがネイティブの UI を保ちます。
- **ChatGPT アカウントのプール** — スレッド affinity、クォータを見た自動切り替え、クールダウン、
  fail-closed な認証処理。

  > **プロバイダーポリシーに関する注意:** アカウントプールはルーティングと運用の耐障害性のためのもので
  > あり、プロバイダーのレート制限、措置、停止その他のアカウント処分から守るものではありません。
  > OpenCodex は、プロバイダーの制限を回避するために追加のアカウントを使うことや、アカウントの認証情報
  > を人と共有することを推奨しません。各プロバイダーの現行の規約を守る責任は利用者にあります。
  > [Codex Auth とアカウントプールの案内](https://opencodex.me/ja/guides/web-dashboard/)
  > と [OpenAI の現行利用規約](https://openai.com/policies/terms-of-use/)をご覧ください。
- **コンボ** — 1 つの仮想モデル ID で、複数プロバイダーにまたがる failover や重み付きラウンドロビンを
  組みます。[コンボガイド](https://opencodex.me/ja/guides/combos/)を参照してください。
- **どのモデルでもサブエージェントに** — ルーティングしたモデルを Codex のサブエージェントピッカーに
  出し、v1/v2 の表面制御とフォールバックチェーンを設定できます。
  [サブエージェントガイド](https://opencodex.me/ja/guides/sub-agent-surface/)を参照してください。
<!-- sponsors:main-first-mention -->
- **一度ログインすれば API キーは不要** — xAI、Anthropic、Kimi は OAuth に対応します。あるいは
  `codex login` を転送する、キーを貼り付ける、`${ENV_VAR}` 参照を使う、のいずれでもかまいません。
- **Web 検索とビジョンのサイドカー** — OpenAI 以外のモデルも、ChatGPT ログインの上で動くサイドカーを
  通じて本物の Web 検索と画像理解を使えます。
- **何が起きているか見える** — ダッシュボードがプロバイダー、OAuth の状態、モデルの選択、そしてキャッシュ
  トークン数まで含むリアルタイムのリクエストログを表示します。
- **後始末の要らない終了** — `ocx stop` が Codex を元の設定に戻します。
- **上限のあるメモリ所有権** — 長く生きるキャッシュ、リングバッファ、プロトコル変換のストアには、必ず
  有限の上限、バイト予算、あるいは能動的な reconciliation があります。config を再読み込みしたあとに
  上限のない `Map` や `Set` は残りません。

<details>
<summary>メモリ所有権の詳細</summary>

OpenCodex はプロセスが保持する状態を 36 種類に分けて追跡し、それぞれに文書化された上限があります:

- **保持ストア 12 個**（リクエストログ、デバッグリング、画像キャッシュ、モデルキャッシュ、ビジョンの
  説明、カーソル blob、responses の継続など）はバイト単位で集計され、アプリが持つメモリ予算
  （既定 256 MiB）によって退避されます。
- **観測バッファ 4 個**（トランスレーターのアキュムレーター、画像・OAuth・Grok の tail）は処理中の
  バイト圧力を監視するだけで、退避はしません。
- **state-store の登録 24 個**が期限切れの掃除（60 秒間隔）と config 世代の reconciliation を担い、
  古いプロバイダー／アカウントのキーを取り除きます。
- **パスとフィンガープリントのメモ**（ワークスペースのメタデータ、hardened identity、インストール
  salt、mode-hint の capability）は挿入順の LRU 上限（8〜128 件）を使います。
- **モデルキャッシュの世代 tombstone** は reconciliation のあとに削除されます。グローバルな世代を
  進めることで、進行中だった古い discovery が削除済みのプロバイダーを復活させないようにしています。
- **Lab のイベント ID 重複排除**はディスク上の ledger ロックの下で動き、プロセス側の RAM インデックス
  は持ちません。

管理トークンを付けて `GET /api/system/memory` を叩けば、現在の保持バイト数、退避カウンター、
ウォッチドッグのサンプルを確認できます。

</details>

## モデルルーティング

`provider/model` の書き方で、設定済みのどのプロバイダーとモデルでも指定できます:

```bash
codex -m "anthropic/claude-opus-5" "このスタックトレースを説明して"
codex -m "google/gemini-3-pro" "auth.ts のユニットテストを書いて"
codex -m "ollama/llama3" "この関数をリファクタリングして"
```

`provider/` の接頭辞を省くと、既定のプロバイダーを使うか、モデル名のパターンで自動的に一致させます。
`/` を含むプロバイダーのモデル ID は、内側のスラッシュを `-` に置き換えた別名で公開され、スラッシュ
のままの完全形も引き続き使えます。詳細は
[モデルルーティングのドキュメント](https://opencodex.me/ja/guides/model-routing/)を参照してください。

## プロバイダーとアダプター

<!-- sponsors:main-first-mention -->
OpenAI（ChatGPT ログインまたは API キー）、Anthropic、Google Gemini、xAI、Kimi、Azure OpenAI、Ollama
（ローカル + Cloud）、Cursor（実験的）、そしてあらゆる OpenAI 互換エンドポイント。さらに DeepSeek、
Groq、OpenRouter、Together、Fireworks、Cerebras、Mistral、Hugging Face、NVIDIA NIM、MiniMax、
Qwen Cloud、Qoder Global と CN（公式 PAT + CLI）、SiliconFlow などがあります。全一覧は `ocx init` か
[プロバイダーのドキュメント](https://opencodex.me/ja/guides/providers/)で確認できます。

## CLI

```bash
ocx init                       # 対話式セットアップ（config を書き、Codex を接続し、shim を提案）
ocx start [--port 10100]       # プロキシをフォアグラウンドで起動
ocx stop                       # 停止してネイティブの Codex を復元
ocx service [install|repair|restart|start|stop|status|uninstall|remove]  # バックグラウンドサービス
ocx codex-shim install         # `codex` の起動時にプロキシをオンデマンドで立ち上げる
ocx health [--json]            # プロキシが今生きているかを確認
ocx ready [--json] [--wait [--timeout <seconds>]]  # 同期後の準備状態を確認
ocx status                     # プロキシは動いているか
ocx gui                        # Web ダッシュボードを開く
ocx provider <...>             # プロバイダーの管理（list/add/edit/test/remove）
ocx account <...>              # ChatGPT アカウントと API キープールの管理
ocx combo <...>                # failover / ラウンドロビンのコンボ管理
ocx v2 <...>                   # マルチエージェント v1/v2 の表面制御
ocx update [--tag preview]     # opencodex の更新
```

ポートを固定せずに起動した場合、希望のポートが埋まっていれば別の空きポートへ移ることがあります。
`--port` を明示した起動は決して移りません。全リファレンスは
[CLI のドキュメント](https://opencodex.me/ja/reference/cli/)にあります。

### ヘルスと準備状態

`GET /healthz` はプロキシが今生きているかをすぐに返します。認証の要らない `GET /readyz` は、同期が
終わったあとの準備状態を、機微な情報を除いた JSON identity `{service, version, uptime, pid, port, status}`
で返します。`status` が `ready` なら `200`、`pending` と最終的な `failed` は `Retry-After: 1` を
付けて `503` を返します。

`ocx ready [--json] [--wait [--timeout <seconds>]]` は既定で 1 回だけ probe します。`--wait` は既定で
最大 45 秒ポーリングしますが、最終的な `failed` を見た時点ですぐ終了します。`--timeout <seconds>` は
1〜300 秒の上限を設定し、`--wait` を必要とし、正の整数だけを受け付けます。CLI の `--json` 出力は
`{ready, status, pid, port}` で、`status` は `ready`、`pending`、`failed`、`unreachable` のいずれかです。

| 終了コード | 結果 |
| --- | --- |
| `0` | 準備完了 |
| `1` | 準備できていない: pending、failed、タイムアウト、到達不能 |
| `64` | 引数が不正 |

`/readyz` を持たない古いプロキシは `unreachable` として fail-closed になり終了コード 1 を返します。
`ocx health` はそのまま互換です。

### 自動起動: service と shim

常時稼働でクラッシュ時に再起動させたいなら **service**（`ocx service`）を使います。バックグラウンド
デーモンなしで軽くオンデマンドに起動したいなら **shim**（`ocx codex-shim install`）を使います。削除は
`ocx service uninstall` / `ocx codex-shim uninstall` です。

### アンインストール

```bash
ocx uninstall                  # 停止し、service/shim を削除し、ネイティブ Codex を復元し、状態を片づける
npm uninstall -g @bitkyc08/opencodex
```

## リモートアクセス

opencodex は既定で `127.0.0.1` にバインドし、追加の認証を必要としません。ループバックの外へ
バインドする場合（`"hostname": "0.0.0.0"`）は bearer トークンが**必須**です。
`OPENCODEX_API_AUTH_TOKEN` がなければプロキシは起動を拒否し、すべてのクライアントリクエストは
`x-opencodex-api-key` としてトークンを乗せる必要があります。詳細は
[設定リファレンス](https://opencodex.me/ja/reference/configuration/)にあります。

## ドキュメント

公開ドキュメント（インストール、プロバイダー、ルーティング、コンボ、サブエージェント、サイドカー、
連携、CLI／設定／管理 API のリファレンス）は [`docs-site/`](../docs-site) からビルドされ、
**[opencodex.me](https://opencodex.me/ja/)** に公開されています。

メンテナー向けの source-of-truth なノートは [`structure/`](../structure) に、コントリビューターの
セットアップは [`CONTRIBUTING.md`](../CONTRIBUTING.md) に、セキュリティ報告は
[`SECURITY.md`](../SECURITY.md) にあります。未公開の脆弱性は公開 issue ではなく
[GitHub の非公開脆弱性報告](https://github.com/lidge-jun/opencodex/security/advisories/new)から
非公開で報告してください。
技術的な窓口はこのフォームだけで、セキュリティ用のメールアドレスはありません。やり取りは非公開の報告の
中で続けてください。公開 issue に置いてよいのは調整のための連絡だけで、脆弱性の詳細は置けません。受領の
連絡はトリアージではなく、初回応答までの期限も約束していません。

## 開発

ソース開発には `PATH` に `bun` CLI が必要です。これは公開 npm パッケージが同梱する Bun ランタイム
とは別物で、同梱ランタイムはインストール済みの `ocx` コマンドだけが使います。

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

**[コントリビューション](../CONTRIBUTING.md)**を参照してください。

メンテナーが代わりに取り込んだり作り直したりして入ったものの、コミットに原作者が記されていない
コントリビューターの作業は **[CREDITS.md](../CREDITS.md)** に記録しています。

## 免責事項

opencodex はコミュニティが維持する独立したプロジェクトであり、**OpenAI、Anthropic をはじめとするどの
プロバイダーとも提携しておらず、承認も受けていません。**

一部のプロバイダー、とくに Anthropic (Claude) は、サードパーティのプロキシ経由で API トラフィックを流すアカウントを停止または制限することがあります。**自己責任でご利用ください (UAYOR)。** プロバイダーを接続する前に、その利用規約でプロキシ経由のアクセスが認められているか確認してください。opencodex のメンテナーは、アップストリームのプロバイダーが取ったアカウント処分について責任を負いません。

## ライセンス

MIT
