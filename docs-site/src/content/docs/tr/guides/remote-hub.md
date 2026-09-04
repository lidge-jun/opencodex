---
title: Remote Hub Dağıtımı
description: Loopback yönetimi, Tailscale Serve ve başsız OAuth ile opencodex hub çalıştırma.
---

Remote Hub sağlayıcı kimlik bilgilerini, kataloğu ve kullanım kayıtlarını tek ana bilgisayarda tutar. Kimliği doğrulanmış istemciler veri düzlemine doğrudan bağlanır. Yönetim düzlemi ayrıdır: isteğe bağlı dinleyici yalnızca `127.0.0.1` üzerinde çalışır ve pano ile `/api/*` yollarını sunar; `/v1/*`, `/healthz`, `/readyz` veya WebSocket sunmaz. `10101` portunu yayımlamayın ve Tailscale Funnel kullanmayın.

## Roller ve güven sınırı

`standalone` her şeyi tek makinede tutar; `hub` sağlayıcı sırları ve kullanımı yönetir; `client` yalnızca bağlantı durumunu ve istemciye özel veri anahtarını saklar.

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

İstemci anahtarı yalnızca sahibinin okuyabildiği `service-api-token` dosyasına yazılır, `config.json` içine yazılmaz. Bağlı kullanım hub deposundan aynı `apiKeyId` ile filtrelenir; bağlantı kesilince yerel depo kullanılır. İki depo birbirini yansıtmaz.

Admin token sıradan yönetim yapabilir ancak hiçbir zaman onay oturumu oluşturamaz. Onay işlemleri sunucu tarafından verilen `gui-session`, eşleşen Origin ve CSRF ister. `Tailscale-User-Login` yalnızca ayrı yönetim girişinde güvenilirdir; tam kimlikleri `remoteGui.allowedTailscaleUsers` içinde belirtin.

## Servis ve Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

systemd/launchd korumalı `service-api-token` dosyasını okur; plist veya unit içine gerçek sır yazılmaz.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` yalnızca işlemin yaşadığını gösterir. `/readyz`, kimlik doğrulamalı `GET /v1/catalog` ve gerçek bir model yanıtını da doğrulayın. Kendi TLS proxy'niz için `tailscale cert hub-name.tailnet-name.ts.net` kullanın ve yalnızca `127.0.0.1:10101` hedefine yönlendirin. `Tailscale-User-*` başlıkları uydurmayın; güvenilir kimlik yoksa tek kullanımlık eşleştirme kullanın.

## OAuth, döndürme ve bağlantı kesme

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# yalnızca HTTPS:
ocx connect rotate --admin-token-stdin
```

OAuth'u `POST /api/oauth/login` ile başlatın. Callback hub'a ulaşamıyorsa son URL'yi veya kodu `{provider,input}` olarak `POST /api/oauth/login/code` yoluna gönderin. OAuth kodunu argv veya loglara koymayın.

Döndürme sırasında eski ve yeni anahtar aynı `apiKeyId` altında en fazla on dakika geçerlidir. Eski anahtar `service-api-token.prev` dosyasına alınır, yeni anahtar atomik olarak kurulur ve `/v1/catalog` ile doğrulanıp onaylanır. Sonuç belirsizse geçici yetkiyle komutu yeniden çalıştırın; iki adayı da doğrulamadan silmeyin.

`ocx disconnect` hub çevrimdışıyken yerel durumu geri yükler ama hub anahtarını iptal etmez. Bağlantıdan sonra tek iptal yolu hub üzerindeki **Integrations → API Keys** sayfasıdır. `ocx connect revoke --admin-token-stdin` yalnızca bağlantı sürerken kullanılabilir.

## Docker ve sorun giderme

Resmî Docker imajı yoktur; ancak depo, digest ile sabitlenmiş Bun imajını yerelde oluşturmak için bakımı yapılan bir `Dockerfile` ve `compose.yaml` sağlar. İlk başlatmadan önce veri anahtarını stdin üzerinden bir kez başlatın; anahtar yazdırılmaz ve `ocx-state` volume içinde yalnızca sahibinin okuyabileceği izinlerle saklanır.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

Konteyner root olmayan `bun` kullanıcısıyla, salt okunur kök dosya sistemiyle çalışır ve yalnızca `10100` portunu yayımlar. `10101` portunu yayımlamayın ve sırları `ARG`, `ENV`, `COPY`, Compose, imaj geçmişi veya argv içine koymayın. Healthcheck sonrasında readiness, kimlik doğrulamalı katalog ve gerçek yanıtı ayrıca doğrulayın. `docker compose down` volume'u korur; `docker compose down --volumes` yapılandırmayı, kimlik bilgilerini ve anahtarı da siler.

- Hub kapalıysa yerel geri dönüş yapılabilir; uzaktaki anahtarın iptali bekler.
- Geçici arızada doğrulanmış LKG korunur; auth, şema, boyut veya protokol hatasında yerel fallback yoktur.
- `.prev` kurtarmasında iki dosyayı koruyup geçici yetkiyle yeniden çalıştırın.
- `hub-too-new`/`hub-too-old` eski tarafı gösterir; yerel yazımdan önce reddedilir.
- Eşleştirme tek kullanımlıktır ve hatalar 429 ile sınırlanır; kayıp kodu yeniden üretin.
- Loopback dışı HTTP için `--allow-insecure-http` gerekir; admin token HTTP ile gönderilmez.
- Tarayıcı logout/expiry veri anahtarını iptal etmez.
- `tailscale serve reset` tüm eşlemeleri kaldırır; önce durumu inceleyin.
