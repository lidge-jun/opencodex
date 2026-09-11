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
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# Yeni bir standalone yapılandırmada `hub` veya `remoteGui` nesnesi yoktur ve
# `ocx config set` eksik bir üst nesneyi oluşturmaz: iç içe bir yol
# `config parent path not found: hub` hatasıyla başarısız olur. `runtimeRole`
# ayarlamak da onu oluşturmaz. Önce her nesneyi oluşturun, sonra alanlarını ayarlayın.
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

Yapılandırma gerçekten boşsa her nesneyi tek çağrıda da yazabilirsiniz:

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

Bu biçimi yalnızca nesne henüz yokken kullanın. Nesnenin tamamını atamak birleştirmez, **değiştirir**: zaten `hub.managementIngress` içeren bir yapılandırmada yukarıdaki satırı çalıştırmak o girişi sessizce düşürür. Mevcut bir yapılandırmayı uyarlarken üst nesne zaten yerindedir; tek tek alan ayarlayın, iç içe biçim çalışır ve başka hiçbir şeye dokunmaz.

Bir satırın kabul edilip edilmeyeceğini iki ayrıntı belirler. Değer önce JSON olarak ayrıştırılır, olmazsa ham dizgeye düşer; bir URL'nin `'"https://…"'` biçiminde yazılmasının nedeni budur ve nesneler, diziler, mantıksal değerler ve sayılar geçerli JSON olmak zorundadır. Ayrıca `hub` ve `remoteGui` katıdır: yanlış yazılmış bir anahtar da kurala uymayan bir değer de yazma anında `schema_invalid` hatasıyla reddedilir; hiçbiri hiçbir zaman etkili olmayan bir ayara dönüşmez. `managementPublicOrigin` yol, sorgu veya parça içermeyen çıplak bir origin olmalıdır.

