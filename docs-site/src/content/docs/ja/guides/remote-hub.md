---
title: Remote Hub のデプロイ
description: 管理ポートをループバックに限定し、Tailscale Serve とヘッドレス OAuth で運用します。
---

Remote Hub はプロバイダー認証情報、カタログ、使用量を一台のホストに保持し、認証済みクライアントからデータプレーンへ直接接続します。管理プレーンは別系統で、任意の管理リスナーは `127.0.0.1` にのみバインドされ、ダッシュボードと `/api/*` だけを提供します。`/v1/*`、`/healthz`、`/readyz`、WebSocket は提供しません。`10101` を公開したり Tailscale Funnel を使ったりしないでください。

## 役割、接続、信頼境界

`standalone` は一台で完結し、`hub` はプロバイダー秘密情報と使用量を所有し、`client` は接続状態とクライアント専用データキーだけを保存します。

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

発行されたキーは所有者だけが読める `service-api-token` に保存され、`config.json` には入りません。接続中の使用量は hub 側で同じ `apiKeyId` に絞り込まれ、切断後はローカル保存分を表示します。両者はミラーリングされません。

管理トークンは通常の管理だけに使え、同意セッションを作ることは永久にできません。同意操作にはサーバー発行の `gui-session`、一致する Origin、CSRF が必要です。`Tailscale-User-Login` は専用管理リスナーでのみ信頼し、許可する ID を `remoteGui.allowedTailscaleUsers` に正確に設定します。

## サービスと Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# 新規の standalone 設定には `hub` も `remoteGui` も存在せず、`ocx config set` は
# 親オブジェクトを自動生成しません。いきなりネストしたパスを書くと
# `config parent path not found: hub` で失敗します。`runtimeRole` を変えても
# 生成されません。先にオブジェクトを作ってからフィールドを設定してください。
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

設定がまだ完全に空であれば、オブジェクトごと一度に書いても構いません。

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

この形はオブジェクトがまだ無いときだけに使ってください。オブジェクト全体の設定はマージではなく**置換**です。すでに `hub.managementIngress` がある設定に上の行を流すと、その値は黙って消えます。既存の設定を直すときは親が揃っているので、ネストしたパスで一つずつ設定すれば他には触れません。

行が通るかどうかを決めるのは二点です。値はまず JSON として解釈され、失敗すると生の文字列として扱われます。URL を `'"https://…"'` と書く理由がこれで、オブジェクト・配列・真偽値・数値は正しい JSON である必要があります。また `hub` と `remoteGui` は厳格なスキーマで、キーの打ち間違いも規格外の値も書き込み時点で `schema_invalid` エラーとして拒否されます。効かない設定が静かに残ることはありません。`managementPublicOrigin` はパス・クエリ・フラグメントを含まない裸の origin である必要があります。

