---
title: Remote Hub 部署
description: 使用僅限迴路的管理入口、Tailscale Serve 與無頭 OAuth 執行 opencodex hub。
---

Remote Hub 把供應商憑證、模型目錄與用量記錄保存在一台主機上，已驗證的用戶端直接連到資料平面。管理平面彼此分離：選用的管理監聽器只綁定 `127.0.0.1`，僅提供儀表板與 `/api/*`。它不提供 `/v1/*`、`/healthz`、`/readyz` 或 WebSocket。不要直接發布 `10101`，也不要使用 Tailscale Funnel。

## 角色與信任邊界

`standalone` 在同一台機器上執行全部功能；`hub` 保存供應商金鑰與用量；`client` 只保存連線狀態與專屬資料金鑰。

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

用戶端金鑰會寫入只有擁有者可讀的 `service-api-token`，絕不寫入 `config.json`。連線期間，用量來自 hub 並依穩定的 `apiKeyId` 篩選；中斷後則顯示本機記錄。兩者不會互相鏡像。

Admin token 只能執行一般管理，永遠不能建立使用者同意工作階段。同意操作必須使用伺服器簽發的 `gui-session`、相符的 Origin 與 CSRF。`Tailscale-User-Login` 只在獨立管理入口可信；請在 `remoteGui.allowedTailscaleUsers` 填入完整且正確的登入名稱。

## systemd/launchd 與 Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# 全新的 standalone 設定沒有 `hub` 或 `remoteGui` 物件，而 `ocx config set` 不會
# 自動建立缺少的父物件：直接寫巢狀路徑會以 `config parent path not found: hub` 失敗。
# 設定 `runtimeRole` 同樣不會建立它。請先建立物件，再設定欄位。
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

若設定確實還是空的，也可以一次寫入整個物件：

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

只有在物件尚未存在時才使用這種寫法。整個物件的賦值是**取代**而非合併：對已經含有 `hub.managementIngress` 的設定執行上面那行，該入口會被悄悄丟掉。調整既有設定時父物件已經存在，用巢狀路徑逐一設定欄位即可，不會動到其他值。

有兩點決定一行命令能否被接受。值會先以 JSON 解析，失敗才退回原始字串——這就是 URL 要寫成 `'"https://…"'` 的原因，物件、陣列、布林值與數字都必須是合法 JSON。另外 `hub` 與 `remoteGui` 採用嚴格結構：鍵名打錯或取值不合規，都會在寫入當下以 `schema_invalid` 錯誤遭拒，而不會變成永遠不生效的設定。`managementPublicOrigin` 必須是不含路徑、查詢與片段的純 origin。