systemd/launchd korumalı `service-api-token` dosyasını okur; plist veya unit içine gerçek sır yazılmaz.

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` yalnızca işlemin yaşadığını gösterir. `/readyz`, kimlik doğrulamalı `GET /v1/catalog` ve gerçek bir model yanıtını da doğrulayın. Kendi TLS proxy'niz için `tailscale cert hub-name.tailnet-name.ts.net` kullanın ve yalnızca `127.0.0.1:10101` hedefine yönlendirin. `Tailscale-User-*` başlıkları uydurmayın; güvenilir kimlik yoksa tek kullanımlık eşleştirme kullanın.

### Veri dinleyicisine TLS vermek

Yukarıdaki Serve eşlemesi yalnızca **yönetim** girişini yayımlar. Bu giriş `/v1/*`, `/healthz` veya `/readyz` sunmaz; dolayısıyla tek başına uzak bir istemciye kullanılabilir bir veri düzlemi vermez. opencodex kendi TLS'ini de sonlandırmaz: dinleyici düz HTTP'dir ve HTTPS her zaman operatörün kendi ön ucudur.

Serve, ikinci bir HTTPS portunda veri düzlemi için de bu ön uç olabilir. macOS'ta bir adım daha gerekir: Tailscale Serve yalnızca `127.0.0.1` adresine proxy yapar, yani düğümün kendi tailnet adresine bağladığınız dinleyiciyi hedefleyemez; macOS istemcisinin App Store sürümü ise uzak bir hedefi doğrudan reddeder. Hub üzerinde bir loopback yönlendirici çalıştırın ve Serve'ü ona yöneltin:

```bash
# Herhangi bir loopback TCP yönlendirici iş görür; socat bunlardan biridir. Hub'ın halihazırda
# kullanmadığı bir port seçin: loopback companion açıkken 127.0.0.1:10100 opencodex'in kendisine aittir.
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # iki eşleme de beklenir: 443 -> 10101 ve 8443 -> 10110
```

Serve sınırlı bir HTTPS portu kümesini kabul eder; portun izinli olduğunu varsaymak yerine `tailscale serve status` ile eşlemenin gerçekten oluştuğunu doğrulayın. Yönlendiriciye hub ile aynı ömrü verin: arka plandaki bir kabuk işi yeniden başlatmada ölürken servis geri gelir ve ortada çalışan ama TLS üzerinden erişilemeyen bir hub kalır. `ocx service install` ile birlikte launchd veya systemd üzerinden çalıştırın.

Ardından iki origin'i ayrı ayrı belirterek bağlanın. Konumsal URL **veri** origin'idir; `/readyz` ve `/v1/catalog` oradan alınır. `--management-url` ise eşleştirme ve anahtar verme için kullanılan pano origin'idir. Aynı portu paylaşmaları gerekmez:

```bash
ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --admin-token-stdin
```

`--management-url` atlandığında, `hub.managementPublicOrigin` değerini bildiren `/readyz` yanıtından alınır. İki origin farklıysa açıkça yazmak daha nettir.

**Veri dinleyicisini `127.0.0.1` adresine bağlayarak kestirmeden gitmeyin.** Loopback bağlaması, opencodex'in dağıtımı tümüyle yerel saymasının yoludur: veri kimlik bilgisi istemeyi bırakır ve bunun yerine isteğin `Host` başlığının da loopback olmasını şart koşar. Bir TLS ön ucu `Host: hub-name.tailnet-name.ts.net` başlığını olduğu gibi iletir, bu yüzden `/v1/catalog` `403 origin_rejected` yanıtı verirken bu denetimi yapmayan `/readyz` hâlâ `200` döndürür. Dağıtım sağlıklı görünür ama model sunamaz. İstek yolundaki hiçbir kod `X-Forwarded-Host` okumaz, dolayısıyla ön uç bunu onaramaz. Dinleyiciyi tailnet adresinde tutun: kimlik bilgisi kabulü açık kalır ve `Host` denetimi uygulanmaz.

`0.0.0.0` bağlaması da çalışır ve dinleyici loopback üzerinden de erişilebilir olduğundan yönlendirici ihtiyacını ortadan kaldırır. Veri portunu tüm arayüzlerde yayımladığı için yalnızca başka ağını önemsemediğiniz makinelerde tercih edin.

Serve ayağa kalktıktan sonra kabul denetimlerini HTTPS veri origin'ine karşı yineleyin: `/readyz`, kimlik doğrulamalı `GET /v1/catalog` ve bir gerçek yönlendirilmiş yanıt.

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

Geri alırken iki volume'u ve bağlama yollarını koruyun. Mevcut volume sahipliği ve izinleri otomatik düzeltilmez. Compose dışındaki adlandırılmış bağlamalar ve özel durum yolları için [ana kılavuza](/guides/remote-hub/#docker-compose) bakın.

Durum iki ayrı kalıcı volume'da tutulur: `ocx-state`,
`OPENCODEX_HOME=/home/bun/.opencodex` yoluna; `codex-state` ise
`CODEX_HOME=/home/bun/.codex` yoluna bağlanır. İki ürünün `auth.json` biçimleri
uyumsuzdur; bu dizinleri birleştirmeyin. Kök dosya sistemi salt okunur olsa da
bu iki volume yazılabilir durumda kalır.

Katalog otomatik oluşturulmaz. Kimlik doğrulamalı `/v1/catalog` kontrolünden önce
`/home/bun/.codex/opencodex-catalog.json` konumunda geçerli bir katalog oluşturun
veya içe aktarın. Boş dizinde 404 `catalog_not_found` beklenen sonuçtur. Güncelleme
mevcut `ocx-state` volume'unu korur ve `codex-state` ekler; dosyaları otomatik taşımaz.
Önceden `.opencodex` içine konmuş kataloğu yedekleyin ve yalnızca katalog dosyasını,
sadece sahibine erişim veren izinlerle taşıyın. Bir ürünün `auth.json` dosyasını
diğerininkiyle değiştirmeyin. `CODEX_HOME` özelleştirilirse bu dizinin tam yolunu
yazılabilir bir volume'a bağlayın ve varsayılan kataloğu
`${CODEX_HOME}/opencodex-catalog.json` konumuna koyun. `model_catalog_json` başka
bir dosya seçiyorsa çözümlenen yol da kalıcı olmalıdır. Açık bir taşıma tamamlanana
kadar mevcut özel ortam ve volume eşlemesini koruyun.
`docker compose down` iki volume'u da korur; `docker compose down --volumes` hem
`ocx-state` hem `codex-state` ile birlikte kimlik bilgilerini, kullanım geçmişini,
veri anahtarını ve Codex durumunu/kataloğunu siler. Güncelleme veya yeniden başlatma
yerine kullanılmamalıdır.

Resmî Docker imajı yoktur; ancak depo, digest ile sabitlenmiş Bun imajını yerelde oluşturmak için bakımı yapılan bir `Dockerfile` ve `compose.yaml` sağlar. İlk başlatmadan önce veri anahtarını stdin üzerinden bir kez başlatın; anahtar yazdırılmaz ve `ocx-state` volume içinde yalnızca sahibinin okuyabileceği izinlerle saklanır.

Host üzerinde Git ve Bun gereklidir. Her imaj derlemesinden önce Git tarafından izlenen kaynaklardan kanonik manifesti üretin ve derleme bitene kadar kaynakları değiştirmeyin. Üretilen JSON dosyasını Git'e eklemeyin; `.git` Docker bağlamının dışında kalır. Host portu varsayılan olarak `127.0.0.1` adresine bağlanır. Uzak erişim için açıkça `OPENCODEX_BIND_ADDRESS=<LAN-veya-Tailscale-IP> docker compose up -d` kullanın; `0.0.0.0` tüm arayüzleri açar. Erişimi güvenlik duvarı ve kimlik doğrulamalı TLS/tailnet ön ucu ile koruyun.

Derleme, her SHA-256 değerini önce bağlamdaki, ardından kopyalanan dosyalardaki baytlarla karşılaştırarak eski manifestleri reddeder. Eksik veya uyuşmayan dosyalar, fazladan kaynak dosyaları ve sembolik bağlantılar reddedilir. `package.json`, `bun.lock` ve `scripts/` içinden yalnızca dahil edilen `scripts/model-metadata.source.json` zorunludur.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

Konteyner root olmayan `bun` kullanıcısıyla, salt okunur kök dosya sistemiyle çalışır ve yalnızca `10100` portunu yayımlar. `10101` portunu yayımlamayın ve sırları `ARG`, `ENV`, `COPY`, Compose, imaj geçmişi veya argv içine koymayın. Healthcheck sonrasında readiness, kimlik doğrulamalı katalog ve gerçek yanıtı ayrıca doğrulayın. `docker compose down` volume'u korur; `docker compose down --volumes` yapılandırmayı, kimlik bilgilerini ve anahtarı da siler.

- Hub kapalıysa yerel geri dönüş yapılabilir; uzaktaki anahtarın iptali bekler.
- Geçici arızada doğrulanmış LKG korunur; auth, şema, boyut veya protokol hatasında yerel fallback yoktur.
- `.prev` kurtarmasında iki dosyayı koruyup geçici yetkiyle yeniden çalıştırın.
- `hub-too-new`/`hub-too-old` eski tarafı gösterir; yerel yazımdan önce reddedilir.
- Eşleştirme tek kullanımlıktır ve hatalar 429 ile sınırlanır; kayıp kodu yeniden üretin.
- Loopback dışı HTTP eşleştirmesi doğrudan reddedilir ve bunu devre dışı bırakan bir bayrak yoktur. Yönetim origin'ini HTTPS arkasına alın ya da loopback üzerinden eşleştirin; admin token HTTP ile gönderilmez.
- `/readyz` `200` dönerken `/v1/catalog` `403 origin_rejected` veriyorsa, veri dinleyicisi bir TLS ön ucunun arkasında loopback'e bağlıdır. Yukarıdaki "Veri dinleyicisine TLS vermek" bölümüne bakın.
- Tarayıcı logout/expiry veri anahtarını iptal etmez.
- `tailscale serve reset` tüm eşlemeleri kaldırır; önce durumu inceleyin.