launchd/systemd は保護された `service-api-token` を読み、設定ファイルへ秘密値を埋め込みません。

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` の `200` はプロセスの生存確認にすぎません。`/readyz`、認証済み `GET /v1/catalog`、実際のモデル応答も確認してください。独自 TLS プロキシでは `tailscale cert hub-name.tailnet-name.ts.net` を使い、`127.0.0.1:10101` のみに転送します。`Tailscale-User-*` を偽造せず、信頼できる ID がない場合は一度限りのペアリングを使います。

### データリスナーに TLS を付ける

上の Serve マッピングが公開するのは**管理**入口だけです。管理入口は `/v1/*`、`/healthz`、`/readyz` を提供しないため、それだけではリモートクライアントが使えるデータプレーンになりません。opencodex 自身は TLS を終端しません。リスナーは平文 HTTP で、HTTPS は常に運用者が用意するフロントエンドの役目です。

データプレーンも Serve で公開できます。HTTPS ポートをもう一つ使うだけです。macOS では一段だけ余分に必要になります。Tailscale Serve は `127.0.0.1` にしかプロキシできず、ノード自身の tailnet アドレスにバインドしたリスナーを指せません。App Store 版の macOS クライアントはリモート宛先自体を拒否します。hub 上にループバックのフォワーダーを立て、Serve をそちらへ向けてください。

```bash
# ループバック TCP フォワーダーなら何でも構いません。socat はその一つです。
# ハブがまだ使っていないポートを選んでください。ループバック companion を有効にすると 127.0.0.1:10100 は opencodex 自身のものです。
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # 443 -> 10101 と 8443 -> 10110 の両方が出ること
```

Serve が受け付ける HTTPS ポートは限られています。通ったと決めつけず、`tailscale serve status` でマッピングが実際に作られたか確認してください。フォワーダーは hub と同じ寿命にします。バックグラウンドのシェルジョブは再起動で消える一方サービスは戻ってくるため、hub は動いているのに TLS では届かない状態が残ります。`ocx service install` と並べて launchd か systemd から起動してください。

接続時は二つの origin を別々に指定します。位置引数の URL が**データ** origin で、`/readyz` と `/v1/catalog` はここから取得されます。`--management-url` はペアリングとキー発行に使うダッシュボードの origin です。ポートが同じである必要はありません。

```bash
ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --admin-token-stdin
```

`--management-url` を省略すると `/readyz` の応答が返す `hub.managementPublicOrigin` が使われます。二つの origin が異なる場合は明示したほうが明快です。

**データリスナーを `127.0.0.1` にバインドして近道しないでください。** ループバックへのバインドは、opencodex が純粋にローカルな配置だと判断する仕組みです。データ用の資格情報を要求しなくなる代わりに、リクエストの `Host` ヘッダーまでループバックであることを要求します。TLS フロントエンドは `Host: hub-name.tailnet-name.ts.net` をそのまま転送するので、`/v1/catalog` は `403 origin_rejected` を返し、その検査を行わない `/readyz` は `200` のままです。健全に見えるのにモデルを返せない配置ができあがります。リクエスト経路のどこも `X-Forwarded-Host` を読まないため、フロントエンド側では直せません。リスナーは tailnet アドレスに置いてください。資格情報の検査は有効なままで、`Host` 検査は適用されません。

`0.0.0.0` へのバインドでも動き、ループバックからも届くのでフォワーダーは不要になります。ただしデータポートが全インターフェースに公開されるため、他のネットワークを気にしなくてよいホストに限ってください。

Serve が立ち上がったら、HTTPS のデータ origin に対して `/readyz`、認証済み `GET /v1/catalog`、実際のモデル応答を改めて確認します。

## OAuth、キー更新、切断

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# HTTPS のみ:
ocx connect rotate --admin-token-stdin
```

OAuth は `POST /api/oauth/login` で開始し、コールバックできない場合は最終 URL またはコードを `{provider,input}` として `POST /api/oauth/login/code` へ渡します。コードを argv やログに残さないでください。

キー更新では最大10分間、旧キーと新キーが同じ `apiKeyId` で有効です。旧キーを `service-api-token.prev` に保存し、新キーを原子的に置換して `/v1/catalog` で確認後に確定します。結果が不明な場合は一時権限を使って同じコマンドを再実行し、両候補の判定が終わるまで削除しないでください。

`ocx disconnect` は hub が停止中でもローカル状態を復元しますが、hub のキーは失効させません。切断後は hub の **Integrations → API Keys** だけが失効経路です。`ocx connect revoke --admin-token-stdin` は接続中のみ利用できます。

## Docker とトラブルシューティング

ロールバック時も両方のボリュームとマウント先を維持してください。既存ボリュームの所有者や権限は自動修復されません。Compose を使わない場合の名前付きマウントと独自の状態パスについては、[正本ガイド](/guides/remote-hub/#docker-compose)を参照してください。

状態は二つのボリュームに分けて永続化します。`ocx-state` は
`OPENCODEX_HOME=/home/bun/.opencodex`、`codex-state` は
`CODEX_HOME=/home/bun/.codex` に対応します。両製品の `auth.json` は形式が
異なるため、ホームを同じディレクトリにしないでください。読み取り専用の
ルートでも、この二つのホームは書き込み可能です。

カタログは自動生成されません。認証付き `/v1/catalog` の確認前に、有効な
`/home/bun/.codex/opencodex-catalog.json` を生成または取り込んでください。
空のホームでは `catalog_not_found` の 404 が正常です。アップグレードは既存の
`ocx-state` を保持して `codex-state` を追加しますが、ファイルは自動移行しません。
以前 `.opencodex` に置いたカタログはバックアップし、カタログだけを所有者限定の
権限で移してください。`auth.json` を相互に上書きしないでください。
`CODEX_HOME` を変更する場合は、そのディレクトリ自体を書き込み可能なボリュームに
マウントし、既定のカタログを `${CODEX_HOME}/opencodex-catalog.json` に置きます。
`model_catalog_json` で別のファイルを指定した場合は、その解決先も永続化します。
カスタム構成は、明示的な移行が完了するまで環境変数とボリュームの対応を維持します。
`docker compose down` は両ボリュームを保持しますが、`docker compose down --volumes`
は `ocx-state` と `codex-state` の両方を削除し、認証情報・使用履歴・データキー・
Codex の状態とカタログも失われます。更新や再起動の代わりに使わないでください。

公式 Docker イメージはありませんが、リポジトリには digest 固定の Bun イメージをローカルビルドするための、管理された `Dockerfile` と `compose.yaml` があります。初回起動前にデータキーを stdin から一度だけ初期化します。キーは表示されず、`ocx-state` ボリューム内に所有者限定の権限で保存されます。

ホストに Git と Bun が必要です。イメージをビルドするたびに、Git 管理下のソースから正規のマニフェストを生成し、生成後はビルドまでソースを変更しないでください。生成 JSON は Git に追加せず、`.git` は Docker コンテキストから除外します。ホスト側は既定で `127.0.0.1` にバインドします。リモート公開は `OPENCODEX_BIND_ADDRESS=<LANまたはTailscaleのIP> docker compose up -d` で明示的に指定し、`0.0.0.0` は全インターフェースを公開します。ファイアウォールと認証付き TLS/tailnet フロントエンドで保護してください。

ビルドは古いマニフェストを拒否し、すべての SHA-256 をコンテキストとコピー後のファイルに照合します。欠落・不一致のファイル、余分なソース、シンボリックリンクは拒否されます。`package.json`、`bun.lock`、および `scripts/` から唯一取り込む `scripts/model-metadata.source.json` が必須です。

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

コンテナは非 root の `bun` ユーザー、読み取り専用のルートファイルシステムで実行され、公開するのは `10100` だけです。`10101` は公開せず、秘密値を `ARG`、`ENV`、`COPY`、Compose、イメージ履歴、argv に入れないでください。healthcheck 後にも readiness、認証済みカタログ、実リクエストを別途確認します。`docker compose down` はボリュームを保持し、`docker compose down --volumes` は設定、認証情報、キーも削除します。

- hub 停止時はオフライン切断できますが、キー失効は未完了のままです。
- 一時障害時だけ検証済み LKG を維持し、認証・スキーマ・サイズ・プロトコル障害でローカルへフォールバックしません。
- `.prev` 復旧では二つのファイルを保持して一時権限付きで再実行します。
- `hub-too-new`/`hub-too-old` が示す古い側を更新してください。書き込み前に拒否されます。
- ペアリングコードは一度限りで、失敗は 429 制限されます。失った場合は再発行します。
- 非ループバック HTTP のペアリングは拒否され、それを外すフラグはありません。管理 origin を HTTPS の背後に置くか、ループバックでペアリングしてください。管理トークンは HTTP 送信されません。
- `/readyz` が `200` なのに `/v1/catalog` が `403 origin_rejected` を返す場合、データリスナーが TLS フロントエンドの背後でループバックにバインドされています。上の「データリスナーに TLS を付ける」を参照してください。
- ブラウザーのログアウト/期限切れはデータキーを失効させません。
- `tailscale serve reset` の前に全マッピングを確認してください。