systemd/launchd 從受保護的 `service-api-token` 讀取金鑰，plist 與 unit 不包含明文金鑰。

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` 只證明程序仍在執行。還必須驗證 `/readyz`、已驗證的 `GET /v1/catalog` 與一次真實模型回應。管理連接埠只能監聽 `127.0.0.1`。自管 TLS proxy 應使用 `tailscale cert hub-name.tailnet-name.ts.net`，並只代理到 `127.0.0.1:10101`。不要偽造 `Tailscale-User-*`；沒有可信身分時請使用一次性配對。

### 為資料監聽器提供 TLS

上面的 Serve 對應只發布**管理**入口。該入口從不提供 `/v1/*`、`/healthz` 或 `/readyz`，因此光靠它並不能讓遠端用戶端取得可用的資料平面。opencodex 本身也不終結 TLS：監聽器是明文 HTTP，HTTPS 一律由維運方自建的前端負責。

資料平面同樣可以交給 Serve，只要再用一個 HTTPS 連接埠。在 macOS 上還要多一跳，因為 Tailscale Serve 只能代理到 `127.0.0.1`，無法指向你綁在節點自身 tailnet 位址上的監聽器，而 App Store 版 macOS 用戶端會直接拒絕遠端目的地。請在 hub 上執行一個迴路轉送器，再讓 Serve 指向它：

```bash
# 任何迴路 TCP 轉送器都可以，socat 只是其中之一。請選一個 hub 尚未佔用的連接埠：
# 啟用迴路 companion 後，127.0.0.1:10100 屬於 opencodex 自己。
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # 應同時出現 443 -> 10101 與 8443 -> 10110
```

Serve 只接受有限的幾個 HTTPS 連接埠。請用 `tailscale serve status` 確認對應確實建立，不要假設連接埠已被允許。轉送器應與 hub 有相同的生命週期：背景 shell 工作會在重開機時消失而服務會自行復原，於是 hub 在執行卻無法經 TLS 連到。請隨 `ocx service install` 一起，用 launchd 或 systemd 託管它。

連線時把兩個 origin 分開寫。位置參數 URL 是**資料** origin，`/readyz` 與 `/v1/catalog` 都從這裡取得；`--management-url` 則是用於配對與金鑰簽發的儀表板 origin。兩者不必共用連接埠：

```bash
ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --admin-token-stdin
```

省略 `--management-url` 時，它取自 `/readyz` 回應，而該回應回報的正是 `hub.managementPublicOrigin`。兩個 origin 不同時，明確寫出更清楚。

**不要為了省事把資料監聽器綁到 `127.0.0.1`。** 迴路繫結正是 opencodex 判定「純本機部署」的依據：它會不再要求資料憑證，改為要求請求的 `Host` 標頭也是迴路位址。TLS 前端會原樣轉送 `Host: hub-name.tailnet-name.ts.net`，於是 `/v1/catalog` 回應 `403 origin_rejected`，而不做這項檢查的 `/readyz` 仍然回應 `200`。部署看起來健康，卻無法提供模型。請求路徑中沒有任何程式碼會讀取 `X-Forwarded-Host`，所以前端也修不了。請把監聽器留在 tailnet 位址上：憑證准入維持開啟，而 `Host` 檢查不會生效。

繫結 `0.0.0.0` 同樣可行，而且因為迴路也連得到，就不再需要轉送器。但它會把資料連接埠發布到所有介面，所以只在你不在意其他網路的主機上這麼做。

Serve 就緒後，請對 HTTPS 資料 origin 重新執行驗收檢查：`/readyz`、已驗證的 `GET /v1/catalog` 與一次真實模型回應。

## OAuth、金鑰輪替與中斷連線

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# 僅限 HTTPS：
ocx connect rotate --admin-token-stdin
```

透過 `POST /api/oauth/login` 啟動 OAuth。若 callback 無法連到 hub，請把最終 URL 或授權碼以 `{provider,input}` 傳送到 `POST /api/oauth/login/code`。不要把 OAuth 碼放入 argv 或記錄。

輪替期間，舊金鑰與新金鑰會在同一個 `apiKeyId` 下最多同時有效十分鐘。舊金鑰備份到 `service-api-token.prev`，新金鑰以原子方式安裝，透過 `/v1/catalog` 驗證後再提交。若提交結果不確定，請使用暫時權限重新執行命令；驗證兩個候選金鑰前不要刪除任何檔案。

`ocx disconnect` 即使 hub 離線也能還原本機狀態，但不會撤銷 hub 金鑰。中斷後，唯一的撤銷入口是 hub 的 **Integrations → API Keys**。`ocx connect revoke --admin-token-stdin` 只能在仍連線時使用。

## Docker、回復與疑難排解

opencodex 不發布官方 Docker 映像，但儲存庫提供維護的 `Dockerfile` 與 `compose.yaml`，可在本機建置以 digest 固定的 Bun 映像。第一次啟動前，透過 stdin 初始化一次資料金鑰；金鑰不會被輸出，並以僅擁有者可讀的權限保存在 `ocx-state` volume。

主機需要安裝 Git 與 Bun。每次建置映像前，都應從 Git 追蹤的原始碼產生標準相容性清單，產生後到建置完成前不要修改原始碼。產生的 JSON 不加入 Git；`.git` 不進入 Docker 建置上下文。主機連接埠預設繫結至 `127.0.0.1`。遠端存取須明確使用 `OPENCODEX_BIND_ADDRESS=<LAN或Tailscale-IP> docker compose up -d`；`0.0.0.0` 會公開所有介面。請使用防火牆與經過身分驗證的 TLS/tailnet 前端保護存取。

建置會拒絕過期清單，並將每個 SHA-256 分別與建置上下文及複製後的檔案核對。缺少或不符的檔案、清單以外的原始碼及符號連結都會導致失敗。必須包含 `package.json`、`bun.lock`，以及 `scripts/` 中唯一納入的 `scripts/model-metadata.source.json`。

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

容器以非 root 的 `bun` 使用者執行，根檔案系統唯讀，且只發布 `10100`。不要發布 `10101`，也不要把金鑰放入 `ARG`、`ENV`、`COPY`、Compose、映像歷史或 argv。healthcheck 後仍須分別驗證 readiness、已驗證目錄與真實請求。`docker compose down` 會保留 volume；`docker compose down --volumes` 也會刪除設定、憑證與資料金鑰。

- hub 無法連線：可以離線中斷，但遠端金鑰仍待撤銷。
- 目錄過期：僅在暫時故障時保留已驗證的 LKG；驗證、結構、大小或協定錯誤不會切換到本機供應商。
- `.prev` 復原：保留兩個檔案，使用暫時權限重新執行輪替。
- `hub-too-new`/`hub-too-old` 會指出需要升級的一端，並在本機寫入前失敗。
- 配對碼只能使用一次，失敗次數會觸發 429；遺失後請重新建立。
- 非迴路 HTTP 配對會被直接拒絕，而且沒有任何開關可以豁免。請把管理 origin 放到 HTTPS 之後，或改在迴路上配對；Admin token 絕不透過 HTTP 傳送。
- `/readyz` 回應 `200` 但 `/v1/catalog` 回應 `403 origin_rejected`：表示資料監聽器綁在迴路位址卻位於 TLS 前端之後，請參見上文「為資料監聽器提供 TLS」。
- 瀏覽器 logout/expiry 只影響工作階段，不會撤銷資料金鑰。
- `tailscale serve reset` 會刪除節點上的所有映射，請先查看 `tailscale serve status`。
